import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin, stationFor } from '../auth.js';
import {
  activeVoice,
  clipFor,
  clipPath,
  clipsDir,
  deleteClip,
  deleteVoice,
  listClips,
  MAX_CLIP_BYTES,
  parseSlot,
  saveClip,
  slotLabel,
  slugVoice,
  verifyClip,
  voicesOf,
} from '../engine/timeclips.js';
import { getJob, MAX_ZIP_BYTES, runningJobFor, startZipJob } from '../engine/timezip.js';

const AUDIO_MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
const idParam = z.object({ id: z.coerce.number().int() });
const slotParams = z.object({ id: z.coerce.number().int(), voice: z.string().max(40), hour: z.coerce.number().int().min(0).max(23), minute: z.coerce.number().int().min(0).max(59) });

interface Result {
  name: string;
  status: 'ok' | 'error';
  voice?: string;
  slot?: string;
  replaced?: boolean;
  message?: string;
}

/** Arquivos de áudio da hora certa (por voz): enviar soltos ou em ZIP, listar, ouvir e excluir. */
export async function timeClipRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Vozes enviadas; com ?voice= devolve também os horários dessa voz (para mostrar o que falta). */
  app.get('/api/stations/:id/time-clips', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const { voice } = z.object({ voice: z.string().max(40).optional() }).parse(req.query);
    const voices = voicesOf(st.id);
    const active = activeVoice(st.id, st.time_voice);
    const which = voice ?? active;
    return {
      voices,
      active,
      voice: which,
      clips: which ? listClips(st.id, which).map((c) => ({ hour: c.hour, minute: c.minute, originalName: c.original_name, duration: c.duration })) : [],
    };
  });

  /**
   * Envia arquivos soltos. Voz, hora e minuto vêm do nome (masculino_14_30.mp3, 14h30.mp3, 14.mp3…).
   * Devolve um relatório por arquivo (aceito ou o motivo da recusa). Para muitos arquivos, use o ZIP.
   */
  app.post('/api/stations/:id/time-clips', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const q = z.object({ voice: z.string().max(40).optional(), hour: z.coerce.number().int().min(0).max(23).optional(), minute: z.coerce.number().int().min(0).max(59).optional() }).parse(req.query);
    fs.mkdirSync(clipsDir(st.id), { recursive: true });

    const results: Result[] = [];
    let count = 0;
    for await (const part of req.files({ limits: { fileSize: MAX_CLIP_BYTES, files: 200 } })) {
      count++;
      const name = part.filename;
      const tmp = path.join(clipsDir(st.id), `.up-${crypto.randomUUID()}${path.extname(name).toLowerCase()}`);
      try {
        await pipeline(part.file, fs.createWriteStream(tmp));
        if (part.file.truncated) throw new Error('arquivo grande demais (máximo 10 MB)');
        const parsed = q.hour !== undefined ? { voice: q.voice ? slugVoice(q.voice) : 'padrao', hour: q.hour, minute: q.minute ?? 0 } : parseSlot(name);
        if (!parsed) throw new Error('não deu para saber a hora pelo nome (use algo como masculino_14_30.mp3, 14h30.mp3 ou 14.mp3)');
        const size = fs.statSync(tmp).size;
        const duration = await verifyClip(tmp, name, size);
        const { replaced } = saveClip(st.id, parsed.voice, parsed.hour, parsed.minute, tmp, name, duration, size);
        results.push({ name, status: 'ok', voice: parsed.voice, slot: slotLabel(parsed.hour, parsed.minute), replaced });
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        results.push({ name, status: 'error', message: (e as Error).message });
      }
    }
    if (count === 0) throw new HttpError(400, 'Envie pelo menos um arquivo de áudio');
    return { results, voices: voicesOf(st.id) };
  });

  /** Envia UM ZIP com todos os áudios (pode ter pastas e várias vozes). O processamento roda em segundo plano. */
  app.post('/api/stations/:id/time-clips/zip', async (req, reply) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    if (runningJobFor(st.id)) throw new HttpError(409, 'Já existe um ZIP sendo processado para esta estação. Aguarde terminar.');
    fs.mkdirSync(clipsDir(st.id), { recursive: true });
    const part = await req.file({ limits: { fileSize: MAX_ZIP_BYTES } });
    if (!part) throw new HttpError(400, 'Envie um arquivo ZIP');
    if (path.extname(part.filename).toLowerCase() !== '.zip') {
      part.file.resume();
      throw new HttpError(400, 'O arquivo precisa ser um .zip');
    }
    const tmp = path.join(clipsDir(st.id), `.zip-upload-${crypto.randomUUID()}.zip`);
    await pipeline(part.file, fs.createWriteStream(tmp));
    if (part.file.truncated) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(413, `ZIP grande demais (máximo ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)} MB)`);
    }
    const job = startZipJob(st.id, tmp);
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/api/stations/:id/time-clips/zip/:jobId', async (req) => {
    const { id, jobId } = z.object({ id: z.coerce.number().int(), jobId: z.string() }).parse(req.params);
    const st = stationFor(req, id);
    const job = getJob(jobId);
    if (!job || job.stationId !== st.id) throw new HttpError(404, 'Processamento não encontrado');
    return job;
  });

  app.get('/api/stations/:id/time-clips/:voice/:hour/:minute/audio', async (req, reply) => {
    const { id, voice, hour, minute } = slotParams.parse(req.params);
    const st = stationFor(req, id);
    const c = clipFor(st.id, voice, hour, minute);
    if (!c || !fs.existsSync(clipPath(c))) throw new HttpError(404, 'Sem arquivo para esse horário');
    return reply
      .header('Content-Type', AUDIO_MIME[path.extname(c.file)] ?? 'application/octet-stream')
      .header('Cache-Control', 'no-store')
      .send(fs.createReadStream(clipPath(c)));
  });

  app.delete('/api/stations/:id/time-clips/:voice/:hour/:minute', async (req) => {
    requireAdmin(req);
    const { id, voice, hour, minute } = slotParams.parse(req.params);
    const st = stationFor(req, id);
    if (!deleteClip(st.id, voice, hour, minute)) throw new HttpError(404, 'Sem arquivo para esse horário');
    return { ok: true };
  });

  /** Apaga uma voz inteira (todos os horários dela). */
  app.delete('/api/stations/:id/time-clips/:voice', async (req) => {
    requireAdmin(req);
    const { id, voice } = z.object({ id: z.coerce.number().int(), voice: z.string().max(40) }).parse(req.params);
    const st = stationFor(req, id);
    return { ok: true, removed: deleteVoice(st.id, voice) };
  });
}
