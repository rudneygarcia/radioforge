import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { config } from '../config.js';
import { get, run, type MediaRow, type StationRow } from '../db.js';
import { extractCover } from './covers.js';
import { ensureStationDirs } from './manager.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.aac']);

/**
 * Coloca um arquivo de áudio já gravado em disco (tmpAbs) na biblioteca da estação: move para o nome interno (código),
 * lê as tags (título/artista/álbum/duração/capa) e cria o registro. Não mexe no motor da rádio.
 */
export async function importMediaFile(st: StationRow, tmpAbs: string, originalName: string, folderId: number | null): Promise<MediaRow> {
  ensureStationDirs(st.id);
  const ext = path.extname(originalName).toLowerCase();
  const rel = path.join('stations', String(st.id), 'media', `${crypto.randomUUID()}${ext}`);
  const abs = path.join(config.dataDir, rel);
  fs.renameSync(tmpAbs, abs);
  let title = path.basename(originalName, ext);
  let artist = '';
  let album = '';
  let duration = 0;
  try {
    const meta = await parseFile(abs, { duration: true });
    title = meta.common.title || title;
    artist = meta.common.artist ?? '';
    album = meta.common.album ?? '';
    duration = meta.format.duration ?? 0;
  } catch {
    // Sem tags legíveis: o nome do arquivo vira o título.
  }
  const r = run(
    `INSERT INTO media (station_id, path, original_name, title, artist, album, duration, size, folder_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    st.id,
    rel,
    originalName,
    title,
    artist,
    album,
    duration,
    fs.statSync(abs).size,
    folderId,
  );
  const row = get<MediaRow>('SELECT * FROM media WHERE id = ?', Number(r.lastInsertRowid))!;
  await extractCover(row);
  return get<MediaRow>('SELECT * FROM media WHERE id = ?', row.id)!;
}
