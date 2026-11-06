import fs from 'node:fs';
import path from 'node:path';
import { stationDir } from '../config.js';
import { all, db, get, mountsFor, run, type StationRow } from '../db.js';
import { getListeners } from './nowplaying.js';
import { isRunning } from './manager.js';
import { recordSession, sqlTime } from './sessions.js';

export interface ParsedSession {
  ip: string;
  endedAt: Date;
  path: string;
  status: number;
  userAgent: string;
  duration: number;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// ip - - [06/Nov/2026:20:05:15 +0000] "GET /radio HTTP/1.1" 200 12345 "referer" "user-agent" 321
const LINE = /^(\S+) \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "(?:GET|HEAD) (\S+)[^"]*" (\d{3}) \d+ "[^"]*" "([^"]*)" (\d+)\s*$/;

/** Lê uma linha do access.log do Icecast (formato combinado + duração em segundos). */
export function parseAccessLine(line: string): ParsedSession | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const month = MONTHS[m[3]];
  if (month === undefined) return null;
  const tz = m[8];
  const offsetMin = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const utc = Date.UTC(Number(m[4]), month, Number(m[2]), Number(m[5]), Number(m[6]), Number(m[7])) - offsetMin * 60_000;
  return { ip: m[1], endedAt: new Date(utc), path: m[9], status: Number(m[10]), userAgent: m[11], duration: Number(m[12]) };
}

/** Importa do access.log as conexões novas desde a última leitura. */
export function ingestAccessLog(st: StationRow) {
  const file = path.join(stationDir(st.id), 'logs', 'access.log');
  if (!fs.existsSync(file)) return 0;
  const size = fs.statSync(file).size;
  let offset = get<{ offset: number }>('SELECT offset FROM station_log_state WHERE station_id = ?', st.id)?.offset ?? 0;
  if (size < offset) offset = 0; // log rotacionado pelo Icecast
  if (size === offset) return 0;

  const length = Math.min(size - offset, 5 * 1024 * 1024);
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  // Só consome até a última quebra de linha completa.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return 0;
  const text = buf.subarray(0, lastNl + 1).toString('utf8');

  const mounts = new Set([st.mount, ...mountsFor(st.id).map((m) => m.mount)]);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const line of text.split('\n')) {
      const s = parseAccessLine(line);
      // Ignora requisições que não são de ouvintes reais (status.xsl, probes de segundos, erros).
      if (!s || s.duration < 5 || (s.status !== 200 && s.status !== 206)) continue;
      if (!mounts.has(s.path.split('?')[0])) continue;
      recordSession(st.id, s.ip, s.userAgent, s.path.split('?')[0], new Date(s.endedAt.getTime() - s.duration * 1000), s.duration);
      inserted++;
    }
    run(
      'INSERT INTO station_log_state (station_id, offset) VALUES (?, ?) ON CONFLICT(station_id) DO UPDATE SET offset = excluded.offset',
      st.id,
      offset + lastNl + 1,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

async function sampleStation(st: StationRow) {
  const listeners = await getListeners(st);
  const at = sqlTime(new Date()).slice(0, 16) + ':00';
  run('INSERT OR REPLACE INTO listener_samples (station_id, at, listeners) VALUES (?, ?, ?)', st.id, at, listeners);
}

async function tick() {
  for (const st of all<StationRow>('SELECT * FROM stations')) {
    try {
      if (isRunning(st.id)) await sampleStation(st);
      ingestAccessLog(st);
    } catch (e) {
      console.error(`[stats] ${st.slug}:`, e);
    }
  }
}

function purge() {
  run("DELETE FROM listener_samples WHERE at < datetime('now', '-90 days')");
  run("DELETE FROM listener_sessions WHERE started_at < datetime('now', '-365 days')");
}

/** Coleta 1 amostra de ouvintes por minuto e importa o access.log; limpa dados antigos de hora em hora. */
export function startStatsCollector() {
  setInterval(() => void tick(), 60_000).unref();
  setInterval(purge, 3_600_000).unref();
  purge();
}
