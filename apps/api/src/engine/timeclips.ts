import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { stationDir } from '../config.js';
import { all, get, run } from '../db.js';

/** Arquivos de áudio da "hora certa" enviados pelo usuário: um por horário (ex.: 14:00, 14:30). */
export interface ClipRow {
  id: number;
  station_id: number;
  hour: number;
  minute: number;
  file: string;
  original_name: string;
  duration: number;
  size: number;
}

export const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac']);
export const MAX_CLIP_BYTES = 10 * 1024 * 1024;
export const MAX_CLIP_SECONDS = 60;

export const clipsDir = (stationId: number) => path.join(stationDir(stationId), 'announce-files');
export const slotLabel = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/**
 * Descobre a hora (e minuto) pelo nome do arquivo. Aceita, por exemplo: 14.mp3, 07.wav, 14h.mp3, 14h30.mp3,
 * 14-30.mp3, 14_30.mp3, 1430.mp3, hora_14.mp3, hora-certa-14-30.mp3, meio-dia.mp3, meia-noite.mp3.
 */
export function parseSlot(filename: string): { hour: number; minute: number } | null {
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase();
  const groups = base.match(/\d+/g);
  if (!groups) {
    if (/meia[\s_-]?noite/.test(base)) return { hour: 0, minute: 0 };
    if (/meio[\s_-]?dia/.test(base)) return { hour: 12, minute: 0 };
    return null;
  }
  let hour: number;
  let minute = 0;
  if (groups.length === 1) {
    const g = groups[0];
    if (g.length <= 2) hour = Number(g);
    else if (g.length === 4) {
      hour = Number(g.slice(0, 2));
      minute = Number(g.slice(2));
    } else return null; // 3 dígitos é ambíguo
  } else if (groups.length === 2 && groups.every((g) => g.length <= 2)) {
    hour = Number(groups[0]);
    minute = Number(groups[1]);
  } else return null;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

export const listClips = (stationId: number) =>
  all<ClipRow>('SELECT * FROM time_clips WHERE station_id = ? ORDER BY hour, minute', stationId);

export const clipFor = (stationId: number, hour: number, minute: number) =>
  get<ClipRow>('SELECT * FROM time_clips WHERE station_id = ? AND hour = ? AND minute = ?', stationId, hour, minute);

export const clipPath = (c: Pick<ClipRow, 'station_id' | 'file'>) => path.join(clipsDir(c.station_id), c.file);

/** Confere o áudio (formato, tamanho e duração) e devolve a duração em segundos ou lança erro com o motivo. */
export async function verifyClip(file: string, originalName: string, size: number): Promise<number> {
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error(`formato não suportado (${ext || 'sem extensão'}); use MP3, WAV, OGG, FLAC, M4A ou AAC`);
  if (size > MAX_CLIP_BYTES) throw new Error('arquivo grande demais (máximo 10 MB)');
  let duration = 0;
  try {
    duration = (await parseFile(file, { duration: true })).format.duration ?? 0;
  } catch {
    throw new Error('não foi possível ler o áudio (arquivo corrompido ou formato inválido)');
  }
  if (!(duration > 0.3)) throw new Error('áudio vazio ou curto demais');
  if (duration > MAX_CLIP_SECONDS) throw new Error(`áudio longo demais para hora certa (${Math.round(duration)} s; máximo ${MAX_CLIP_SECONDS} s)`);
  return duration;
}

/** Guarda (ou substitui) o arquivo de um horário. `tmp` é o arquivo já enviado e verificado. */
export function saveClip(stationId: number, hour: number, minute: number, tmp: string, originalName: string, duration: number, size: number): { replaced: boolean } {
  fs.mkdirSync(clipsDir(stationId), { recursive: true });
  const prev = clipFor(stationId, hour, minute);
  const file = `${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}${path.extname(originalName).toLowerCase()}`;
  if (prev) fs.rmSync(clipPath(prev), { force: true });
  fs.renameSync(tmp, path.join(clipsDir(stationId), file));
  run(
    `INSERT INTO time_clips (station_id, hour, minute, file, original_name, duration, size) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(station_id, hour, minute) DO UPDATE SET file = excluded.file, original_name = excluded.original_name, duration = excluded.duration, size = excluded.size`,
    stationId,
    hour,
    minute,
    file,
    originalName.slice(0, 200),
    duration,
    size,
  );
  return { replaced: !!prev };
}

export function deleteClip(stationId: number, hour: number, minute: number): boolean {
  const c = clipFor(stationId, hour, minute);
  if (!c) return false;
  fs.rmSync(clipPath(c), { force: true });
  run('DELETE FROM time_clips WHERE id = ?', c.id);
  return true;
}
