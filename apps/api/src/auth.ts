import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { get, run, type StationRow } from './db.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: number; role: 'admin' | 'user' };
    user: { id: number; role: 'admin' | 'user' };
  }
}
declare module 'fastify' {
  interface FastifyRequest {
    /** true quando a requisição foi autenticada por chave de API (e não por login). */
    viaApiKey?: boolean;
  }
}

export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Aceita login (JWT) ou chave de API (`Authorization: Bearer rfk_...` ou `X-API-Key: rfk_...`).
 * A chave age com as mesmas permissões do usuário que a criou.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const raw = bearer.startsWith('rfk_') ? bearer : String(req.headers['x-api-key'] ?? '');
  if (raw.startsWith('rfk_')) {
    const row = get<{ id: number; user_id: number; role: 'admin' | 'user'; read_only: number }>(
      `SELECT k.id, k.user_id, k.read_only, u.role FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`,
      hashKey(raw),
    );
    if (!row) return reply.code(401).send({ error: 'Chave de API inválida' });
    if (row.read_only && req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(403).send({ error: 'Esta chave é somente leitura' });
    }
    // Atualiza o "último uso" no máximo uma vez por minuto para não escrever a cada requisição.
    run(
      "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))",
      row.id,
    );
    req.user = { id: row.user_id, role: row.role };
    req.viaApiKey = true;
    return;
  }
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Não autenticado' });
  }
}

export function requireAdmin(req: FastifyRequest) {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Apenas administradores');
}

/** Carrega a estação e garante que o usuário (admin ou membro) pode acessá-la. */
export function stationFor(req: FastifyRequest, stationId: number): StationRow {
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!st) throw new HttpError(404, 'Estação não encontrada');
  if (req.user.role !== 'admin') {
    const member = get('SELECT 1 AS ok FROM station_members WHERE station_id = ? AND user_id = ?', st.id, req.user.id);
    if (!member) throw new HttpError(403, 'Sem acesso a esta estação');
  }
  return st;
}
