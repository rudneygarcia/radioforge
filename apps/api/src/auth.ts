import type { FastifyReply, FastifyRequest } from 'fastify';
import { get, type StationRow } from './db.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { id: number; role: 'admin' | 'user' };
    user: { id: number; role: 'admin' | 'user' };
  }
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
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
