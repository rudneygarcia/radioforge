import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin } from '../auth.js';
import { backupsDir, createBackup, KEEP_BACKUPS, listBackups, SAFE_BACKUP } from '../engine/backups.js';
import { stageRestore, validateBackupFile } from '../engine/restore.js';

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

  app.get('/api/backups', async () => ({ keep: KEEP_BACKUPS, backups: listBackups() }));

  app.post('/api/backups', async (_req, reply) => reply.code(201).send(createBackup()));

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
    const safety = createBackup();
    stageRestore(abs);
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
