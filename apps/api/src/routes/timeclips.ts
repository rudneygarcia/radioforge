import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin, stationFor } from '../auth.js';
import {
  clipFor,
  clipPath,
  clipsDir,
  deleteClip,
  listClips,
  MAX_CLIP_BYTES,
  parseSlot,
  saveClip,
  slotLabel,
  verifyClip,
} from '../engine/timeclips.js';

const AUDIO_MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
const idParam = z.object({ id: z.coerce.number().int() });
const slotParams = z.object({ id: z.coerce.number().int(), hour: z.coerce.number().int().min(0).max(23), minute: z.coerce.number().int().min(0).max(59) });

const view = (c: ReturnType<typeof listClips>[number]) => ({ hour: c.hour, minute: c.minute, originalName: c.original_name, duration: c.duration, size: c.size });

interface Result {
  name: string;
  status: 'ok' | 'error';
  slot?: string;
  replaced?: boolean;
  duration?: number;
  message?: string;
}

/** Arquivos de áudio da hora certa: enviar (com verificação), listar, ouvir e excluir. */
export async function timeClipRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/time-clips', async (req) => {
    const { id } = idParam.parse(req.params);
    return listClips(stationFor(req, id).id).map(view);
  });

  /**
   * Envia um ou vários arquivos. A hora vem do nome (14.mp3, 14h30.mp3, 14-30.mp3…); para um único arquivo com
   * nome diferente, informe ?hour=&minute=. Devolve um relatório por arquivo (aceito ou o motivo da recusa).
   */
  app.post('/api/stations/:id/time-clips', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const q = z.object({ hour: z.coerce.number().int().min(0).max(23).optional(), minute: z.coerce.number().int().min(0).max(59).optional() }).parse(req.query);
    const forced = q.hour !== undefined ? { hour: q.hour, minute: q.minute ?? 0 } : null;
    fs.mkdirSync(clipsDir(st.id), { recursive: true });

    const results: Result[] = [];
    let count = 0;
    for await (const part of req.files({ limits: { fileSize: MAX_CLIP_BYTES, files: 60 } })) {
      count++;
      const name = part.filename;
      const tmp = path.join(clipsDir(st.id), `.up-${crypto.randomUUID()}${path.extname(name).toLowerCase()}`);
      try {
        await pipeline(part.file, fs.createWriteStream(tmp));
        if (part.file.truncated) throw new Error('arquivo grande demais (máximo 10 MB)');
        const slot = forced ?? parseSlot(name);
        if (!slot) throw new Error('não deu para saber a hora pelo nome (use algo como 14.mp3, 14h30.mp3 ou 14-30.mp3)');
        const size = fs.statSync(tmp).size;
        const duration = await verifyClip(tmp, name, size);
        const { replaced } = saveClip(st.id, slot.hour, slot.minute, tmp, name, duration, size);
        results.push({ name, status: 'ok', slot: slotLabel(slot.hour, slot.minute), replaced, duration });
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        results.push({ name, status: 'error', message: (e as Error).message });
      }
    }
    if (count === 0) throw new HttpError(400, 'Envie pelo menos um arquivo de áudio');
    return { results, clips: listClips(st.id).map(view) };
  });

  app.get('/api/stations/:id/time-clips/:hour/:minute/audio', async (req, reply) => {
    const { id, hour, minute } = slotParams.parse(req.params);
    const st = stationFor(req, id);
    const c = clipFor(st.id, hour, minute);
    if (!c || !fs.existsSync(clipPath(c))) throw new HttpError(404, 'Sem arquivo para esse horário');
    return reply
      .header('Content-Type', AUDIO_MIME[path.extname(c.file)] ?? 'application/octet-stream')
      .header('Cache-Control', 'no-store')
      .send(fs.createReadStream(clipPath(c)));
  });

  app.delete('/api/stations/:id/time-clips/:hour/:minute', async (req) => {
    requireAdmin(req);
    const { id, hour, minute } = slotParams.parse(req.params);
    const st = stationFor(req, id);
    if (!deleteClip(st.id, hour, minute)) throw new HttpError(404, 'Sem arquivo para esse horário');
    return { ok: true };
  });
}
