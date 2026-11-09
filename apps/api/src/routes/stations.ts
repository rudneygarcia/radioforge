import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin, stationFor } from '../auth.js';
import { config, stationDir } from '../config.js';
import { all, db, get, mountsFor, run, type StationRow } from '../db.js';
import { historyView, nowPlayingView, removeStationCover, saveStationCover, sniffImage, stationCoverUrl } from '../engine/covers.js';
import { announceNow, isValidTimezone, localTime, resolveClip } from '../engine/announce.js';
import { audioWarningFor, kickLive, engineMode, ensureStationDirs, isRunning, restartStation, startStation, stopStation } from '../engine/manager.js';
import { harborPort } from '../engine/liquidsoap.js';
import { icecastError, liveListeners } from '../engine/listeners.js';
import { clearLive, getHistory, getListeners, getLive, getNowPlaying } from '../engine/nowplaying.js';

const idParam = z.object({ id: z.coerce.number().int() });

/** Nome do mountpoint (parte final da URL do stream): aceita com ou sem a barra inicial. */
const RESERVED_MOUNTS = new Set(['/live', '/admin', '/status.xsl', '/status-json.xsl', '/server_version.xsl']);
const mountName = z
  .string()
  .trim()
  .transform((v) => (v.startsWith('/') ? v : '/' + v))
  .pipe(
    z
      .string()
      .regex(/^\/[a-zA-Z0-9._-]{1,40}$/,'Nome do stream inválido: use letras, números, ponto, hífen ou sublinhado (ex.: radio.mp3)')
      .refine((v) => !RESERVED_MOUNTS.has(v.toLowerCase()), 'Esse nome é reservado pelo servidor'),
  );

const settings = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  format: z.enum(['mp3', 'ogg', 'aac']).default('mp3'),
  bitrate: z.number().int().min(32).max(320).default(128),
  liveEnabled: z.boolean().default(true),
  requestsEnabled: z.boolean().default(true),
  autostart: z.boolean().default(true),
  crossfadeSeconds: z.number().min(0).max(10).default(0),
  normalize: z.boolean().default(false),
  recordLive: z.boolean().default(false),
  /** Quantas músicas recentes o player público mostra. */
  historyLimit: z.number().int().min(1).max(50).default(5),
  /** Processador de áudio (Liquidsoap): off | balanced | loud. */
  audioPreset: z.enum(['off', 'balanced', 'loud']).default('balanced'),
  /** Ganho extra em dB (antes do limitador, que evita distorção). */
  audioGain: z.number().min(0).max(12).default(0),
  /** Não repetir a mesma música por N minutos (0 = desligado). */
  noRepeatMinutes: z.number().int().min(0).max(1440).default(60),
  /** Segundos sem áudio do encoder até o AutoDJ voltar (3 a 60). */
  liveTimeout: z.number().int().min(3).max(60).default(8),
  /** Ao voltar do ao vivo, o AutoDJ continua a música em andamento (em vez de começar outra). */
  liveContinue: z.boolean().default(true),
  /** Hora certa: 0 desligada, ou avisa a hora a cada 15, 30 ou 60 minutos. */
  /** Sem arquivo enviado para o horário, usa a voz sintética (senão, não avisa). */
  timeAnnounceVoice: z.boolean().default(true),
  timeAnnounce: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]).default(0),
  /** Fuso horário (IANA) usado na hora certa e nos horários da estação. */
  timezone: z.string().max(64).refine(isValidTimezone, 'Fuso horário inválido').default('America/Sao_Paulo'),
  /** Mountpoint principal. Na criação, o padrão é /radio.mp3 (ou /radio.ogg); na edição, vazio mantém o atual. */
  mount: mountName.optional(),
  mounts: z
    .array(
      z.object({
        mount: z.string().regex(/^\/[a-zA-Z0-9._-]{1,40}$/, 'Mountpoint inválido (ex.: /radio-hd)'),
        format: z.enum(['mp3', 'ogg', 'aac']),
        bitrate: z.number().int().min(32).max(320),
      }),
    )
    .max(4, 'No máximo 4 mountpoints extras')
    .default([]),
});

/** Substitui os mountpoints extras da estação, rejeitando duplicados e nomes reservados. */
function saveMounts(stationId: number, mainMount: string, mounts: z.infer<typeof settings>['mounts']) {
  const seen = new Set<string>([mainMount, '/live']);
  for (const m of mounts) {
    if (seen.has(m.mount)) throw new HttpError(400, `Mountpoint duplicado ou reservado: ${m.mount}`);
    seen.add(m.mount);
  }
  db.exec('BEGIN');
  try {
    run('DELETE FROM station_mounts WHERE station_id = ?', stationId);
    for (const m of mounts)
      run('INSERT INTO station_mounts (station_id, mount, format, bitrate) VALUES (?, ?, ?, ?)', stationId, m.mount, m.format, m.bitrate);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'radio';

const randomPassword = () => crypto.randomBytes(12).toString('base64url');

export function streamUrl(st: StationRow, mount = st.mount) {
  return `http://${config.publicHost}:${st.stream_port}${mount}`;
}

/** Link que passa pelo painel (mesma origem/HTTPS): funciona atrás de proxy/Cloudflare, sem abrir portas. */
export function proxyUrl(st: StationRow, mount = st.mount) {
  return `${config.publicOrigin}/stream/${st.slug}${mount}`;
}

/** Todos os streams da estação (principal primeiro). */
export function streamsOf(st: StationRow) {
  return [
    { mount: st.mount, url: streamUrl(st), proxyUrl: proxyUrl(st), format: st.format, bitrate: st.bitrate },
    ...mountsFor(st.id).map((m) => ({ mount: m.mount, url: streamUrl(st, m.mount), proxyUrl: proxyUrl(st, m.mount), format: m.format, bitrate: m.bitrate })),
  ];
}

export async function stationView(st: StationRow) {
  return {
    id: st.id,
    name: st.name,
    slug: st.slug,
    description: st.description,
    mount: st.mount,
    format: st.format,
    bitrate: st.bitrate,
    liveEnabled: !!st.live_enabled,
    requestsEnabled: !!st.requests_enabled,
    autostart: !!st.autostart,
    crossfadeSeconds: st.crossfade_seconds,
    normalize: !!st.normalize,
    recordLive: !!st.record_live,
    historyLimit: st.history_limit,
    audioPreset: st.audio_preset,
    audioGain: st.audio_gain,
    noRepeatMinutes: st.no_repeat_minutes,
    liveTimeout: st.live_timeout,
    liveContinue: !!st.live_continue,
    timeAnnounce: st.time_announce,
    timeAnnounceVoice: !!st.time_announce_voice,
    timezone: st.timezone,
    audioWarning: audioWarningFor(st.id),
    mounts: mountsFor(st.id).map((m) => ({ mount: m.mount, format: m.format, bitrate: m.bitrate })),
    streams: streamsOf(st),
    running: isRunning(st.id),
    listeners: await getListeners(st),
    nowPlaying: nowPlayingView(st, getNowPlaying(st.id)),
    coverUrl: stationCoverUrl(st),
    live: getLive(st.id),
    streamUrl: streamUrl(st),
    engine: engineMode(),
    dj: st.live_enabled && engineMode() === 'liquidsoap'
      ? { host: config.publicHost, port: harborPort(st), mount: '/live', username: 'source', password: st.source_password }
      : null,
  };
}

function nextPort(): number {
  const row = get<{ p: number | null }>('SELECT MAX(stream_port) AS p FROM stations');
  const port = row?.p ? row.p + 10 : config.engine.streamPortStart;
  if (port + 9 > config.engine.streamPortEnd) throw new HttpError(409, 'Faixa de portas esgotada');
  return port;
}

export async function stationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations', async (req) => {
    const rows =
      req.user.role === 'admin'
        ? all<StationRow>('SELECT * FROM stations ORDER BY name')
        : all<StationRow>(
            `SELECT s.* FROM stations s JOIN station_members m ON m.station_id = s.id
             WHERE m.user_id = ? ORDER BY s.name`,
            req.user.id,
          );
    return Promise.all(rows.map(stationView));
  });

  app.post('/api/stations', async (req, reply) => {
    requireAdmin(req);
    const body = settings.parse(req.body);
    let slug = slugify(body.name);
    if (get('SELECT 1 AS ok FROM stations WHERE slug = ?', slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
    const r = run(
      `INSERT INTO stations (name, slug, description, stream_port, mount, format, bitrate,
         source_password, admin_password, live_enabled, requests_enabled, autostart, crossfade_seconds, normalize, record_live, history_limit, audio_preset, audio_gain, no_repeat_minutes, live_timeout, live_continue, time_announce, timezone, time_announce_voice)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      slug,
      body.description,
      nextPort(),
      body.mount ?? `/radio.${body.format}`,
      body.format,
      body.bitrate,
      randomPassword(),
      randomPassword(),
      body.liveEnabled ? 1 : 0,
      body.requestsEnabled ? 1 : 0,
      body.autostart ? 1 : 0,
      body.crossfadeSeconds,
      body.normalize ? 1 : 0,
      body.recordLive ? 1 : 0,
      body.historyLimit,
      body.audioPreset,
      body.audioGain,
      body.noRepeatMinutes,
      body.liveTimeout,
      body.liveContinue ? 1 : 0,
      body.timeAnnounce,
      body.timezone,
      body.timeAnnounceVoice ? 1 : 0,
    );
    const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', Number(r.lastInsertRowid))!;
    saveMounts(st.id, st.mount, body.mounts);
    ensureStationDirs(st.id);
    if (config.engine.enabled && st.autostart) {
      // Falha ao iniciar (ex.: porta ocupada) não deve impedir a criação da estação.
      await startStation(st).catch((e) => app.log.error(e, 'falha ao iniciar a estação recém-criada'));
    }
    return reply.code(201).send(await stationView(st));
  });

  app.get('/api/stations/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    return stationView(stationFor(req, id));
  });

  app.put('/api/stations/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    requireAdmin(req);
    const b = settings.parse(req.body);
    const newMount = b.mount ?? st.mount;
    // Valida antes de gravar: o nome principal não pode repetir um stream extra.
    if (b.mounts.some((m) => m.mount === newMount)) throw new HttpError(400, `O nome ${newMount} já é usado por um stream extra`);
    run(
      `UPDATE stations SET name = ?, description = ?, mount = ?, format = ?, bitrate = ?,
         live_enabled = ?, requests_enabled = ?, autostart = ?, crossfade_seconds = ?, normalize = ?, record_live = ?, history_limit = ?, audio_preset = ?, audio_gain = ?, no_repeat_minutes = ?, live_timeout = ?, live_continue = ?, time_announce = ?, timezone = ?, time_announce_voice = ? WHERE id = ?`,
      b.name,
      b.description,
      newMount,
      b.format,
      b.bitrate,
      b.liveEnabled ? 1 : 0,
      b.requestsEnabled ? 1 : 0,
      b.autostart ? 1 : 0,
      b.crossfadeSeconds,
      b.normalize ? 1 : 0,
      b.recordLive ? 1 : 0,
      b.historyLimit,
      b.audioPreset,
      b.audioGain,
      b.noRepeatMinutes,
      b.liveTimeout,
      b.liveContinue ? 1 : 0,
      b.timeAnnounce,
      b.timezone,
      b.timeAnnounceVoice ? 1 : 0,
      st.id,
    );
    saveMounts(st.id, newMount, b.mounts);
    const updated = get<StationRow>('SELECT * FROM stations WHERE id = ?', st.id)!;
    if (config.engine.enabled && isRunning(st.id)) await restartStation(updated);
    return stationView(updated);
  });

  // Hora certa: ouvir um exemplo no painel (gera e devolve o áudio) e tocar o aviso agora na rádio.
  app.get('/api/stations/:id/time-announce/preview', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const q = z.object({ hour: z.coerce.number().int().min(0).max(23).optional(), minute: z.coerce.number().int().min(0).max(59).optional() }).parse(req.query);
    const now = localTime(st.timezone);
    try {
      const clip = await resolveClip(st, q.hour ?? now.hour, q.minute ?? now.minute);
      if (!clip) throw new Error('Não há arquivo para esse horário e a voz sintética está desligada');
      const file = clip.file;
      return reply.header('Content-Type', file.endsWith('.wav') ? 'audio/wav' : file.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream').header('Cache-Control', 'no-store').send(fs.createReadStream(file));
    } catch (e) {
      throw new HttpError(424, (e as Error).message);
    }
  });

  app.post('/api/stations/:id/time-announce/now', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    if (engineMode() !== 'liquidsoap') throw new HttpError(400, 'A hora certa só funciona no modo completo (Icecast + Liquidsoap)');
    if (!isRunning(st.id)) throw new HttpError(409, 'A estação está parada');
    try {
      return { ok: true, ...(await announceNow(st)) };
    } catch (e) {
      throw new HttpError(424, (e as Error).message);
    }
  });

  // Derruba o encoder/DJ que está no ar: o AutoDJ assume na hora. Só admin e operadores da estação.
  app.post('/api/stations/:id/live/kick', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    if (engineMode() !== 'liquidsoap') throw new HttpError(400, 'O ao vivo só existe no modo completo (Icecast + Liquidsoap)');
    if (!isRunning(st.id)) throw new HttpError(409, 'A estação está parada');
    try {
      await kickLive(st);
    } catch (e) {
      throw new HttpError(502, `Não foi possível falar com o Liquidsoap: ${(e as Error).message}`);
    }
    clearLive(st.id);
    return { ok: true };
  });

  // Capa (logo) da rádio: entra no lugar da capa das músicas que não têm.
  app.post('/api/stations/:id/cover', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const file = await req.file({ limits: { fileSize: 4 * 1024 * 1024 } });
    if (!file) throw new HttpError(400, 'Envie uma imagem');
    const buf = await file.toBuffer(); // lança erro se passar de 4 MB
    if (file.file.truncated) throw new HttpError(413, 'Imagem muito grande (limite de 4 MB)');
    const ext = sniffImage(buf);
    if (!ext) throw new HttpError(400, 'Formato não suportado: use PNG, JPG, WEBP ou GIF');
    saveStationCover(st, buf, ext);
    return stationView(get<StationRow>('SELECT * FROM stations WHERE id = ?', st.id)!);
  });

  app.delete('/api/stations/:id/cover', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    removeStationCover(st);
    return stationView(get<StationRow>('SELECT * FROM stations WHERE id = ?', st.id)!);
  });

  app.delete('/api/stations/:id', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    await stopStation(st.id);
    run('DELETE FROM stations WHERE id = ?', st.id);
    fs.rmSync(stationDir(st.id), { recursive: true, force: true });
    return { ok: true };
  });

  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post(`/api/stations/:id/${action}`, async (req) => {
      const { id } = idParam.parse(req.params);
      const st = stationFor(req, id);
      if (!config.engine.enabled) throw new HttpError(503, 'Engine desativada neste ambiente');
      if (action === 'stop') await stopStation(st.id);
      else if (action === 'start') await startStation(st);
      else await restartStation(st);
      return stationView(st);
    });
  }

  // Quem está ouvindo agora: IP, país, aparelho, player, tempo e stream. Só tempo real (nada é guardado).
  app.get('/api/stations/:id/listeners', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const items = (await liveListeners(st, engineMode())) ?? [];
    items.sort((a, b) => a.seconds - b.seconds);
    const count = <T extends string>(key: (l: (typeof items)[number]) => T, label: (l: (typeof items)[number]) => string) => {
      const m = new Map<string, { name: string; count: number }>();
      for (const l of items) {
        const k = key(l);
        const cur = m.get(k) ?? { name: label(l), count: 0 };
        cur.count++;
        m.set(k, cur);
      }
      return [...m.values()].sort((a, b) => b.count - a.count);
    };
    return {
      running: isRunning(st.id),
      // Se o Icecast não puder ser consultado, só os ouvintes do link direto deixam de aparecer.
      icecastError: engineMode() === 'liquidsoap' ? icecastError(st.id) : null,
      total: items.length,
      unique: new Set(items.map((l) => l.ip)).size,
      countries: count((l) => l.country, (l) => `${l.flag} ${l.countryName}`),
      devices: count((l) => l.device, (l) => l.device),
      players: count((l) => l.player, (l) => l.player),
      items,
    };
  });

  app.get('/api/stations/:id/history', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    return historyView(st, getHistory(st.id, 50));
  });
}
