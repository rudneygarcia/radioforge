import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, PERMISSIONS, requireAdmin, userPermissions } from '../auth.js';
import { all, get, run, type UserRow } from '../db.js';

const idParam = z.object({ id: z.coerce.number().int() });

const createUser = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
  role: z.enum(['admin', 'user']).default('user'),
  stationIds: z.array(z.number().int()).default([]),
  permissions: z.array(z.enum(PERMISSIONS.map((p) => p.key) as [string, ...string[]])).optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/users', async (req) => {
    requireAdmin(req);
    const users = all<Omit<UserRow, 'password_hash'>>('SELECT id, email, name, role, created_at FROM users ORDER BY id');
    return users.map((u) => ({
      ...u,
      permissions: userPermissions(u.id, u.role),
      stationIds: all<{ station_id: number }>('SELECT station_id FROM station_members WHERE user_id = ?', u.id).map(
        (r) => r.station_id,
      ),
    }));
  });

  // Lista de permissões que o administrador pode marcar para cada operador.
  app.get('/api/users/permissions', async (req) => {
    requireAdmin(req);
    return PERMISSIONS.map((p) => ({ key: p.key, label: p.label, hint: p.hint, padrao: p.padrao }));
  });

  app.post('/api/users', async (req, reply) => {
    requireAdmin(req);
    const body = createUser.parse(req.body);
    if (get('SELECT 1 AS ok FROM users WHERE email = ?', body.email.toLowerCase()))
      throw new HttpError(409, 'E-mail já cadastrado');
    const hash = await bcrypt.hash(body.password, 12);
    const r = run(
      'INSERT INTO users (email, name, password_hash, role, permissions) VALUES (?, ?, ?, ?, ?)',
      body.email.toLowerCase(),
      body.name,
      hash,
      body.role,
      body.permissions ? JSON.stringify(body.permissions) : null,
    );
    const id = Number(r.lastInsertRowid);
    for (const sid of body.stationIds)
      run('INSERT OR IGNORE INTO station_members (station_id, user_id) VALUES (?, ?)', sid, id);
    return reply.code(201).send({ id });
  });

  app.put('/api/users/:id', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = createUser.partial().parse(req.body);
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!user) throw new HttpError(404, 'Usuário não encontrado');
    if (body.role === 'user' && user.role === 'admin') {
      const admins = get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
      if ((admins?.n ?? 0) <= 1) throw new HttpError(400, 'Não é possível rebaixar o último administrador');
    }
    run(
      'UPDATE users SET name = ?, role = ? WHERE id = ?',
      body.name ?? user.name,
      body.role ?? user.role,
      id,
    );
    if (body.permissions) run('UPDATE users SET permissions = ? WHERE id = ?', JSON.stringify(body.permissions), id);
    if (body.password) run('UPDATE users SET password_hash = ? WHERE id = ?', await bcrypt.hash(body.password, 12), id);
    if (body.stationIds) {
      run('DELETE FROM station_members WHERE user_id = ?', id);
      for (const sid of body.stationIds)
        run('INSERT OR IGNORE INTO station_members (station_id, user_id) VALUES (?, ?)', sid, id);
    }
    return { ok: true };
  });

  app.delete('/api/users/:id', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    if (id === req.user.id) throw new HttpError(400, 'Você não pode excluir a si mesmo');
    run('DELETE FROM users WHERE id = ?', id);
    return { ok: true };
  });
}
