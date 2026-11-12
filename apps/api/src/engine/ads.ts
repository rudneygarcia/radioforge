import path from 'node:path';
import { config } from '../config.js';
import { all, get, run, type MediaRow, type StationRow } from '../db.js';
import { localTime } from './announce.js';
import { isRunning, pushRequest } from './manager.js';
import { getLive } from './nowplaying.js';

/**
 * Blocos comerciais: grupos de comerciais (arquivos de uma pasta da Biblioteca) que entram nos horários programados.
 * No horário, o bloco é colocado na fila do AutoDJ (toca ao fim da música atual, na ordem) e cada comercial fica
 * registrado em "ad_plays" (comprovante de veiculação para o anunciante).
 */
export interface AdBlockRow {
  id: number;
  station_id: number;
  name: string;
  folder_id: number | null;
  times: string;
  days: string;
  mode: 'sequential' | 'shuffle';
  items: number;
  enabled: number;
  last_fired: string;
  cursor: number;
}

export const adMedia = (b: Pick<AdBlockRow, 'station_id' | 'folder_id'>): MediaRow[] =>
  b.folder_id ? all<MediaRow>('SELECT * FROM media WHERE station_id = ? AND folder_id = ? ORDER BY id', b.station_id, b.folder_id) : [];

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const weekdayIn = (tz: string, at: Date) => WEEKDAY[new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(at)] ?? 0;

const firing = new Set<number>();

/** Coloca o bloco na fila do AutoDJ agora. Devolve quantos comerciais foram enfileirados. */
export async function fireBlock(st: StationRow, b: AdBlockRow, reason: 'horario' | 'manual' = 'horario'): Promise<number> {
  if (firing.has(b.id)) return 0;
  firing.add(b.id);
  try {
    const media = adMedia(b);
    if (media.length === 0) return 0;
    const n = b.items > 0 ? Math.min(b.items, media.length) : media.length;
    let chosen: MediaRow[];
    if (b.mode === 'sequential') {
      chosen = Array.from({ length: n }, (_, i) => media[(b.cursor + i) % media.length]);
      run('UPDATE ad_blocks SET cursor = ? WHERE id = ?', (b.cursor + n) % media.length, b.id);
    } else {
      chosen = [...media].sort(() => Math.random() - 0.5).slice(0, n);
    }
    let count = 0;
    for (const m of chosen) {
      // O registro nasce antes do envio: o id vai junto na faixa e o Liquidsoap confirma quando ela começa a tocar.
      const r = run('INSERT INTO ad_plays (station_id, block_id, block_name, media_id, title, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)', st.id, b.id, b.name, m.id, m.title || m.original_name, 'ok', reason === 'manual' ? 'disparo manual' : '');
      const playId = Number(r.lastInsertRowid);
      try {
        await pushRequest(st.id, path.join(config.dataDir, m.path), true, m.duration, false, playId);
        count++;
      } catch (e) {
        run("UPDATE ad_plays SET status = 'erro', note = ? WHERE id = ?", (e as Error).message.slice(0, 200), playId);
      }
    }
    return count;
  } finally {
    firing.delete(b.id);
  }
}

/** A cada 30 s: dispara os blocos cujo horário (no fuso da estação) chegou. */
export function tickAdBlocks(now = new Date()) {
  const blocks = all<AdBlockRow & { tz: string }>(
    `SELECT b.*, s.timezone AS tz FROM ad_blocks b JOIN stations s ON s.id = b.station_id WHERE b.enabled = 1 AND s.autodj = 1`,
  );
  for (const b of blocks) {
    const t = localTime(b.tz, now);
    const hhmm = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    if (!b.times.split(',').includes(hhmm) || b.last_fired === t.key) continue;
    if (!b.days.split(',').filter(Boolean).map(Number).includes(weekdayIn(b.tz, now))) continue;
    run('UPDATE ad_blocks SET last_fired = ? WHERE id = ?', t.key, b.id); // marca antes: um horário só dispara uma vez
    const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', b.station_id);
    if (!st || !isRunning(st.id)) continue;
    if (getLive(st.id)) {
      run("INSERT INTO ad_plays (station_id, block_id, block_name, media_id, title, status, note) VALUES (?, ?, ?, NULL, '', 'pulado', 'DJ ao vivo no horário do bloco')", st.id, b.id, b.name);
      continue;
    }
    void fireBlock(st, b).catch((e) => console.error(`[comerciais] ${st.slug}/${b.name}:`, (e as Error).message));
  }
}
