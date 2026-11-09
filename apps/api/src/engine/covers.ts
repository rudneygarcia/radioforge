import fs from 'node:fs';
import path from 'node:path';
import { parseFile, selectCover } from 'music-metadata';
import { config, stationDir } from '../config.js';
import { all, get, run, type MediaRow, type StationRow } from '../db.js';
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

/** "Tocando agora" com o link da capa; sem capa na música, entra a capa da rádio (se houver). */
export function nowPlayingView(st: StationRow, np: NowPlaying | null) {
  if (!np) return null;
  const cover = np.mediaId ? get<{ cover: string | null }>('SELECT cover FROM media WHERE id = ?', np.mediaId)?.cover : null;
  return { ...np, coverUrl: coverUrl(st.slug, np.mediaId, cover) ?? stationCoverUrl(st) };
}

/** Histórico com o link da capa de cada faixa (a capa da rádio no lugar das que não têm). */
export const historyView = <T extends { media_id: number | null; cover: string | null }>(st: StationRow, rows: T[]) =>
  rows.map((r) => ({ ...r, coverUrl: coverUrl(st.slug, r.media_id, r.cover) ?? stationCoverUrl(st) }));

// ---------- Capa (logo) da rádio ----------
export const stationCoverPath = (st: Pick<StationRow, 'id' | 'cover'>) => (st.cover ? path.join(stationDir(st.id), st.cover) : null);

/** Link público da capa da rádio (com versão para o navegador atualizar ao trocar). */
export function stationCoverUrl(st: Pick<StationRow, 'id' | 'slug' | 'cover'>): string | null {
  const file = stationCoverPath(st);
  if (!file) return null;
  try {
    return `/api/public/stations/${st.slug}/station-cover?v=${Math.floor(fs.statSync(file).mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Descobre o tipo da imagem pelos primeiros bytes (não confia na extensão enviada). */
export function sniffImage(b: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function removeStationCover(st: Pick<StationRow, 'id' | 'cover'>) {
  const file = stationCoverPath(st);
  if (file) fs.rmSync(file, { force: true });
  run('UPDATE stations SET cover = NULL WHERE id = ?', st.id);
}

export function saveStationCover(st: Pick<StationRow, 'id' | 'cover'>, data: Buffer, ext: string) {
  removeStationCover(st);
  fs.mkdirSync(stationDir(st.id), { recursive: true });
  const name = `station-cover.${ext}`;
  fs.writeFileSync(path.join(stationDir(st.id), name), data);
  run('UPDATE stations SET cover = ? WHERE id = ?', name, st.id);
}
