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
  /** De onde veio o certificado em uso: 'lets-encrypt' (emitido pelo painel), 'manual' (colado) ou 'traefik' (lido do acme.json do Traefik). */
  source: string;
  /** Caminho do acme.json do Traefik, se configurado (TRAEFIK_ACME_JSON). */
  traefikFile: string;
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
    source: setting('tls_source'),
    traefikFile: process.env.TRAEFIK_ACME_JSON ?? '',
  };
}

/** Valida e instala um certificado (PEM): a chave tem que combinar e o domínio configurado tem que estar coberto. */
export function installPem(certPem: string, keyPem: string, source: 'manual' | 'traefik') {
  const cert = certPem.trim() + '\n';
  const key = keyPem.trim() + '\n';
  let x: crypto.X509Certificate;
  try {
    x = new crypto.X509Certificate(cert);
  } catch {
    throw new Error('O certificado (PEM) é inválido. Cole o certificado completo, começando com -----BEGIN CERTIFICATE-----.');
  }
  let k: crypto.KeyObject;
  try {
    k = crypto.createPrivateKey(key);
  } catch {
    throw new Error('A chave privada (PEM) é inválida.');
  }
  if (!x.checkPrivateKey(k)) throw new Error('A chave privada não combina com este certificado.');
  if (new Date(x.validTo).getTime() < Date.now()) throw new Error('Este certificado já venceu.');
  const hosts = tlsSettings().hosts;
  if (hosts.length > 0 && !hosts.some((h) => x.checkHost(h))) throw new Error('Este certificado não cobre o(s) domínio(s) informado(s): ' + hosts.join(', ') + '.');
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file('key.pem'), key, { mode: 0o600 });
  fs.writeFileSync(file('cert.pem'), cert);
  save('tls_source', source);
  save('tls_last_error', '');
  save('tls_last_ok', new Date().toISOString());
  loadTls();
}

/** Lê o certificado do domínio direto do acme.json do Traefik (o Velix emite lá); precisa de o arquivo estar montado neste contêiner. */
export function importFromTraefik(acmeJson: string): boolean {
  const hosts = tlsSettings().hosts;
  if (hosts.length === 0) throw new Error('Informe o domínio antes.');
  const data = JSON.parse(fs.readFileSync(acmeJson, 'utf8')) as Record<string, { Certificates?: { domain?: { main?: string; sans?: string[] }; certificate: string; key: string }[] }>;
  for (const resolver of Object.values(data)) {
    for (const c of resolver?.Certificates ?? []) {
      const names = [c.domain?.main, ...(c.domain?.sans ?? [])].filter(Boolean).map((n) => String(n).toLowerCase());
      if (!hosts.some((h) => names.includes(h) || names.some((n) => n.startsWith('*.') && h.endsWith(n.slice(1))))) continue;
      installPem(Buffer.from(c.certificate, 'base64').toString('utf8'), Buffer.from(c.key, 'base64').toString('utf8'), 'traefik');
      return true;
    }
  }
  return false;
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

/**
 * O domínio chega a ESTE painel pela porta 80? Testa com um desafio falso (sem gastar o limite do Let's Encrypt).
 * true = chega; false = não chega (DNS errado, outro servidor, porta 80 fechada); null = redirecionou (não dá para saber, deixa o Let's Encrypt decidir).
 */
async function reachesPanel(host: string): Promise<boolean | null> {
  const token = `probe-${crypto.randomBytes(8).toString('hex')}`;
  const value = crypto.randomBytes(8).toString('hex');
  acmeTokens.set(token, value);
  try {
    const r = await fetch(`http://${host}/.well-known/acme-challenge/${token}`, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
    if (r.status >= 300 && r.status < 400) return null;
    return r.status === 200 && (await r.text()).trim() === value;
  } catch {
    return false;
  } finally {
    acmeTokens.delete(token);
  }
}

/** Pede (ou renova) o certificado para os domínios salvos. Lança erro com o motivo se falhar. */
export async function issueTls(): Promise<void> {
  const s = tlsSettings();
  if (s.hosts.length === 0) throw new Error('Informe pelo menos um domínio.');
  if (busy) throw new Error('Já há uma emissão em andamento.');
  busy = true;
  try {
    // Com vários domínios, um domínio errado derrubaria a emissão de todos. Testa antes e emite só para os que chegam
    // ao painel (o resto é avisado). Se nenhum passar no teste (ex.: o servidor não alcança o próprio IP), tenta todos como antes.
    let hosts = s.hosts;
    let skipped: string[] = [];
    if (hosts.length > 1) {
      const res = await Promise.all(hosts.map(reachesPanel));
      const ok = hosts.filter((_, i) => res[i] !== false);
      if (ok.length > 0 && ok.length < hosts.length) {
        skipped = hosts.filter((_, i) => res[i] === false);
        hosts = ok;
      }
    }
    fs.mkdirSync(dir(), { recursive: true });
    let accountKey: string;
    try {
      accountKey = fs.readFileSync(file('account.key'), 'utf8');
    } catch {
      accountKey = (await acme.crypto.createPrivateKey()).toString();
      fs.writeFileSync(file('account.key'), accountKey, { mode: 0o600 });
    }
    const client = new acme.Client({ directoryUrl: s.staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production, accountKey });
    const [key, csr] = await acme.crypto.createCsr({ commonName: hosts[0], altNames: hosts.slice(1) });
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
    // Domínios que não chegaram ao painel ficam de fora do certificado e aparecem como aviso (o resto já funciona).
    save('tls_last_error', skipped.length ? `Certificado emitido, mas SEM: ${skipped.join(', ')} (não chegam a este painel pela porta 80; confira o DNS e se o domínio aponta para este servidor).` : '');
    save('tls_last_ok', new Date().toISOString());
    save('tls_source', 'lets-encrypt');
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
    // Se o acme.json do Traefik estiver acessível (TRAEFIK_ACME_JSON), usa o certificado que o Velix já emitiu e mantém atualizado.
    if (i.traefikFile) {
      try {
        if (importFromTraefik(i.traefikFile)) return;
      } catch (e) {
        console.error('[tls] acme.json do Traefik:', (e as Error).message);
      }
    }
    if (i.source === 'manual' && i.issued && (i.daysLeft ?? 0) >= 3) return; // certificado colado à mão: não troca sozinho
    if (!i.issued || (i.daysLeft ?? 0) < 30) void issueTls().catch((e) => console.error('[tls] renovação falhou:', (e as Error).message));
  };
  setTimeout(check, 60_000).unref();
  setInterval(check, 24 * 3600_000).unref();
}
