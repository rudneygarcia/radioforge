import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.js';
import { config } from '../config.js';
import { all, get, type StationRow } from '../db.js';
import { nowPlayingView, stationCoverUrl } from '../engine/covers.js';
import { isRunning } from '../engine/manager.js';
import { getHistory, getListeners, getLive, getNowPlaying } from '../engine/nowplaying.js';
import { streamsOf } from './stations.js';

/**
 * Compatibilidade com a API pública do AzuraCast, para sites, apps e widgets que já usavam a rádio no AzuraCast
 * continuarem funcionando depois da migração: /api/nowplaying, /api/nowplaying/<estação>, /api/station/<estação>,
 * /api/nowplaying_static/<estação>.json, /public/<estação> e as playlists .pls/.m3u.
 * A estação pode ser pedida pelo endereço curto ("shortcode") ou pelo número.
 */
const origin = () => config.publicOrigin;
const abs = (u: string | null | undefined) => (u ? (/^https?:\/\//.test(u) ? u : `${origin()}${u}`) : '');
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
const unix = (s: string | null | undefined) => {
  if (!s) return 0;
  const t = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

function findStation(key: string): StationRow {
  const st = /^\d+$/.test(key)
    ? get<StationRow>('SELECT * FROM stations WHERE id = ?', Number(key))
    : get<StationRow>('SELECT * FROM stations WHERE lower(slug) = lower(?)', key);
  if (!st) throw new HttpError(404, 'Estação não encontrada');
  return st;
}

const durationOf = (mediaId: number | null) => (mediaId ? Math.round(get<{ duration: number }>('SELECT duration FROM media WHERE id = ?', mediaId)?.duration ?? 0) : 0);

function song(st: StationRow, artist: string, title: string, mediaId: number | null, coverUrl?: string | null) {
  return {
    id: md5(`${artist}${title}`),
    text: artist ? `${artist} - ${title}` : title,
    artist,
    title,
    album: '',
    genre: '',
    lyrics: '',
    art: abs(coverUrl ?? stationCoverUrl(st)) || `${origin()}/favicon.svg`,
    custom_fields: [],
  };
}

function station(st: StationRow) {
  const streams = streamsOf(st);
  const player = `${origin()}/listen/${st.slug}`;
  return {
    id: st.id,
    name: st.name,
    shortcode: st.slug,
    description: st.description,
    frontend: 'icecast',
    backend: st.autodj ? 'liquidsoap' : 'none',
    timezone: st.timezone,
    listen_url: streams[0].proxyUrl,
    url: '',
    public_player_url: player,
    playlist_pls_url: `${origin()}/public/${st.slug}/playlist.pls`,
    playlist_m3u_url: `${origin()}/public/${st.slug}/playlist.m3u`,
    is_public: true,
    mounts: streams.map((s, i) => ({
      id: i + 1,
      name: `${s.mount} (${s.bitrate}kbps ${s.format.toUpperCase()})`,
      url: s.proxyUrl,
      bitrate: s.bitrate,
      format: s.format,
      listeners: { total: 0, unique: 0, current: 0 },
      path: s.mount,
      is_default: i === 0,
    })),
    remotes: [],
    hls_enabled: false,
    hls_is_default: false,
    hls_url: null,
    hls_listeners: 0,
  };
}

async function nowPlaying(st: StationRow) {
  const np = nowPlayingView(st, getNowPlaying(st.id));
  const listeners = await getListeners(st);
  const live = getLive(st.id);
  const st2 = station(st);
  st2.mounts[0].listeners = { total: listeners, unique: listeners, current: listeners };
  const now = Math.floor(Date.now() / 1000);
  const playedAt = unix(np?.playedAt);
  const duration = durationOf(np?.mediaId ?? null);
  const elapsed = np && playedAt ? Math.max(0, now - playedAt) : 0;
  const history = getHistory(st.id, Math.min(15, Math.max(1, st.history_limit)));
  return {
    station: st2,
    listeners: { total: listeners, unique: listeners, current: listeners },
    live: { is_live: !!live, streamer_name: live?.name ?? '', broadcast_start: live ? unix(live.since) : null, art: null },
    now_playing: {
      sh_id: playedAt || 0,
      played_at: playedAt,
      duration,
      playlist: '',
      streamer: live?.name ?? '',
      is_request: false,
      song: np ? song(st, np.artist, np.title, np.mediaId, np.coverUrl) : song(st, '', '', null),
      elapsed: duration ? Math.min(elapsed, duration) : elapsed,
      remaining: duration ? Math.max(0, duration - elapsed) : 0,
    },
    playing_next: {
      sh_id: 0,
      played_at: 0,
      duration: 0,
      playlist: '',
      is_request: false,
      song: song(st, '', '', null),
    },
    song_history: history.map((h) => ({
      sh_id: unix(h.played_at),
      played_at: unix(h.played_at),
      duration: durationOf(h.media_id),
      playlist: '',
      streamer: '',
      is_request: false,
      song: song(st, h.artist, h.title, h.media_id, h.media_id ? `/api/public/stations/${st.slug}/cover/${h.media_id}` : null),
    })),
    is_online: isRunning(st.id) && (!!st.autodj || !!live),
    cache: 'database',
  };
}

export async function azuraCompatRoutes(app: FastifyInstance) {
  const key = z.object({ station: z.string().max(80) });

  app.get('/api/nowplaying', async () => Promise.all(all<StationRow>('SELECT * FROM stations ORDER BY name').map(nowPlaying)));

  app.get('/api/nowplaying/:station', async (req) => nowPlaying(findStation(key.parse(req.params).station)));

  // Arquivo estático do AzuraCast: /api/nowplaying_static/<estação>.json
  app.get('/api/nowplaying_static/:file', async (req) => {
    const { file } = z.object({ file: z.string().max(90) }).parse(req.params);
    return nowPlaying(findStation(file.replace(/\.json$/i, '')));
  });

  app.get('/api/station/:station', async (req) => station(findStation(key.parse(req.params).station)));

  // Página pública do AzuraCast (/public/<estação>) -> player desta rádio.
  app.get('/public/:station', async (req, reply) => {
    const st = findStation(key.parse(req.params).station);
    return reply.redirect(`/listen/${st.slug}`);
  });

  // Playlists para abrir o stream em players (VLC, Winamp...).
  app.get('/public/:station/playlist.pls', async (req, reply) => {
    const st = findStation(key.parse(req.params).station);
    const streams = streamsOf(st);
    const body = ['[playlist]', `NumberOfEntries=${streams.length}`, ...streams.flatMap((s, i) => [`File${i + 1}=${s.proxyUrl}`, `Title${i + 1}=${st.name} - ${s.bitrate}kbps ${s.format.toUpperCase()}`, `Length${i + 1}=-1`]), 'Version=2', ''].join('\n');
    return reply.header('Content-Type', 'audio/x-scpls').header('Content-Disposition', `attachment; filename="${st.slug}.pls"`).send(body);
  });
  app.get('/public/:station/playlist.m3u', async (req, reply) => {
    const st = findStation(key.parse(req.params).station);
    const body = ['#EXTM3U', ...streamsOf(st).flatMap((s) => [`#EXTINF:-1,${st.name} - ${s.bitrate}kbps ${s.format.toUpperCase()}`, s.proxyUrl]), ''].join('\n');
    return reply.header('Content-Type', 'audio/x-mpegurl').header('Content-Disposition', `attachment; filename="${st.slug}.m3u"`).send(body);
  });
}
