import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.js';
import { config } from '../config.js';
import { all, get, run, type MediaRow, type StationRow } from '../db.js';
import { isRunning, pushRequest } from '../engine/manager.js';
import { getHistory, getListeners, getNowPlaying, recordTrack } from '../engine/nowplaying.js';
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
const lastRequest = new Map<string, number>();

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
      nowPlaying: getNowPlaying(st.id),
      requestsEnabled: !!st.requests_enabled,
    };
  });

  app.get('/api/public/stations/:slug/history', async (req) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    return getHistory(st.id, 20);
  });

  // Catálogo para a página de pedidos.
  app.get('/api/public/stations/:slug/songs', async (req) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    if (!st.requests_enabled) return [];
    return all<MediaRow>('SELECT id, title, artist FROM media WHERE station_id = ? ORDER BY artist, title', st.id).map(
      (m) => ({ id: m.id, title: m.title, artist: m.artist }),
    );
  });

  app.post('/api/public/stations/:slug/request', async (req, reply) => {
    const st = stationBySlug(slugParam.parse(req.params).slug);
    if (!st.requests_enabled) throw new HttpError(403, 'Pedidos desativados');
    if (!isRunning(st.id)) throw new HttpError(503, 'A rádio está offline');
    const { mediaId } = z.object({ mediaId: z.number().int() }).parse(req.body);
    const key = `${st.id}:${req.ip}`;
    const last = lastRequest.get(key) ?? 0;
    if (Date.now() - last < 5 * 60_000) throw new HttpError(429, 'Aguarde alguns minutos para pedir outra música');
    const m = get<MediaRow>('SELECT * FROM media WHERE id = ? AND station_id = ?', mediaId, st.id);
    if (!m) throw new HttpError(404, 'Música não encontrada');
    await pushRequest(st.id, path.join(config.dataDir, m.path));
    lastRequest.set(key, Date.now());
    run('INSERT INTO song_requests (station_id, media_id, ip) VALUES (?, ?, ?)', st.id, m.id, req.ip);
    return reply.code(202).send({ ok: true });
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
    recordTrack(id, b.artist, title);
    return { ok: true };
  });
}
