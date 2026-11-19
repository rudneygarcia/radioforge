import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { stationDir } from '../config.js';
import { djsFor, get, run, type DjRow, type StationRow } from '../db.js';
import { engineSignature, reloadLiquidsoap } from '../engine/manager.js';

const params = z.object({ id: z.coerce.number().int(), djId: z.coerce.number().int().optional(), file: z.string().optional() });

const createBody = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{3,32}$/, 'Usuário: 3 a 32 caracteres (letras, números, _ . -)')
    .refine((u) => u.toLowerCase() !== 'source', 'O usuário "source" é reservado'),
  displayName: z.string().max(80).default(''),
  password: z.string().min(6).max(64).optional(),
});

const updateBody = z.object({
  displayName: z.string().max(80).optional(),
  enabled: z.boolean().optional(),
  resetPassword: z.boolean().optional(),
  scheduleEnabled: z.boolean().optional(),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inicial inválido').optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário final inválido').optional(),
  days: z.array(z.number().int().min(0).max(6)).optional(),
});

const newPassword = () => crypto.randomBytes(9).toString('base64url');

const djView = (d: DjRow) => ({
  id: d.id,
  username: d.username,
  displayName: d.display_name,
  enabled: !!d.enabled,
  password: d.password,
  scheduleEnabled: !!d.schedule_enabled,
  startTime: d.start_time,
  endTime: d.end_time,
  days: d.days.split(',').filter(Boolean).map(Number),
});


export async function djRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Só recarrega o Liquidsoap (e derruba o DJ ao vivo) se algo que ele enxerga mudou: nome de exibição, por exemplo, não muda o script.
  const reload = async (st: StationRow, before: string) => {
    try {
      if (engineSignature(st) !== before) await reloadLiquidsoap(st);
    } catch (e) {
      app.log.error(e);
    }
  };

  app.get('/api/stations/:id/djs', async (req) => {
    const { id } = params.parse(req.params);
    return djsFor(stationFor(req, id).id).map(djView);
  });

  app.post('/api/stations/:id/djs', async (req, reply) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = createBody.parse(req.body);
    const before = engineSignature(st);
    if (get('SELECT 1 AS ok FROM station_djs WHERE station_id = ? AND username = ?', st.id, b.username))
      throw new HttpError(409, 'Já existe um DJ com esse usuário');
    const r = run(
      'INSERT INTO station_djs (station_id, username, password, display_name) VALUES (?, ?, ?, ?)',
      st.id,
      b.username,
      b.password ?? newPassword(),
      b.displayName,
    );
    await reload(st, before);
    return reply.code(201).send(djView(get<DjRow>('SELECT * FROM station_djs WHERE id = ?', Number(r.lastInsertRowid))!));
  });

  app.put('/api/stations/:id/djs/:djId', async (req) => {
    const { id, djId } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = updateBody.parse(req.body);
    const before = engineSignature(st);
    const dj = get<DjRow>('SELECT * FROM station_djs WHERE id = ? AND station_id = ?', djId ?? -1, st.id);
    if (!dj) throw new HttpError(404, 'DJ não encontrado');
    run(
      `UPDATE station_djs SET display_name = ?, enabled = ?, password = ?,
         schedule_enabled = ?, start_time = ?, end_time = ?, days = ? WHERE id = ?`,
      b.displayName ?? dj.display_name,
      (b.enabled ?? !!dj.enabled) ? 1 : 0,
      b.resetPassword ? newPassword() : dj.password,
      (b.scheduleEnabled ?? !!dj.schedule_enabled) ? 1 : 0,
      b.startTime ?? dj.start_time,
      b.endTime ?? dj.end_time,
      b.days ? [...new Set(b.days)].sort().join(',') : dj.days,
      dj.id,
    );
    await reload(st, before);
    return djView(get<DjRow>('SELECT * FROM station_djs WHERE id = ?', dj.id)!);
  });

  app.delete('/api/stations/:id/djs/:djId', async (req) => {
    const { id, djId } = params.parse(req.params);
    const st = stationFor(req, id);
    const before = engineSignature(st);
    run('DELETE FROM station_djs WHERE id = ? AND station_id = ?', djId ?? -1, st.id);
    await reload(st, before);
    return { ok: true };
  });

}
