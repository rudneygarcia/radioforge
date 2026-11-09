import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.js';
import { config } from '../config.js';
import { all, get, mountsFor, recentMedia, requestableMedia, run, type MediaRow, type StationRow } from '../db.js';
import { isRunning, pushRequest, writePlaylists } from '../engine/manager.js';
import { isHiddenTrack } from '../engine/hide.js';
import { PROXY_MARK, registerProxyConn } from '../engine/listeners.js';
import { coverFile, coverMime, historyView, nowPlayingView, stationCoverPath, stationCoverUrl } from '../engine/covers.js';
import { getHistory, getListeners, getLive, getNowPlaying, recordTrack, setLive } from '../engine/nowplaying.js';
import { streamsOf, streamUrl } from './stations.js';

const slugParam = z.object({ slug: z.string() });

function stationBySlug(slug: string): StationRow {
  const st = get<StationRow>('SELECT * FROM stations WHERE slug = ?', slug);
  if (!st) throw new HttpError(404, 'Estação não encontrada');
  return st;
}

const safeEqual = (a: string, b: string) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// Limite de pedidos: 1 por IP a cada 5 minutos por estação.

/** Repassa o áudio do Icecast (ou do motor simples) para o ouvinte, sem cache e sem buffer. */
function proxyStream(req: FastifyRequest, reply: FastifyReply, st: StationRow, mount: string | undefined) {
  if (!mount) throw new HttpError(404, 'Stream não encontrado');
  // 503 direto (o tratador de erros esconde a mensagem de erros 5xx).
  if (!isRunning(st.id)) return reply.code(503).send({ error: 'A rádio está offline' });
  reply.hijack();
  const res = reply.raw;
  const wantsIcy = String(req.headers['icy-metadata'] ?? '') === '1';
  const fail = (code: number) => {
    if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Stream indisponível' }));
  };
  const upstream = http.get(
    {
      host: '127.0.0.1',
      port: st.stream_port,
      path: mount,
      // O Icecast (e o motor simples) confiam neste cabeçalho, vindo de 127.0.0.1, para registrar o IP real do ouvinte.
      headers: {
        // Atrás do Cloudflare, CF-Connecting-IP é o IP real do ouvinte (X-Forwarded-For pode ter valores do cliente).
        'X-Forwarded-For': String(req.headers['cf-connecting-ip'] ?? req.ip),
        // A marca no fim do User-Agent evita contar a mesma conexão duas vezes (aqui e na lista do Icecast).
        'User-Agent': `${String(req.headers['user-agent'] ?? 'RadioForge')} ${PROXY_MARK}`,
        // Players de rádio (VLC, apps) pedem metadados ICY: repassamos o pedido e o resultado, que o Icecast intercala no áudio.
        'Icy-MetaData': wantsIcy ? '1' : '0',
      },
    },
    (up) => {
      if (up.statusCode !== 200) {
        up.resume();
        return fail(502);
      }
      // icy-metaint diz de quantos em quantos bytes vem o bloco de metadados; os bytes passam sem alteração.
      const icy: Record<string, string> = {};
      for (const h of ['icy-metaint', 'icy-name', 'icy-description', 'icy-genre', 'icy-br', 'icy-pub', 'icy-url']) {
        const v = up.headers[h];
        if (v && (wantsIcy || h !== 'icy-metaint')) icy[h] = String(v);
      }
      res.writeHead(200, {
        ...icy,
        'Content-Type': String(up.headers['content-type'] ?? 'audio/mpeg'),
        // no-store: impede o Cloudflare de guardar o stream (ele cacheia .mp3/.aac/.ogg por padrão).
        'Cache-Control': 'no-cache, no-store, private',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });
      // Conta o ouvinte aqui, com o IP real (CF-Connecting-IP atrás do Cloudflare), enquanto a conexão estiver aberta.
      const unregister = registerProxyConn(st.id, String(req.headers['cf-connecting-ip'] ?? req.ip), String(req.headers['user-agent'] ?? ''), mount);
      res.on('close', unregister);
      up.pipe(res);
    },
  );
  upstream.on('error', () => fail(502));
  req.raw.on('close', () => upstream.destroy());
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/api/public/stations/:slug', async (req) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    return {
      name: st.name,
      slug: st.slug,
      description: st.description,
      streamUrl: streamUrl(st),
      streams: streamsOf(st),
      format: st.format,
      online: isRunning(st.id),
      listeners: await getListeners(st),
      nowPlaying: nowPlayingView(st, getNowPlaying(st.id)),
      // No público, só o nome de exibição (nunca o usuário de login).
      live: getLive(st.id) ? { name: getLive(st.id)!.name, since: getLive(st.id)!.since } : null,
      requestsEnabled: !!st.requests_enabled,
      historyLimit: st.history_limit,
      liveContinue: !!st.live_continue,
      coverUrl: stationCoverUrl(st),
    };
  });

  /**
   * Áudio pela mesma origem do painel (HTTPS, porta do painel): o navegador bloqueia áudio http:// dentro de
   * página https:// (conteúdo misto), e atrás de proxy/Cloudflare as portas 8000+ não chegam ao servidor.
   * `index` 0 = stream principal, 1+ = streams extras.
   */
  app.get('/api/public/stations/:slug/stream/:index', async (req, reply) => {
    const { slug, index } = z.object({ slug: z.string(), index: z.coerce.number().int().min(0).max(10) }).parse(req.params);
    const st = stationBySlug(slug);
    const mount = [st.mount, ...mountsFor(st.id).map((m) => m.mount)][index];
    return proxyStream(req, reply, st, mount);
  });

  // Link amigável para players externos (VLC, apps): https://dominio/stream/<estação>/radio.mp3
  app.get('/stream/:slug/:name', async (req, reply) => {
    const { slug, name } = z.object({ slug: z.string(), name: z.string() }).parse(req.params);
    const st = stationBySlug(slug);
    const wanted = '/' + name;
    const mount = [st.mount, ...mountsFor(st.id).map((m) => m.mount)].find((m) => m === wanted);
    return proxyStream(req, reply, st, mount);
  });

  // Capa (logo) da rádio.
  app.get('/api/public/stations/:slug/station-cover', async (req, reply) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    const file = stationCoverPath(st);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Sem capa');
    return reply.header('Content-Type', coverMime(file)).header('Cache-Control', 'public, max-age=86400').send(fs.createReadStream(file));
  });

  // Capa de uma música da estação (extraída das tags). Pública: aparece no player e nos apps.
  app.get('/api/public/stations/:slug/cover/:mediaId', async (req, reply) => {
    const { slug, mediaId } = z.object({ slug: z.string(), mediaId: z.coerce.number().int() }).parse(req.params);
    const st = stationBySlug(slug);
    const file = coverFile(st.id, mediaId);
    if (!file) throw new HttpError(404, 'Sem capa');
    return reply
      .header('Content-Type', coverMime(file))
      .header('Cache-Control', 'public, max-age=86400')
      .send(fs.createReadStream(file));
  });

  app.get('/api/public/stations/:slug/history', async (req) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    return historyView(st, getHistory(st.id, 50));
  });

  // Catálogo para a página de pedidos.
  app.get('/api/public/stations/:slug/songs', async (req) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    if (!st.requests_enabled) return [];
    // Só as músicas de playlists com "Permitir pedidos" ligado (e que não são vinhetas).
    const recent = recentMedia(st.id, st.no_repeat_minutes);
    return requestableMedia(st.id).map((m) => ({ id: m.id, title: m.title, artist: m.artist, recent: recent.ids.has(m.id) }));
  });

  app.post('/api/public/stations/:slug/request', async (req, reply) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    if (!st.requests_enabled) throw new HttpError(403, 'Pedidos desativados');
    if (!isRunning(st.id)) throw new HttpError(503, 'A rádio está offline');
    // Com o AutoDJ em segundo plano durante o ao vivo, o pedido tocaria mudo: só aceita quando o DJ sair.
    if (st.live_continue && getLive(st.id)) throw new HttpError(409, 'Estamos ao vivo agora. Os pedidos voltam quando o AutoDJ retornar.');
    const { mediaId } = z.object({ mediaId: z.number().int() }).parse(req.body);
    // Intervalo entre pedidos do mesmo ouvinte (configurado no painel; 0 = sem limite). Guardado no banco: vale após reiniciar.
    if (st.request_interval > 0) {
      const prev = get<{ created_at: string }>('SELECT created_at FROM song_requests WHERE station_id = ? AND ip = ? ORDER BY id DESC LIMIT 1', st.id, req.ip);
      const left = prev ? new Date(prev.created_at.replace(' ', 'T') + 'Z').getTime() + st.request_interval * 60_000 - Date.now() : 0;
      if (left > 0) throw new HttpError(429, `Você já fez um pedido. Aguarde ${Math.ceil(left / 60_000)} min para pedir outra música.`);
    }
    // Só pode pedir quem está em playlist com pedidos ligados.
    const m = requestableMedia(st.id).find((x) => x.id === mediaId);
    if (!m) throw new HttpError(404, 'Música não disponível para pedido');
    if (st.no_repeat_minutes > 0 && recentMedia(st.id, st.no_repeat_minutes).ids.has(m.id)) {
      throw new HttpError(409, 'Essa música tocou há pouco. Peça outra ou tente mais tarde.');
    }
    // Sem atraso: entra na fila do AutoDJ agora. Com atraso: fica agendado e o servidor coloca na fila no horário (timed.ts).
    const delay = st.request_delay;
    if (delay === 0) await pushRequest(st.id, path.join(config.dataDir, m.path), false, 0, isHiddenTrack(st, m));
    run(
      "INSERT INTO song_requests (station_id, media_id, ip, due_at, pushed) VALUES (?, ?, ?, datetime('now', ?), ?)",
      st.id,
      m.id,
      req.ip,
      `+${delay} minutes`,
      delay === 0 ? 1 : 0,
    );
    return reply.code(202).send({ ok: true, title: m.title, artist: m.artist, delayMinutes: delay });
  });

  // Pedidos recentes da estação (sem IPs); `mine` marca os feitos por este ouvinte. `played` = já tocou depois do pedido.
  app.get('/api/public/stations/:slug/requests', async (req) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    if (!st.requests_enabled) return [];
    const rows = all<{ id: number; title: string; artist: string; ip: string; created_at: string; pushed: number }>(
      `SELECT r.id, m.title, m.artist, r.ip, r.created_at, r.pushed FROM song_requests r JOIN media m ON m.id = r.media_id
       WHERE r.station_id = ? ORDER BY r.id DESC LIMIT 15`,
      st.id,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      createdAt: r.created_at,
      mine: r.ip === req.ip,
      waiting: !r.pushed,
      played: !!get('SELECT 1 AS ok FROM history WHERE station_id = ? AND title = ? AND artist = ? AND played_at >= ? LIMIT 1', st.id, r.title, r.artist, r.created_at),
    }));
  });

  // Chamado pelo Liquidsoap quando um DJ conecta/desconecta; mesmo token compartilhado.
  app.post('/internal/stations/:id/live', async (req) => {
    const token = String(req.headers['x-internal-token'] ?? '');
    if (!safeEqual(token, config.internalToken)) throw new HttpError(401, 'Token inválido');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ event: z.enum(['connect', 'disconnect']), user: z.string().default('') }).parse(req.body);
    if (!get('SELECT 1 AS ok FROM stations WHERE id = ?', id)) throw new HttpError(404, 'Estação não encontrada');
    setLive(id, b.event === 'connect', b.user);
    return { ok: true };
  });

  // Chamado pelo Liquidsoap a cada faixa; protegido por token compartilhado.
  app.post('/internal/stations/:id/track', async (req) => {
    const token = String(req.headers['x-internal-token'] ?? '');
    if (!safeEqual(token, config.internalToken)) throw new HttpError(401, 'Token inválido');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({ artist: z.string().default(''), title: z.string().default(''), filename: z.string().default('') })
      .parse(req.body);
    if (!get('SELECT 1 AS ok FROM stations WHERE id = ?', id)) throw new HttpError(404, 'Estação não encontrada');
    const title = b.title || path.basename(b.filename, path.extname(b.filename)) || 'Desconhecido';
    // Descobre qual música da biblioteca é (pelo caminho) para a regra de não repetir.
    const rel = b.filename ? path.relative(config.dataDir, b.filename) : '';
    const media = rel ? get<{ id: number }>('SELECT id FROM media WHERE station_id = ? AND path = ?', id, rel) : undefined;
    recordTrack(id, b.artist, title, media?.id ?? null);
    // A faixa que acabou de tocar sai das playlists por um tempo (o Liquidsoap recarrega o arquivo).
    const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', id);
    if (st && st.no_repeat_minutes > 0) writePlaylists(id);
    return { ok: true };
  });
}
