import nodemailer from 'nodemailer';
import { get, run } from './db.js';

/**
 * Envio de e-mail (recuperação de senha). Configuração: variáveis de ambiente SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_FROM, SMTP_SECURE (true = SSL direto, porta 465) ou, se não houver, o que foi salvo no painel (Sistema → E-mail).
 */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

const KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'] as const;

const setting = (k: string) => get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', k)?.value ?? '';

export function saveSmtp(c: Partial<SmtpConfig>, keepPass: boolean) {
  const pairs: Record<string, string> = {
    smtp_host: c.host ?? '',
    smtp_port: String(c.port ?? 587),
    smtp_user: c.user ?? '',
    smtp_from: c.from ?? '',
    smtp_secure: c.secure ? '1' : '0',
  };
  if (!keepPass) pairs.smtp_pass = c.pass ?? '';
  for (const [k, v] of Object.entries(pairs)) {
    run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
  }
}

/** Configuração em uso (variáveis de ambiente têm prioridade sobre o salvo no painel). */
export function getSmtp(): (SmtpConfig & { source: 'env' | 'painel' }) | null {
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    return {
      host: process.env.SMTP_HOST,
      port,
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      source: 'env',
    };
  }
  const host = setting('smtp_host');
  if (!host) return null;
  const port = Number(setting('smtp_port')) || 587;
  return { host, port, user: setting('smtp_user'), pass: setting('smtp_pass'), from: setting('smtp_from') || setting('smtp_user'), secure: setting('smtp_secure') === '1', source: 'painel' };
}

export const smtpConfigured = () => getSmtp() !== null;
export const smtpKeys = KEYS;

export async function sendMail(to: string, subject: string, html: string, text: string) {
  const c = getSmtp();
  if (!c) throw new Error('O envio de e-mail não está configurado (Sistema → E-mail).');
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transport.sendMail({ from: c.from || c.user, to, subject, html, text });
}
