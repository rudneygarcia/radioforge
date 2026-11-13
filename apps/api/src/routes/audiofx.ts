import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdmin, stationFor } from '../auth.js';
import { run } from '../db.js';
import { fxSupport, MB_LEVELS, multibandLevel } from '../engine/audiofx.js';

const idParam = z.object({ id: z.coerce.number().int() });

/** Compressor multibanda (plugin LSP) do processador de áudio. Só o administrador altera. */
export async function audioFxRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/audio-fx', async (req) => {
    const st = stationFor(req, idParam.parse(req.params).id);
    return { multiband: multibandLevel(st), support: fxSupport(), levels: MB_LEVELS };
  });

  app.put('/api/stations/:id/audio-fx', async (req) => {
    requireAdmin(req);
    const st = stationFor(req, idParam.parse(req.params).id);
    const b = z.object({ multiband: z.number().int().min(0).max(2) }).parse(req.body);
    run('UPDATE stations SET audio_multiband = ? WHERE id = ?', b.multiband, st.id);
    return { ok: true, multiband: b.multiband };
  });
}
