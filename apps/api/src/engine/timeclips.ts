import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { stationDir } from '../config.js';
import { all, get, run } from '../db.js';

/**
 * Arquivos de áudio da "hora certa" enviados pelo usuário. Cada arquivo fala UM horário exato (ex.: 14:02) e
 * pertence a uma "voz" (masculino, feminino, mix…): o conjunto completo de uma voz tem 1440 arquivos (um por minuto).
 */
export interface ClipRow {
  id: number;
  station_id: number;
  voice: string;
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
export const DEFAULT_VOICE = 'padrao';

export const clipsDir = (stationId: number) => path.join(stationDir(stationId), 'announce-files');
export const slotLabel = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** Nome de voz seguro para usar em arquivo/URL (minúsculas, sem acento, letras/números/hífen). */
export function slugVoice(raw: string): string {
  const s = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return s || DEFAULT_VOICE;
}

/**
 * Descobre voz, hora e minuto pelo nome do arquivo. Exemplos aceitos:
 *   masculino_00_02.mp3 (voz masculino, 00:02) · feminino_14_30.mp3 · mix_07_05.mp3
 *   14.mp3 · 14h30.mp3 · 14-30.mp3 · 1430.mp3 · hora_14.mp3 · meio-dia.mp3 · meia-noite.mp3 (voz "padrao")
 */
export function parseSlot(filename: string): { voice: string; hour: number; minute: number } | null {
  const base = path.basename(filename).replace(/\.[^.]+$/, '').toLowerCase();
  const groups = base.match(/\d+/g);
  if (!groups) {
    if (/meia[\s_-]?noite/.test(base)) return { voice: DEFAULT_VOICE, hour: 0, minute: 0 };
    if (/meio[\s_-]?dia/.test(base)) return { voice: DEFAULT_VOICE, hour: 12, minute: 0 };
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
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return null;
  // O que vem antes do primeiro número é o nome da voz (palavras genéricas como "hora" não contam).
  const prefix = (/^[^\d]*/.exec(base)?.[0] ?? '')
    .replace(/[_\-.]+/g, ' ') // "_" conta como letra no \b, então vira espaço antes de tirar as palavras genéricas
    .replace(/\b(hora|horas|certa|audio|arquivo|clip|som)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  return { voice: prefix.length >= 2 ? slugVoice(prefix) : DEFAULT_VOICE, hour, minute };
}

export const listClips = (stationId: number, voice?: string) =>
  voice
    ? all<ClipRow>('SELECT * FROM time_clips WHERE station_id = ? AND voice = ? ORDER BY hour, minute', stationId, voice)
    : all<ClipRow>('SELECT * FROM time_clips WHERE station_id = ? ORDER BY voice, hour, minute', stationId);

/** Vozes enviadas e quantos horários cada uma cobre (o conjunto completo tem 1440). */
export const voicesOf = (stationId: number) =>
  all<{ voice: string; count: number }>('SELECT voice, COUNT(*) AS count FROM time_clips WHERE station_id = ? GROUP BY voice ORDER BY count DESC, voice', stationId);

export const clipFor = (stationId: number, voice: string, hour: number, minute: number) =>
  get<ClipRow>('SELECT * FROM time_clips WHERE station_id = ? AND voice = ? AND hour = ? AND minute = ?', stationId, voice, hour, minute);

/** Qualquer voz que tenha o horário (usada quando a voz escolhida não tem aquele minuto). */
export const anyClipFor = (stationId: number, hour: number, minute: number) =>
  get<ClipRow>('SELECT * FROM time_clips WHERE station_id = ? AND hour = ? AND minute = ? ORDER BY voice LIMIT 1', stationId, hour, minute);

export const clipPath = (c: Pick<ClipRow, 'station_id' | 'file'>) => path.join(clipsDir(c.station_id), c.file);

/** Voz em uso: a escolhida na estação, ou a mais completa se nada foi escolhido. */
export function activeVoice(stationId: number, chosen: string): string | null {
  const voices = voicesOf(stationId);
  if (chosen && voices.some((v) => v.voice === chosen)) return chosen;
  return voices[0]?.voice ?? null;
}

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

/** Guarda (ou substitui) o arquivo de um horário de uma voz. `tmp` é o arquivo já enviado e verificado. */
export function saveClip(stationId: number, voice: string, hour: number, minute: number, tmp: string, originalName: string, duration: number, size: number): { replaced: boolean } {
  fs.mkdirSync(clipsDir(stationId), { recursive: true });
  const prev = clipFor(stationId, voice, hour, minute);
  const file = `${voice}_${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}${path.extname(originalName).toLowerCase()}`;
  if (prev) fs.rmSync(clipPath(prev), { force: true });
  fs.renameSync(tmp, path.join(clipsDir(stationId), file));
  run(
    `INSERT INTO time_clips (station_id, voice, hour, minute, file, original_name, duration, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(station_id, voice, hour, minute) DO UPDATE SET file = excluded.file, original_name = excluded.original_name, duration = excluded.duration, size = excluded.size`,
    stationId,
    voice,
    hour,
    minute,
    file,
    originalName.slice(0, 200),
    duration,
    size,
  );
  return { replaced: !!prev };
}

export function deleteClip(stationId: number, voice: string, hour: number, minute: number): boolean {
  const c = clipFor(stationId, voice, hour, minute);
  if (!c) return false;
  fs.rmSync(clipPath(c), { force: true });
  run('DELETE FROM time_clips WHERE id = ?', c.id);
  return true;
}

/** Apaga todos os arquivos de uma voz. Devolve quantos eram. */
export function deleteVoice(stationId: number, voice: string): number {
  const rows = listClips(stationId, voice);
  for (const c of rows) fs.rmSync(clipPath(c), { force: true });
  run('DELETE FROM time_clips WHERE station_id = ? AND voice = ?', stationId, voice);
  return rows.length;
}
