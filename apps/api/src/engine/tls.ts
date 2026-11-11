import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import acme from 'acme-client';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { setTlsContext } from './portfront.js';

/**
 * Certificado HTTPS (Let's Encrypt) para as portas das estações (https://dominio:8070/stream). O painel pede e renova o
 * certificado sozinho, provando o domínio pelo desafio HTTP-01 (o Let's Encrypt acessa http://dominio/.well-known/acme-challenge/...,
 * que chega a este painel pelo mesmo caminho dos links /listen).
 */
const dir = () => path.join(config.dataDir, 'certs');
const file = (n: string) => path.join(dir(), n);

const setting = (k: string) => get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', k)?.value ?? '';
const save = (k: string, v: string) => run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);

/** Respostas aos desafios HTTP-01 em andamento (token -> chave de autorização). */
export const acmeTokens = new Map<string, string>();

export interface TlsInfo {
  hosts: string[];
  email: string;
  issued: boolean;
  notAfter: string | null;
  daysLeft: number | null;
  lastError: string;
  lastOkAt: string;
  busy: boolean;
}

let busy = false;

export function tlsSettings() {
  return {
    hosts: setting('tls_hosts').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
    email: setting('tls_email'),
    staging: process.env.ACME_STAGING === 'true',
  };
}

export function saveTlsSettings(hosts: string[], email: string) {
  save('tls_hosts', hosts.join(','));
  save('tls_email', email.trim());
}

function readCert(): { cert: string; key: string; notAfter: Date } | null {
  try {
    const cert = fs.readFileSync(file('cert.pem'), 'utf8');
    const key = fs.readFileSync(file('key.pem'), 'utf8');
    return { cert, key, notAfter: new Date(new crypto.X509Certificate(cert).validTo) };
  } catch {
    return null;
  }
}

export function tlsInfo(): TlsInfo {
  const s = tlsSettings();
  const c = readCert();
  return {
    hosts: s.hosts,
    email: s.email,
    issued: !!c,
    notAfter: c ? c.notAfter.toISOString() : null,
    daysLeft: c ? Math.floor((c.notAfter.getTime() - Date.now()) / 86_400_000) : null,
    lastError: setting('tls_last_error'),
    lastOkAt: setting('tls_last_ok'),
    busy,
  };
}

/** Coloca o certificado salvo em uso nas portas das estações. */
export function loadTls(): boolean {
  const c = readCert();
  if (!c || c.notAfter.getTime() < Date.now()) {
    setTlsContext(null);
    return false;
  }
  setTlsContext(tls.createSecureContext({ cert: c.cert, key: c.key }));
  return true;
}

/** Pede (ou renova) o certificado para os domínios salvos. Lança erro com o motivo se falhar. */
export async function issueTls(): Promise<void> {
  const s = tlsSettings();
  if (s.hosts.length === 0) throw new Error('Informe pelo menos um domínio.');
  if (busy) throw new Error('Já há uma emissão em andamento.');
  busy = true;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    let accountKey: string;
    try {
      accountKey = fs.readFileSync(file('account.key'), 'utf8');
    } catch {
      accountKey = (await acme.crypto.createPrivateKey()).toString();
      fs.writeFileSync(file('account.key'), accountKey, { mode: 0o600 });
    }
    const client = new acme.Client({ directoryUrl: s.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production, accountKey });
    const [key, csr] = await acme.crypto.createCsr({ commonName: s.hosts[0], altNames: s.hosts.slice(1) });
    const cert = await client.auto({
      csr,
      email: s.email || undefined,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        acmeTokens.set(challenge.token, keyAuthorization);
      },
      challengeRemoveFn: async (_authz, challenge) => {
        acmeTokens.delete(challenge.token);
      },
    });
    fs.writeFileSync(file('key.pem'), key.toString(), { mode: 0o600 });
    fs.writeFileSync(file('cert.pem'), cert);
    save('tls_last_error', '');
    save('tls_last_ok', new Date().toISOString());
    loadTls();
  } catch (e) {
    const msg = (e as Error).message || 'falha ao emitir o certificado';
    save('tls_last_error', msg.slice(0, 500));
    throw new Error(msg);
  } finally {
    busy = false;
  }
}

/** Ao subir: carrega o certificado salvo; todo dia confere a validade e renova quando faltar menos de 30 dias. */
export function startTlsRenewal() {
  loadTls();
  const check = () => {
    const i = tlsInfo();
    if (i.hosts.length === 0) return;
    if (!i.issued || (i.daysLeft ?? 0) < 30) void issueTls().catch((e) => console.error('[tls] renovação falhou:', (e as Error).message));
  };
  setTimeout(check, 60_000).unref();
  setInterval(check, 24 * 3600_000).unref();
}
