import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin, stationFor } from '../auth.js';
import { libraryInfo, listPresets, presetPath, presetsDir, safePresetName, stereoLibDir, stereoLibPath } from '../engine/stereotool.js';

const idParam = z.object({ id: z.coerce.number().int() });
const MAX_LIB = 150 * 1024 * 1024;
const MAX_PRESET = 5 * 1024 * 1024;

export async function stereoToolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Biblioteca do Stereo Tool (do servidor inteiro).
  app.get('/api/stereotool', async () => ({ library: libraryInfo() }));

  app.post('/api/stereotool/library', async (req) => {
    requireAdmin(req);
    const part = await req.file({ limits: { fileSize: MAX_LIB } });
    if (!part) throw new HttpError(400, 'Envie o arquivo da biblioteca (libStereoTool_*.so)');
    fs.mkdirSync(stereoLibDir(), { recursive: true });
    const tmp = path.join(stereoLibDir(), `.up-${Date.now()}`);
    try {
      await pipeline(part.file, fs.createWriteStream(tmp));
      if (part.file.truncated) throw new HttpError(413, 'Arquivo grande demais');
      // Confere que é uma biblioteca Linux (ELF): o Liquidsoap roda dentro do contêiner Linux.
      const fd = fs.openSync(tmp, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
        throw new HttpError(400, 'Esse arquivo não é uma biblioteca Linux (.so). Baixe a versão "Linux" da biblioteca do Stereo Tool (libStereoTool_*.so, 64 bits).');
      }
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, stereoLibPath());
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { library: libraryInfo() };
  });

  app.delete('/api/stereotool/library', async (req) => {
    requireAdmin(req);
    fs.rmSync(stereoLibPath(), { force: true });
    return { library: libraryInfo() };
  });

  // Presets por estação.
  app.get('/api/stations/:id/stereotool/presets', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    return { presets: listPresets(st.id), active: st.stereo_preset };
  });

  app.post('/api/stations/:id/stereotool/presets', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const part = await req.file({ limits: { fileSize: MAX_PRESET } });
    if (!part) throw new HttpError(400, 'Envie o preset (.sts)');
    const name = safePresetName(part.filename);
    if (!name) {
      part.file.resume();
      throw new HttpError(400, 'O preset precisa ser um arquivo .sts (ou .ini)');
    }
    fs.mkdirSync(presetsDir(st.id), { recursive: true });
    const dest = presetPath(st.id, name);
    await pipeline(part.file, fs.createWriteStream(dest));
    if (part.file.truncated) {
      fs.rmSync(dest, { force: true });
      throw new HttpError(413, 'Preset grande demais (máximo 5 MB)');
    }
    return { presets: listPresets(st.id), name };
  });

  app.delete('/api/stations/:id/stereotool/presets/:name', async (req) => {
    requireAdmin(req);
    const { id, name } = z.object({ id: z.coerce.number().int(), name: z.string().max(100) }).parse(req.params);
    const st = stationFor(req, id);
    const safe = safePresetName(name);
    if (!safe) throw new HttpError(400, 'Nome inválido');
    fs.rmSync(presetPath(st.id, safe), { force: true });
    return { presets: listPresets(st.id) };
  });
}
