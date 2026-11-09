import fs from 'node:fs';
import path from 'node:path';
import { parseFile, selectCover } from 'music-metadata';
import { config, stationDir } from '../config.js';
import { all, get, run, type MediaRow } from '../db.js';
import type { NowPlaying } from './nowplaying.js';

const MAX_COVER = 4 * 1024 * 1024; // ignora capas gigantes
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
export const coverMime = (file: string) => ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[path.extname(file).slice(1)] ?? 'application/octet-stream';

export const coversDir = (stationId: number) => path.join(stationDir(stationId), 'covers');

/** Lê a capa embutida nas tags do arquivo (ID3/MP4/FLAC) e grava em disco; marca a música como verificada. */
export async function extractCover(m: Pick<MediaRow, 'id' | 'station_id' | 'path'>): Promise<boolean> {
  let saved = '';
  try {
    const meta = await parseFile(path.join(config.dataDir, m.path), { duration: false });
    const pic = selectCover(meta.common.picture);
    const ext = pic ? EXT[pic.format.toLowerCase()] : undefined;
    if (pic && ext && pic.data.length > 0 && pic.data.length <= MAX_COVER) {
      fs.mkdirSync(coversDir(m.station_id), { recursive: true });
      saved = `${m.id}.${ext}`;
      fs.writeFileSync(path.join(coversDir(m.station_id), saved), pic.data);
    }
  } catch {
    /* arquivo sem tags legíveis: fica sem capa */
  }
  run('UPDATE media SET cover = ?, cover_checked = 1 WHERE id = ?', saved || null, m.id);
  return !!saved;
}

/** Caminho do arquivo da capa de uma música (ou null). */
export function coverFile(stationId: number, mediaId: number): string | null {
  const row = get<{ cover: string | null }>('SELECT cover FROM media WHERE id = ? AND station_id = ?', mediaId, stationId);
  if (!row?.cover) return null;
  const abs = path.join(coversDir(stationId), row.cover);
  return fs.existsSync(abs) ? abs : null;
}

/** Link público (mesma origem) da capa, ou null se a música não tem. */
export const coverUrl = (slug: string, mediaId: number | null | undefined, cover: string | null | undefined) =>
  mediaId && cover ? `/api/public/stations/${slug}/cover/${mediaId}` : null;

/** No boot: extrai capas das músicas enviadas antes deste recurso, uma por vez e sem atrapalhar a rádio. */
export function backfillCovers() {
  const run1 = async () => {
    const pending = all<MediaRow>('SELECT * FROM media WHERE cover_checked = 0 ORDER BY id LIMIT 200');
    if (pending.length === 0) return;
    for (const m of pending) {
      await extractCover(m);
      await new Promise((r) => setTimeout(r, 25));
    }
    setTimeout(run1, 1000); // próximo lote
  };
  setTimeout(() => run1().catch((e) => console.error('[capas] falhou:', e)), 5000);
}

/** "Tocando agora" com o link da capa (se a música tiver). */
export function nowPlayingView(slug: string, np: NowPlaying | null) {
  if (!np) return null;
  const cover = np.mediaId ? get<{ cover: string | null }>('SELECT cover FROM media WHERE id = ?', np.mediaId)?.cover : null;
  return { ...np, coverUrl: coverUrl(slug, np.mediaId, cover) };
}

/** Histórico com o link da capa de cada faixa. */
export const historyView = <T extends { media_id: number | null; cover: string | null }>(slug: string, rows: T[]) =>
  rows.map((r) => ({ ...r, coverUrl: coverUrl(slug, r.media_id, r.cover) }));
