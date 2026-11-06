import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { all, get, run, type WebhookRow } from '../db.js';
import { deliver, EVENTS } from '../engine/webhooks.js';
import { assertPublicUrl } from '../ssrf.js';

const params = z.object({ id: z.coerce.number().int(), hookId: z.coerce.number().int().optional() });

const body = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(['generic', 'discord']),
  url: z.string().url().max(500),
  events: z.array(z.enum(EVENTS)).min(1, 'Escolha ao menos um evento'),
  enabled: z.boolean().default(true),
});

const view = (h: WebhookRow) => ({
  id: h.id,
  name: h.name,
  type: h.type,
  url: h.url,
  // O segredo só serve para webhooks genéricos (assinatura HMAC); o Discord ignora o cabeçalho.
  secret: h.type === 'generic' ? h.secret : null,
  events: h.events.split(','),
  enabled: !!h.enabled,
  lastStatus: h.last_status,
  lastAt: h.last_at,
});

async function validate(b: z.infer<typeof body>) {
  if (b.type === 'discord') {
    const u = new URL(b.url);
    const ok = /(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/');
    if (!ok) throw new HttpError(400, 'URL do Discord inválida (use a URL de webhook do canal)');
  }
  try {
    await assertPublicUrl(b.url);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/webhooks', async (req) => {
    const { id } = params.parse(req.params);
    return all<WebhookRow>('SELECT * FROM station_webhooks WHERE station_id = ? ORDER BY id', stationFor(req, id).id).map(view);
  });

  app.post('/api/stations/:id/webhooks', async (req, reply) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = body.parse(req.body);
    await validate(b);
    const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM station_webhooks WHERE station_id = ?', st.id);
    if ((count?.n ?? 0) >= 10) throw new HttpError(400, 'Limite de 10 webhooks por estação');
    const r = run(
      'INSERT INTO station_webhooks (station_id, name, type, url, secret, events, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      st.id,
      b.name,
      b.type,
      b.url,
      crypto.randomBytes(24).toString('base64url'),
      b.events.join(','),
      b.enabled ? 1 : 0,
    );
    return reply.code(201).send(view(get<WebhookRow>('SELECT * FROM station_webhooks WHERE id = ?', Number(r.lastInsertRowid))!));
  });

  app.put('/api/stations/:id/webhooks/:hookId', async (req) => {
    const { id, hookId } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = body.parse(req.body);
    await validate(b);
    const r = run(
      'UPDATE station_webhooks SET name = ?, type = ?, url = ?, events = ?, enabled = ? WHERE id = ? AND station_id = ?',
      b.name,
      b.type,
      b.url,
      b.events.join(','),
      b.enabled ? 1 : 0,
      hookId ?? -1,
      st.id,
    );
    if (r.changes === 0) throw new HttpError(404, 'Webhook não encontrado');
    return view(get<WebhookRow>('SELECT * FROM station_webhooks WHERE id = ?', hookId!)!);
  });

  app.delete('/api/stations/:id/webhooks/:hookId', async (req) => {
    const { id, hookId } = params.parse(req.params);
    const st = stationFor(req, id);
    run('DELETE FROM station_webhooks WHERE id = ? AND station_id = ?', hookId ?? -1, st.id);
    return { ok: true };
  });

  // Envia um evento de exemplo para conferir se o destino responde.
  app.post('/api/stations/:id/webhooks/:hookId/test', async (req) => {
    const { id, hookId } = params.parse(req.params);
    const st = stationFor(req, id);
    const h = get<WebhookRow>('SELECT * FROM station_webhooks WHERE id = ? AND station_id = ?', hookId ?? -1, st.id);
    if (!h) throw new HttpError(404, 'Webhook não encontrado');
    const status = await deliver(h, st, 'song_change', { artist: 'Artista de teste', title: 'Música de teste', test: true });
    return { status };
  });
}
