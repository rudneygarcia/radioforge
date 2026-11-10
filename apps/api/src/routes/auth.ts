import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError } from '../auth.js';
import { config } from '../config.js';
import { get, run, type UserRow } from '../db.js';
import { sendMail, smtpConfigured } from '../mailer.js';

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

// Recuperação de senha: no máximo 5 pedidos por hora por IP e por e-mail (em memória).
const forgotHits = new Map<string, { count: number; resetAt: number }>();
function throttleForgot(key: string) {
  const now = Date.now();
  const a = forgotHits.get(key);
  if (!a || a.resetAt < now) {
    forgotHits.set(key, { count: 1, resetAt: now + 3600_000 });
    return;
  }
  if (++a.count > 5) throw new HttpError(429, 'Muitos pedidos de recuperação. Tente de novo em uma hora.');
}
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  // Esqueci a senha: manda um link (válido por 1 hora) para o e-mail cadastrado. A resposta é sempre a mesma, exista o e-mail ou não.
  app.get('/api/auth/forgot/status', async () => ({ emailEnabled: smtpConfigured() }));

  app.post('/api/auth/forgot', async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const addr = email.toLowerCase();
    throttleForgot(`ip:${req.ip}`);
    throttleForgot(`mail:${addr}`);
    if (!smtpConfigured()) throw new HttpError(503, 'O envio de e-mail não está configurado neste painel. Peça ao administrador para configurar em Sistema → E-mail.');
    const generic = { ok: true, message: 'Se o e-mail estiver cadastrado, enviamos um link para criar uma nova senha. Confira também o spam.' };
    const user = get<UserRow>('SELECT * FROM users WHERE email = ?', addr);
    if (!user) return generic;
    const token = crypto.randomBytes(32).toString('base64url');
    run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', user.id); // só o último link vale
    run("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))", user.id, sha(token));
    const link = `${config.publicOrigin}/reset?token=${token}`;
    try {
      await sendMail(
        user.email,
        'Recuperação de senha - RadioForge',
        `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto"><h2>Olá, ${esc(user.name)}!</h2><p>Recebemos um pedido para criar uma nova senha no RadioForge. Clique no botão abaixo (o link vale por 1 hora):</p><p><a href="${link}" style="background:#6d7cff;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;display:inline-block">Criar nova senha</a></p><p style="color:#666;font-size:13px">Se o botão não funcionar, copie este endereço no navegador:<br>${link}</p><p style="color:#666;font-size:13px">Se não foi você, ignore este e-mail: sua senha continua a mesma.</p></div>`,
        `Olá, ${user.name}! Para criar uma nova senha no RadioForge, abra o link (vale por 1 hora): ${link}\nSe não foi você, ignore este e-mail.`,
      );
    } catch (e) {
      console.error('[senha] falha ao enviar o e-mail de recuperação:', (e as Error).message);
      throw new HttpError(502, 'Não foi possível enviar o e-mail agora. Tente mais tarde ou fale com o administrador.');
    }
    return generic;
  });

  app.post('/api/auth/reset', async (req) => {
    throttleLogin(req.ip);
    const b = z.object({ token: z.string().min(20).max(200), password: z.string().min(8, 'Senha precisa ter ao menos 8 caracteres').max(200) }).parse(req.body);
    const row = get<{ id: number; user_id: number }>("SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')", sha(b.token));
    if (!row) throw new HttpError(400, 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".');
    const hash = await bcrypt.hash(b.password, 12);
    run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
    run('UPDATE password_resets SET used = 1 WHERE user_id = ?', row.user_id);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: authenticate }, async (req) => {
    const user = get<UserRow>('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!user) throw new HttpError(401, 'Usuário não existe mais');
    return publicUser(user);
  });
}
