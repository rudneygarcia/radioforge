import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { all, get, run } from '../db.js';
import { adMedia, fireBlock, type AdBlockRow } from '../engine/ads.js';
import { isRunning } from '../engine/manager.js';
import type { StationRow } from '../db.js';

const idParam = z.object({ id: z.coerce.number().int(), blockId: z.coerce.number().int().optional() });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido (use HH:MM)');

const body = z.object({
  name: z.string().min(1).max(80),
  folderId: z.number().int().nullable(),
  times: z.array(hhmm).min(1, 'Informe pelo menos um horário').max(96),
  days: z.array(z.number().int().min(0).max(6)).min(1, 'Escolha pelo menos um dia').default([0, 1, 2, 3, 4, 5, 6]),
  mode: z.enum(['sequential', 'shuffle']).default('sequential'),
  /** Quantos comerciais por bloco (0 = todos os da pasta). */
  items: z.number().int().min(0).max(50).default(0),
  enabled: z.boolean().default(true),
});

function view(b: AdBlockRow) {
  const folder = b.folder_id ? get<{ name: string }>('SELECT name FROM media_folders WHERE id = ?', b.folder_id) : undefined;
  return {
    id: b.id,
    name: b.name,
    folderId: b.folder_id,
    folderName: folder?.name ?? null,
    count: adMedia(b).length,
    times: b.times.split(',').filter(Boolean),
    days: b.days.split(',').filter(Boolean).map(Number),
    mode: b.mode,
    items: b.items,
    enabled: !!b.enabled,
  };
}

export async function adRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/ad-blocks', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    return all<AdBlockRow>('SELECT * FROM ad_blocks WHERE station_id = ? ORDER BY name', st.id).map(view);
  });

  const save = (stationId: number, b: z.infer<typeof body>, blockId?: number) => {
    if (b.folderId !== null && !get('SELECT 1 AS ok FROM media_folders WHERE id = ? AND station_id = ?', b.folderId, stationId)) throw new HttpError(400, 'Pasta não encontrada');
    const times = [...new Set(b.times)].sort().join(',');
    const days = [...new Set(b.days)].sort().join(',');
    if (blockId === undefined) {
      const r = run('INSERT INTO ad_blocks (station_id, name, folder_id, times, days, mode, items, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', stationId, b.name, b.folderId, times, days, b.mode, b.items, b.enabled ? 1 : 0);
      return Number(r.lastInsertRowid);
    }
    const r = run('UPDATE ad_blocks SET name = ?, folder_id = ?, times = ?, days = ?, mode = ?, items = ?, enabled = ? WHERE id = ? AND station_id = ?', b.name, b.folderId, times, days, b.mode, b.items, b.enabled ? 1 : 0, blockId, stationId);
    if (r.changes === 0) throw new HttpError(404, 'Bloco não encontrado');
    return blockId;
  };

  app.post('/api/stations/:id/ad-blocks', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const bid = save(st.id, body.parse(req.body));
    return reply.code(201).send(view(get<AdBlockRow>('SELECT * FROM ad_blocks WHERE id = ?', bid)!));
  });

  app.put('/api/stations/:id/ad-blocks/:blockId', async (req) => {
    const { id, blockId } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const bid = save(st.id, body.parse(req.body), blockId);
    return view(get<AdBlockRow>('SELECT * FROM ad_blocks WHERE id = ?', bid)!);
  });

  app.delete('/api/stations/:id/ad-blocks/:blockId', async (req) => {
    const { id, blockId } = idParam.parse(req.params);
    const st = stationFor(req, id);
    run('DELETE FROM ad_blocks WHERE id = ? AND station_id = ?', blockId ?? -1, st.id);
    return { ok: true };
  });

  // Dispara o bloco agora (teste): entra na fila e toca ao fim da música atual.
  app.post('/api/stations/:id/ad-blocks/:blockId/fire', async (req) => {
    const { id, blockId } = idParam.parse(req.params);
    const st = stationFor(req, id) as StationRow;
    const b = get<AdBlockRow>('SELECT * FROM ad_blocks WHERE id = ? AND station_id = ?', blockId ?? -1, st.id);
    if (!b) throw new HttpError(404, 'Bloco não encontrado');
    if (!st.autodj) throw new HttpError(409, 'Esta estação não tem AutoDJ.');
    if (!isRunning(st.id)) throw new HttpError(409, 'A estação está parada.');
    const n = await fireBlock(st, b, 'manual');
    if (n === 0) throw new HttpError(409, 'Nenhum comercial foi enfileirado (pasta vazia ou erro no Liquidsoap). Veja as veiculações.');
    return { queued: n };
  });

  // Comprovante de veiculação: o que foi colocado no ar e quando.
  app.get('/api/stations/:id/ad-plays', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return all<{ id: number; block_name: string; title: string; status: string; note: string; pushed_at: string }>(
      'SELECT id, block_name, title, status, note, pushed_at FROM ad_plays WHERE station_id = ? ORDER BY id DESC LIMIT ?',
      st.id,
      limit,
    );
  });
}
