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

/**
 * Permissões do operador, marcadas pelo administrador no cadastro do usuário. O administrador tem todas.
 * `padrao`: vale para operadores antigos (sem permissões salvas), que já podiam isso antes deste recurso.
 */
export const PERMISSIONS = [
  { key: 'control', label: 'Controlar a rádio', hint: 'Ligar, desligar, reiniciar, derrubar o ao vivo e tocar a hora certa agora', padrao: true },
  { key: 'media', label: 'Biblioteca', hint: 'Enviar, editar, mover e excluir músicas e pastas', padrao: true },
  { key: 'playlists', label: 'Playlists', hint: 'Criar, editar e excluir playlists e agendamentos', padrao: true },
  { key: 'ads', label: 'Comerciais', hint: 'Ver e gerenciar os blocos de comerciais', padrao: true },
  { key: 'djs', label: 'DJs', hint: 'Cadastrar, editar e excluir os DJs do ao vivo e seus horários', padrao: true },
  { key: 'reports', label: 'Relatórios', hint: 'Ver os relatórios de ouvintes e de execução', padrao: true },
  { key: 'requests', label: 'Cancelar pedidos', hint: 'Cancelar pedidos de música dos ouvintes', padrao: false },
  { key: 'edit_station', label: 'Editar a estação e configurações', hint: 'Nome, portas, streams, AutoDJ, capa e demais configurações', padrao: false },
  { key: 'stereo', label: 'Preset do Stereo Tool', hint: 'Enviar e escolher o preset do Stereo Tool desta estação (a licença e ligar ou desligar ficam com o administrador)', padrao: false },
  { key: 'advanced', label: 'Ajustes avançados', hint: 'Hora certa (áudios), presets do Stereo Tool e log do Liquidsoap', padrao: false },
] as const;
export type Permission = (typeof PERMISSIONS)[number]['key'];

/** Permissões de um usuário: administrador = todas; operador sem lista salva = as que já tinha antes. */
export function userPermissions(userId: number, role: string): Permission[] {
  if (role === 'admin') return PERMISSIONS.map((p) => p.key);
  const row = get<{ permissions: string | null }>('SELECT permissions FROM users WHERE id = ?', userId);
  if (row?.permissions) {
    try {
      const list = JSON.parse(row.permissions) as string[];
      return PERMISSIONS.filter((p) => list.includes(p.key)).map((p) => p.key);
    } catch {
      /* lista corrompida: cai no padrão */
    }
  }
  return PERMISSIONS.filter((p) => p.padrao).map((p) => p.key);
}

export function requirePerm(req: FastifyRequest, perm: Permission) {
  if (req.user.role === 'admin') return;
  if (!userPermissions(req.user.id, req.user.role).includes(perm)) throw new HttpError(403, 'Você não tem permissão para esta ação');
}

/** Qual permissão cada rota da estação exige (leitura de biblioteca, playlists e pedidos fica aberta aos operadores da estação). */
function neededPermission(method: string, route: string): Permission | null {
  const prefix = '/api/stations/:id';
  if (!route.startsWith(prefix)) return null;
  const seg = route.slice(prefix.length).split('/')[1] ?? '';
  const write = method !== 'GET' && method !== 'HEAD';
  switch (seg) {
    case '':
      return method === 'PUT' ? 'edit_station' : null; // criar e excluir estação continuam só com o administrador
    case 'cover':
      return 'edit_station';
    case 'start':
    case 'stop':
    case 'restart':
    case 'live':
      return 'control';
    case 'time-announce':
      return write ? 'control' : null;
    case 'media':
    case 'folders':
    case 'sftp':
      return write || seg === 'sftp' ? 'media' : null;
    case 'playlists':
      return write ? 'playlists' : null;
    case 'djs':
      return 'djs';
    case 'ad-blocks':
    case 'ad-plays':
    case 'ad-vinhetas':
      return 'ads';
    case 'reports':
      return 'reports';
    case 'requests':
      return write ? 'requests' : null;
    case 'time-clips':
      return write ? 'advanced' : null;
    case 'stereotool':
      return write ? 'stereo' : null;
    case 'engine-log':
      return 'advanced';
    default:
      return null;
  }
}

/** Carrega a estação e garante que o usuário (admin ou membro) pode acessá-la e fazer o que a rota pede. */
export function stationFor(req: FastifyRequest, stationId: number): StationRow {
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!st) throw new HttpError(404, 'Estação não encontrada');
  if (req.user.role !== 'admin') {
    const member = get('SELECT 1 AS ok FROM station_members WHERE station_id = ? AND user_id = ?', st.id, req.user.id);
    if (!member) throw new HttpError(403, 'Sem acesso a esta estação');
    const need = neededPermission(req.method, req.routeOptions?.url ?? '');
    if (need) requirePerm(req, need);
  }
  return st;
}
