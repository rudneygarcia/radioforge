import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, hashKey, HttpError } from '../auth.js';
import { all, get, run } from '../db.js';

interface KeyRow {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  read_only: number;
}

export async function keyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  // Chaves não podem criar/apagar chaves: um vazamento de chave não deve gerar acesso permanente.
  app.addHook('preHandler', async (req) => {
    if (req.viaApiKey) throw new HttpError(403, 'Gerencie chaves pelo painel (com login), não por outra chave.');
  });

  app.get('/api/me/keys', async (req) =>
    all<KeyRow>(
      'SELECT id, name, prefix, created_at, last_used_at, read_only FROM api_keys WHERE user_id = ? ORDER BY id DESC',
      req.user.id,
    ).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      readOnly: !!k.read_only,
    })),
  );

  app.post('/api/me/keys', async (req, reply) => {
    const { name, readOnly } = z
      .object({ name: z.string().min(1).max(60), readOnly: z.boolean().default(false) })
      .parse(req.body);
    const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?', req.user.id);
    if ((count?.n ?? 0) >= 20) throw new HttpError(400, 'Limite de 20 chaves por usuário');
    const key = `rfk_${crypto.randomBytes(24).toString('base64url')}`;
    const r = run(
      'INSERT INTO api_keys (user_id, name, prefix, key_hash, read_only) VALUES (?, ?, ?, ?, ?)',
      req.user.id,
      name,
      key.slice(0, 10),
      hashKey(key),
      readOnly ? 1 : 0,
    );
    // A chave completa só é mostrada agora; depois só existe o hash.
    return reply.code(201).send({ id: Number(r.lastInsertRowid), name, prefix: key.slice(0, 10), readOnly, key });
  });

  app.delete('/api/me/keys/:id', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', id, req.user.id);
    return { ok: true };
  });
}
