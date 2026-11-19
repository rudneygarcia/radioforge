import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin } from '../auth.js';
import { backupsDir, createBackup, getKeepBackups, listBackups, MAX_KEEP_BACKUPS, MIN_KEEP_BACKUPS, newBackupName, pruneBackups, SAFE_BACKUP, setKeepBackups } from '../engine/backups.js';
import { stageRestore, validateBackupFile } from '../engine/restore.js';

/** Tamanho máximo do arquivo de backup enviado. */
const MAX_UPLOAD = 500 * 1024 * 1024;

const fileParam = z.object({ file: z.string() });

function backupFile(name: string): string {
  if (!SAFE_BACKUP.test(name)) throw new HttpError(400, 'Nome de arquivo inválido');
  const abs = path.join(backupsDir, name);
  if (!fs.existsSync(abs)) throw new HttpError(404, 'Backup não encontrado');
  return abs;
}

/** Backups do banco: só administradores (o arquivo contém hashes de senha e chaves das estações). */
export async function backupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', async (req) => requireAdmin(req));
  // Uma chave de API vazada não deve poder baixar o banco inteiro.
  app.addHook('preHandler', async (req) => {
    if (req.viaApiKey) throw new HttpError(403, 'Backups só podem ser acessados pelo painel (com login).');
  });

  app.get('/api/backups', async () => ({ keep: getKeepBackups(), min: MIN_KEEP_BACKUPS, max: MAX_KEEP_BACKUPS, backups: listBackups() }));

  // Quantos backups guardar. Diminuir apaga já os mais antigos além do novo limite.
  app.put('/api/backups/settings', async (req) => {
    const b = z.object({ keep: z.number().int().min(MIN_KEEP_BACKUPS).max(MAX_KEEP_BACKUPS) }).parse(req.body);
    setKeepBackups(b.keep);
    pruneBackups();
    return { keep: getKeepBackups(), min: MIN_KEEP_BACKUPS, max: MAX_KEEP_BACKUPS, backups: listBackups() };
  });

  app.post('/api/backups', async (_req, reply) => reply.code(201).send(createBackup()));

  /**
   * Recebe um arquivo de backup baixado de OUTRO servidor (ex.: para levar as configurações para uma instalação nova).
   * Só confere e guarda na lista; quem substitui o banco é o "Restaurar", como nos demais backups.
   */
  app.post('/api/backups/upload', async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!part) throw new HttpError(400, 'Envie o arquivo do backup (.db)');
    fs.mkdirSync(backupsDir, { recursive: true });
    const tmp = path.join(backupsDir, `upload-${crypto.randomUUID()}.tmp`);
    try {
      await pipeline(part.file, fs.createWriteStream(tmp, { mode: 0o600 }));
      if (part.file.truncated) throw new HttpError(413, `Arquivo grande demais (máximo ${MAX_UPLOAD / 1048576} MB)`);
      try {
        validateBackupFile(tmp);
      } catch (e) {
        throw new HttpError(422, `Esse arquivo não é um backup válido do RadioForge: ${(e as Error).message}`);
      }
      const name = newBackupName();
      fs.renameSync(tmp, path.join(backupsDir, name));
      pruneBackups();
      return reply.code(201).send({ name, size: fs.statSync(path.join(backupsDir, name)).size, createdAt: new Date().toISOString() });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  app.get('/api/backups/:file', async (req, reply) => {
    const abs = backupFile(fileParam.parse(req.params).file);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', fs.statSync(abs).size)
      .header('Content-Disposition', `attachment; filename="${path.basename(abs)}"`)
      .send(fs.createReadStream(abs));
  });

  /**
   * Restaura o banco a partir de um backup. Antes, guarda uma cópia do banco atual (aparece na lista).
   * A troca acontece no reinício: a API se encerra em seguida e o Docker a sobe de novo.
   */
  app.post('/api/backups/:file/restore', async (req) => {
    const abs = backupFile(fileParam.parse(req.params).file);
    try {
      validateBackupFile(abs);
    } catch (e) {
      throw new HttpError(422, `Backup inválido: ${(e as Error).message}`);
    }
    stageRestore(abs); // antes da cópia de segurança: ela pode podar backups antigos, inclusive este
    const safety = createBackup();
    console.log(`[restore] agendada a partir de ${path.basename(abs)}; cópia de segurança: ${safety.name}`);
    // Dá tempo de a resposta chegar; o SIGTERM passa pelo desligamento normal (para as estações).
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1500).unref();
    return { ok: true, safetyBackup: safety.name };
  });

  app.delete('/api/backups/:file', async (req) => {
    fs.rmSync(backupFile(fileParam.parse(req.params).file), { force: true });
    return { ok: true };
  });
}
