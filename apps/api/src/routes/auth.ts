import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError } from '../auth.js';
import { get, run, type UserRow } from '../db.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Senha precisa ter ao menos 8 caracteres'),
});

// Limite simples de tentativas de login: 10 por minuto por IP (em memória).
const attempts = new Map<string, { count: number; resetAt: number }>();
function throttleLogin(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return;
  }
  if (++a.count > 10) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto.');
}

const publicUser =(u: UserRow) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export async function authRoutes(app: FastifyInstance) {
  // Primeiro acesso: indica se ainda é preciso criar o administrador.
  app.get('/api/setup/status', async () => {
    const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    return { needsSetup: (row?.n ?? 0) === 0 };
  });

  app.post('/api/setup', async (req, reply) => {
    const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    if ((row?.n ?? 0) > 0) throw new HttpError(409, 'Instalação já concluída');
    const body = credentials.extend({ name: z.string().min(1) }).parse(req.body);
    const hash = await bcrypt.hash(body.password, 12);
    const r = run(
      "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, 'admin')",
      body.email.toLowerCase(),
      body.name,
      hash,
    );
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid))!;
    const token = app.jwt.sign({ id: user.id, role: user.role }, { expiresIn: '7d' });
    return reply.code(201).send({ token, user: publicUser(user) });
  });

  app.post('/api/auth/login', async (req) => {
    throttleLogin(req.ip);
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user = get<UserRow>('SELECT * FROM users WHERE email = ?', body.email.toLowerCase());
    const ok = user ? await bcrypt.compare(body.password, user.password_hash) : false;
    if (!user || !ok) throw new HttpError(401, 'E-mail ou senha inválidos');
    const token = app.jwt.sign({ id: user.id, role: user.role }, { expiresIn: '7d' });
    return { token, user: publicUser(user) };
  });

  app.get('/api/me', { preHandler: authenticate }, async (req) => {
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!user) throw new HttpError(401, 'Usuário não existe mais');
    return publicUser(user);
  });
}
