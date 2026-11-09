import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import {
  ALLOWED_EXT,
  clipsDir,
  DEFAULT_VOICE,
  MAX_CLIP_BYTES,
  parseSlot,
  saveClip,
  slotLabel,
  slugVoice,
  verifyClip,
} from './timeclips.js';

/** Limites contra ZIP malicioso ("zip bomb"): quantidade de entradas e total descompactado. */
const MAX_ENTRIES = 12_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB descompactado
export const MAX_ZIP_BYTES = 400 * 1024 * 1024;

export interface ZipJob {
  id: string;
  stationId: number;
  status: 'running' | 'done' | 'error';
  /** Arquivos de áudio encontrados no ZIP (conhecido ao terminar de listar). */
  total: number;
  processed: number;
  accepted: number;
  replaced: number;
  rejected: number;
  voices: Record<string, number>;
  /** Primeiras recusas (nome + motivo), limitadas para não crescer sem fim. */
  errors: { name: string; message: string }[];
  message?: string;
  startedAt: number;
}

const jobs = new Map<string, ZipJob>();
const MAX_ERRORS = 60;

export const getJob = (id: string) => jobs.get(id) ?? null;
export const runningJobFor = (stationId: number) => [...jobs.values()].find((j) => j.stationId === stationId && j.status === 'running') ?? null;

/** Nome da voz: pelo nome do arquivo (masculino_00_02.mp3) ou, se não houver, pela pasta onde ele está no ZIP. */
function voiceFor(entryPath: string, parsedVoice: string): string {
  if (parsedVoice !== DEFAULT_VOICE) return parsedVoice;
  const parts = entryPath.split('/').filter(Boolean);
  const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
  return folder ? slugVoice(folder) : DEFAULT_VOICE;
}

const isJunk = (p: string) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(p) || path.basename(p).startsWith('._');

/**
 * Processa um ZIP em segundo plano: lê cada áudio, descobre voz/hora/minuto pelo nome, confere e guarda.
 * O conteúdo do ZIP nunca escolhe onde gravar (o nome em disco é gerado aqui), então não há risco de "zip slip".
 */
export function startZipJob(stationId: number, zipFile: string): ZipJob {
  const job: ZipJob = { id: crypto.randomUUID(), stationId, status: 'running', total: 0, processed: 0, accepted: 0, replaced: 0, rejected: 0, voices: {}, errors: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  // Esquece trabalhos antigos (1 hora).
  for (const [k, j] of jobs) if (j.status !== 'running' && Date.now() - j.startedAt > 3600_000) jobs.delete(k);

  const reject = (name: string, message: string) => {
    job.rejected++;
    if (job.errors.length < MAX_ERRORS) job.errors.push({ name, message });
  };
  const finish = (status: 'done' | 'error', message?: string) => {
    job.status = status;
    if (message) job.message = message;
    fs.rmSync(zipFile, { force: true });
  };

  yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
    if (err || !zip) return finish('error', 'Não foi possível abrir o ZIP (arquivo corrompido ou não é um ZIP).');
    if (zip.entryCount > MAX_ENTRIES) {
      zip.close();
      return finish('error', `ZIP com arquivos demais (${zip.entryCount}; máximo ${MAX_ENTRIES}).`);
    }
    let totalBytes = 0;
    zip.on('error', (e) => finish('error', `Falha ao ler o ZIP: ${e.message}`));
    zip.on('end', () => finish('done'));

    const next = () => zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const ext = path.extname(name).toLowerCase();
      // Pastas, lixo de sistema e arquivos que não são áudio: ignorados sem contar como recusa.
      if (/\/$/.test(name) || isJunk(name) || !ALLOWED_EXT.has(ext)) return next();
      job.total++;
      const base = path.basename(name);
      const slot = parseSlot(base);
      if (!slot) {
        job.processed++;
        reject(base, 'não deu para saber a hora pelo nome (esperado algo como masculino_14_30.mp3)');
        return next();
      }
      if (entry.uncompressedSize > MAX_CLIP_BYTES) {
        job.processed++;
        reject(base, 'arquivo grande demais (máximo 10 MB)');
        return next();
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > MAX_TOTAL_BYTES) {
        zip.close();
        return finish('error', 'O conteúdo do ZIP é grande demais (máximo 1 GB descompactado).');
      }
      zip.openReadStream(entry, (e2, stream) => {
        if (e2 || !stream) {
          job.processed++;
          reject(base, 'não foi possível extrair do ZIP');
          return next();
        }
        const tmp = path.join(clipsDir(stationId), `.zip-${crypto.randomUUID()}${ext}`);
        (async () => {
          try {
            fs.mkdirSync(clipsDir(stationId), { recursive: true });
            await pipeline(stream, fs.createWriteStream(tmp));
            const size = fs.statSync(tmp).size;
            const duration = await verifyClip(tmp, base, size);
            const voice = voiceFor(name, slot.voice);
            const { replaced } = saveClip(stationId, voice, slot.hour, slot.minute, tmp, base, duration, size);
            job.accepted++;
            if (replaced) job.replaced++;
            job.voices[voice] = (job.voices[voice] ?? 0) + 1;
          } catch (e) {
            fs.rmSync(tmp, { force: true });
            reject(`${base} (${slotLabel(slot.hour, slot.minute)})`, (e as Error).message);
          } finally {
            job.processed++;
            next();
          }
        })();
      });
    });
    next();
  });
  return job;
}
