import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin } from '../auth.js';
import { getSmtp, saveSmtp, sendMail } from '../mailer.js';

const body = z.object({
  host: z.string().max(200),
  port: z.number().int().min(1).max(65535).default(587),
  user: z.string().max(200).default(''),
  /** Vazia = mantém a senha já salva. */
  pass: z.string().max(300).default(''),
  from: z.string().max(200).default(''),
  secure: z.boolean().default(false),
});

/** Configuração do envio de e-mail (SMTP), só administrador. A senha nunca volta para o navegador. */
export async function mailRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/system/smtp', async (req) => {
    requireAdmin(req);
    const c = getSmtp();
    return c
      ? { configured: true, source: c.source, host: c.host, port: c.port, user: c.user, from: c.from, secure: c.secure, passSet: !!c.pass }
      : { configured: false, source: null, host: '', port: 587, user: '', from: '', secure: false, passSet: false };
  });

  app.put('/api/system/smtp', async (req) => {
    requireAdmin(req);
    if (process.env.SMTP_HOST) throw new HttpError(409, 'O e-mail está definido por variáveis de ambiente (SMTP_HOST…): altere lá.');
    const b = body.parse(req.body);
    if (!b.host.trim()) {
      saveSmtp({ host: '' }, false);
      return { configured: false };
    }
    saveSmtp({ ...b, host: b.host.trim() }, b.pass === '');
    return { configured: true };
  });

  app.post('/api/system/smtp/test', async (req) => {
    requireAdmin(req);
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    try {
      await sendMail(to, 'Teste de e-mail do RadioForge', '<p>Se você está lendo isto, o envio de e-mail do RadioForge está funcionando. ✔</p>', 'Se você está lendo isto, o envio de e-mail do RadioForge está funcionando.');
    } catch (e) {
      throw new HttpError(502, `Não foi possível enviar: ${(e as Error).message}`);
    }
    return { ok: true };
  });
}
