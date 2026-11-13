import path from 'node:path';
import { config } from '../config.js';
import { all, get, playlistMedia, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { isHiddenTrack } from './hide.js';
import { markAsk } from './dynstate.js';
import { cueFor } from './cuecache.js';
import { hiddenUri, jingleUri, songUri } from './manager.js';

/**
 * Escolha da próxima música feita pelo painel (o Liquidsoap pergunta por HTTP a cada faixa): assim as regras de
 * "não repetir música" e "não repetir artista" valem de verdade — inclusive para faixas já preparadas à frente,
 * faixas ocultas e pedidos — e as playlists não precisam ser regravadas (o que recarregava o Liquidsoap a cada música).
 */
interface PickRec {
  id: number;
  artist: string;
  at: number;
}
const picks = new Map<number, PickRec[]>();
const seqIndex = new Map<number, number>();

/** Chave de comparação do artista: sem acento/maiúsculas e só o principal ("A / B", "A feat. B", "A part. B" contam como A). */
export function artistKey(raw: string): string {
  const n = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return n.split(/\s+\/\s+|\s+(?:feat\.?|ft\.?|part\.?|participacao|com)\s+|\s+&\s+/)[0].replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function notePick(stationId: number, m: Pick<MediaRow, 'id' | 'artist'>) {
  const list = picks.get(stationId) ?? [];
  list.push({ id: m.id, artist: artistKey(m.artist), at: Date.now() });
  const cut = Date.now() - 24 * 3600_000;
  picks.set(stationId, list.filter((p) => p.at >= cut).slice(-300));
}

function recentSets(st: StationRow) {
  const songMs = st.no_repeat_minutes * 60_000;
  const artMs = st.no_repeat_artist_minutes * 60_000;
  const now = Date.now();
  const songs = new Set<number>();
  const artists = new Set<string>();
  let last: number | null = null;
  const list = picks.get(st.id) ?? [];
  for (const p of list) {
    if (songMs > 0 && now - p.at < songMs) songs.add(p.id);
    if (artMs > 0 && p.artist && now - p.at < artMs) artists.add(p.artist);
  }
  last = list.length ? list[list.length - 1].id : null;
  // Também o que o histórico registrou (tocou antes de o painel reiniciar, pedidos, hora certa etc.).
  const maxMin = Math.max(st.no_repeat_minutes, st.no_repeat_artist_minutes);
  if (maxMin > 0) {
    const rows = all<{ media_id: number | null; artist: string; age: number }>(
      `SELECT media_id, artist, (strftime('%s','now') - strftime('%s', played_at)) AS age FROM history WHERE station_id = ? AND played_at >= datetime('now', ?)`,
      st.id,
      `-${Math.floor(maxMin)} minutes`,
    );
    for (const r of rows) {
      if (r.media_id !== null && songMs > 0 && r.age * 1000 < songMs) songs.add(r.media_id);
      const k = artistKey(r.artist);
      if (k && artMs > 0 && r.age * 1000 < artMs) artists.add(k);
    }
  }
  return { songs, artists, last };
}

/** Próxima faixa de uma playlist, respeitando as regras de repetição (relaxa o artista e depois a música antes de ficar sem faixa). */
export function pickMedia(st: StationRow, p: PlaylistRow): MediaRow | null {
  const media = playlistMedia(p.id);
  if (media.length === 0) return null;
  const { songs, artists, last } = p.is_jingle ? { songs: new Set<number>(), artists: new Set<string>(), last: null } : recentSets(st);
  const lastPick = (picks.get(st.id) ?? []).slice(-1)[0]?.id ?? last;
  const tiers: ((m: MediaRow) => boolean)[] = p.is_jingle
    ? [() => true]
    : [
        (m) => !songs.has(m.id) && !artists.has(artistKey(m.artist)),
        (m) => !songs.has(m.id),
        (m) => m.id !== lastPick || media.length === 1,
        () => true,
      ];
  let chosen: MediaRow | undefined;
  if (p.mode === 'sequential') {
    const start = seqIndex.get(p.id) ?? 0;
    for (const ok of tiers) {
      for (let k = 0; k < media.length && !chosen; k++) {
        const i = (start + k) % media.length;
        if (ok(media[i])) {
          chosen = media[i];
          seqIndex.set(p.id, (i + 1) % media.length);
        }
      }
      if (chosen) break;
    }
  } else {
    for (const ok of tiers) {
      const cand = media.filter(ok);
      if (cand.length) {
        chosen = cand[Math.floor(Math.random() * cand.length)];
        break;
      }
    }
  }
  return chosen ?? media[0];
}

/** URI que o Liquidsoap vai tocar (com o annotate de vinheta/oculta quando for o caso). */
export function nextUri(st: StationRow, playlistId: number): string | null {
  markAsk(st.id);
  const p = get<PlaylistRow>('SELECT * FROM playlists WHERE id = ? AND station_id = ?', playlistId, st.id);
  if (!p || !p.enabled) return null;
  const m = pickMedia(st, p);
  if (!m) return null;
  notePick(st.id, m);
  const abs = path.join(config.dataDir, m.path);
  if (isHiddenTrack(st, m)) return hiddenUri(abs);
  return p.is_jingle ? jingleUri(st, abs, m.duration) : songUri(abs, m.title, m.artist, cueFor(st, m.id));
}
