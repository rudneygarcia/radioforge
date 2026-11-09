import { all, get, run, type StationRow } from '../db.js';
import { dispatch } from './webhooks.js';

export interface NowPlaying {
  title: string;
  artist: string;
  playedAt: string;
  /** Música da biblioteca (para achar a capa); null quando não identificada. */
  mediaId: number | null;
}

const current = new Map<number, NowPlaying>();

export function recordTrack(stationId: number, artist: string, title: string, mediaId: number | null = null) {
  const last = getNowPlaying(stationId);
  if (last && last.artist === artist && last.title === title) return;
  run('INSERT INTO history (station_id, title, artist, media_id) VALUES (?, ?, ?, ?)', stationId, title, artist, mediaId);
  const playedAt = new Date().toISOString();
  current.set(stationId, { title, artist, playedAt, mediaId });
  dispatch(stationId, 'song_change', { artist, title, playedAt });
}

export function getNowPlaying(stationId: number): NowPlaying | null {
  const cached = current.get(stationId);
  if (cached) return cached;
  const row = get<{ title: string; artist: string; played_at: string; media_id: number | null }>(
    'SELECT title, artist, played_at, media_id FROM history WHERE station_id = ? ORDER BY id DESC LIMIT 1',
    stationId,
  );
  if (!row) return null;
  const np = { title: row.title, artist: row.artist, playedAt: row.played_at, mediaId: row.media_id };
  current.set(stationId, np);
  return np;
}

export interface LiveInfo {
  /** Nome do DJ (ou "Transmissão ao vivo" para o usuário "source"). */
  name: string;
  username: string;
  since: string;
}

// Quem está transmitindo ao vivo agora, por estação (só em memória: some ao reiniciar a estação).
const live = new Map<number, LiveInfo>();

/** Chamado pelo Liquidsoap quando um DJ conecta/desconecta no harbor. */
export function setLive(stationId: number, connected: boolean, username: string) {
  if (!connected) {
    live.delete(stationId);
    return;
  }
  const dj = get<{ display_name: string }>('SELECT display_name FROM station_djs WHERE station_id = ? AND username = ?', stationId, username);
  live.set(stationId, { name: dj?.display_name || (username === 'source' ? 'Transmissão ao vivo' : username), username, since: new Date().toISOString() });
}

export const getLive = (stationId: number): LiveInfo | null => live.get(stationId) ?? null;
export const clearLive = (stationId: number) => void live.delete(stationId);

export function getHistory(stationId: number, limit = 20) {
  return all<{ title: string; artist: string; played_at: string; media_id: number | null; cover: string | null }>(
    `SELECT h.title, h.artist, h.played_at, h.media_id, m.cover FROM history h LEFT JOIN media m ON m.id = h.media_id
     WHERE h.station_id = ? ORDER BY h.id DESC LIMIT ?`,
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
