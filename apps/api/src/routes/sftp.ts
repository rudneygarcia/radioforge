import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { config } from '../config.js';
import { get, run, type StationRow } from '../db.js';
import { getSftp, sftpPort, validSftpUser } from '../engine/sftp.js';

const idParam = z.object({ id: z.coerce.number().int() });
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = () => Array.from(crypto.randomBytes(16), (b) => ALPHABET[b % ALPHABET.length]).join('');

function view(st: StationRow) {
  const c = getSftp(st.id);
  return {
    available: sftpPort() > 0,
    configured: !!c,
    enabled: !!c?.enabled,
    username: c?.username ?? '',
    password: c?.password ?? '',
    host: config.publicHost.replace(/:\d+$/, ''),
    port: sftpPort(),
  };
}

/** Acesso SFTP à biblioteca da estação (usuário e senha próprios; não dá acesso às configurações). Exige a permissão "Biblioteca". */
export async function sftpRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/sftp', async (req) => view(stationFor(req, idParam.parse(req.params).id)));

  app.put('/api/stations/:id/sftp', async (req) => {
    const st = stationFor(req, idParam.parse(req.params).id);
    const b = z
      .object({
        enabled: z.boolean().optional(),
        username: z.string().trim().toLowerCase().optional(),
        password: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres').max(64).optional(),
        regenerate: z.boolean().optional(),
      })
      .parse(req.body);
    const cur = getSftp(st.id);
    let username = b.username ?? cur?.username ?? '';
    if (!username) {
      const base = [...st.slug.toLowerCase()].filter((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-' || c === '_').join('').slice(0, 28);
      username = base.length >= 3 ? base : `radio${st.id}`;
    }
    if (!validSftpUser(username)) throw new HttpError(400, 'Usuário inválido: use de 3 a 32 caracteres (letras minúsculas, números, ponto, hífen ou sublinhado)');
    const other = get<{ station_id: number }>('SELECT station_id FROM station_sftp WHERE username = ? AND station_id <> ?', username, st.id);
    if (other) throw new HttpError(409, 'Esse usuário já é usado por outra estação');
    const password = b.password ?? (b.regenerate || !cur ? randomPassword() : cur.password);
    const enabled = b.enabled ?? cur?.enabled ?? 1;
    run(
      `INSERT INTO station_sftp (station_id, username, password, enabled) VALUES (?, ?, ?, ?)
       ON CONFLICT(station_id) DO UPDATE SET username = excluded.username, password = excluded.password, enabled = excluded.enabled`,
      st.id,
      username,
      password,
      enabled ? 1 : 0,
    );
    return view(st);
  });
}
