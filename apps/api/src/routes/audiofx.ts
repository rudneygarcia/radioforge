import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAdmin, stationFor } from '../auth.js';
import { run } from '../db.js';
import { EQ_PRESETS, fxOf, fxSupport, WIDTHS } from '../engine/audiofx.js';

const idParam = z.object({ id: z.coerce.number().int() });
const eqKeys = Object.keys(EQ_PRESETS) as [keyof typeof EQ_PRESETS, ...(keyof typeof EQ_PRESETS)[]];
const widthKeys = Object.keys(WIDTHS) as [keyof typeof WIDTHS, ...(keyof typeof WIDTHS)[]];

/** Etapas extras do processador de áudio (equalizador, largura estéreo, multibanda). Só o administrador altera. */
export async function audioFxRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/audio-fx', async (req) => {
    const st = stationFor(req, idParam.parse(req.params).id);
    return {
      ...fxOf(st),
      support: fxSupport(),
      eqOptions: eqKeys.map((k) => ({ key: k, label: EQ_PRESETS[k].label })),
      widthOptions: widthKeys.map((k) => ({ key: k, label: WIDTHS[k].label })),
    };
  });

  app.put('/api/stations/:id/audio-fx', async (req) => {
    requireAdmin(req);
    const st = stationFor(req, idParam.parse(req.params).id);
    const b = z.object({ eq: z.enum(eqKeys), width: z.enum(widthKeys), multiband: z.boolean() }).parse(req.body);
    run('UPDATE stations SET audio_eq = ?, audio_width = ?, audio_multiband = ? WHERE id = ?', b.eq, b.width, b.multiband ? 1 : 0, st.id);
    return { ok: true, ...b };
  });
}
