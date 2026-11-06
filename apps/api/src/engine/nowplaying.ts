import { all, get, run, type StationRow } from '../db.js';
import { dispatch } from './webhooks.js';

export interface NowPlaying {
  title: string;
  artist: string;
  playedAt: string;
}

const current = new Map<number, NowPlaying>();

export function recordTrack(stationId: number, artist: string, title: string) {
  const last = getNowPlaying(stationId);
  if (last && last.artist === artist && last.title === title) return;
  run('INSERT INTO history (station_id, title, artist) VALUES (?, ?, ?)', stationId, title, artist);
  const playedAt = new Date().toISOString();
  current.set(stationId, { title, artist, playedAt });
  dispatch(stationId, 'song_change', { artist, title, playedAt });
}

export function getNowPlaying(stationId: number): NowPlaying | null {
  const cached = current.get(stationId);
  if (cached) return cached;
  const row = get<{ title: string; artist: string; played_at: string }>(
    'SELECT title, artist, played_at FROM history WHERE station_id = ? ORDER BY id DESC LIMIT 1',
    stationId,
  );
  if (!row) return null;
  const np = { title: row.title, artist: row.artist, playedAt: row.played_at };
  current.set(stationId, np);
  return np;
}

export function getHistory(stationId: number, limit = 20) {
  return all<{ title: string; artist: string; played_at: string }>(
    'SELECT title, artist, played_at FROM history WHERE station_id = ? ORDER BY id DESC LIMIT ?',
    stationId,
    limit,
  );
}

const listenerCache = new Map<number, { at: number; value: number }>();

// O motor simples (Node) registra aqui a contagem própria de ouvintes, sem depender do Icecast.
let nativeCounter: ((stationId: number) => number | null) | null = null;
export function setNativeListenerCounter(fn: (stationId: number) => number | null) {
  nativeCounter = fn;
}

/** Ouvintes atuais: do motor simples, se ele estiver servindo a estação, senão do status do Icecast (cache de 5s). */
export async function getListeners(st: StationRow): Promise<number> {
  const own = nativeCounter?.(st.id);
  if (own !== null && own !== undefined) return own;
  const hit = listenerCache.get(st.id);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  let value = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${st.stream_port}/status-json.xsl`, {
      signal: AbortSignal.timeout(1500),
    });
    const json = (await res.json()) as { icestats?: { source?: unknown } };
    const src = json.icestats?.source;
    const list = Array.isArray(src) ? src : src ? [src] : [];
    value = list.reduce((sum: number, s: { listeners?: number }) => sum + (s.listeners ?? 0), 0);
  } catch {
    value = 0;
  }
  listenerCache.set(st.id, { at: Date.now(), value });
  return value;
}
