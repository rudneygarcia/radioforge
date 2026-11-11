import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Host da requisição em andamento (preenchido em index.ts). */
export const hostContext = new AsyncLocalStorage<{ host: string; origin: string }>();

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
fs.mkdirSync(path.join(dataDir, '.secrets'), { recursive: true });

/** Lê o segredo do ambiente ou gera e persiste um aleatório no primeiro boot. */
function secret(envName: string, file: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const p = path.join(dataDir, '.secrets', file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const value = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(p, value, { mode: 0o600 });
  return value;
}

export const config = {
  dataDir,
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  jwtSecret: secret('JWT_SECRET', 'jwt'),
  /** Token que o Liquidsoap usa para avisar a API sobre troca de faixa. */
  internalToken: secret('INTERNAL_TOKEN', 'internal'),
  /**
   * Host público usado nas URLs de stream mostradas aos ouvintes. Se PUBLIC_HOST não for definido,
   * usa o endereço (IP ou domínio) pelo qual o painel foi acessado nesta requisição.
   */
  get publicHost(): string {
    return process.env.PUBLIC_HOST || hostContext.getStore()?.host || 'localhost';
  },
  /** Origem (https://dominio) pela qual o painel foi aberto; usada nos links de stream que passam pelo painel (funcionam atrás de proxy/Cloudflare). */
  get publicOrigin(): string {
    // PUBLIC_ORIGIN (ex.: https://stm.seudominio.com.br) fixa o endereço dos links mostrados, qualquer que seja o endereço pelo qual o painel foi aberto.
    return (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '') || hostContext.getStore()?.origin || `http://localhost:${process.env.PORT ?? 3000}`;
  },
  apiInternalUrl: process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
  engine: {
    enabled: (process.env.ENGINE_ENABLED ?? 'true') === 'true',
    /** auto = usa Icecast+Liquidsoap se estiverem instalados; senão, o motor simples em Node. */
    mode: (process.env.ENGINE_MODE ?? 'auto') as 'auto' | 'liquidsoap' | 'native',
    icecastBin: process.env.ICECAST_BIN ?? 'icecast2',
    liquidsoapBin: process.env.LIQUIDSOAP_BIN ?? 'liquidsoap',
    streamPortStart: Number(process.env.STREAM_PORT_START ?? 8000),
    streamPortEnd: Number(process.env.STREAM_PORT_END ?? 8499),
  },
  /** Só para desenvolvimento/testes: permite webhooks para endereços privados (desliga a proteção SSRF). */
  webhooksAllowPrivate: (process.env.WEBHOOK_ALLOW_PRIVATE ?? 'false') === 'true',
  webDir: process.env.WEB_DIR ?? path.resolve('../web/dist'),
};

export const stationDir = (id: number) => path.join(dataDir, 'stations', String(id));
