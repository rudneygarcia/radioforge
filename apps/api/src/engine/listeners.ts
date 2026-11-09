import type { StationRow } from '../db.js';
import { mountsFor } from '../db.js';
import { classifyDevice, classifyPlayer, locateIp } from './sessions.js';

// O motor simples (native.ts) registra aqui como listar seus clientes (evita importação circular).
type NativeClient = { ip: string; ua: string; mount: string; seconds: number };
let nativeProvider: ((stationId: number) => NativeClient[] | null) | null = null;
export function setNativeClientProvider(fn: (stationId: number) => NativeClient[] | null) {
  nativeProvider = fn;
}

export interface LiveListener {
  id: string;
  ip: string;
  country: string;
  countryName: string;
  flag: string;
  player: string;
  device: string;
  os: string;
  userAgent: string;
  seconds: number;
  mount: string;
}

const xmlUnescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? xmlUnescape(m[1].trim()) : '';
};

function build(id: string, ip: string, userAgent: string, seconds: number, mount: string): LiveListener {
  const loc = locateIp(ip);
  const dev = classifyDevice(userAgent);
  return { id, ip: ip.replace(/^::ffff:/, ''), country: loc.code, countryName: loc.name, flag: loc.flag, player: classifyPlayer(userAgent), device: dev.device, os: dev.os, userAgent, seconds, mount };
}

/** Lê os ouvintes conectados de um mountpoint no Icecast (admin/listclients). */
async function listMount(st: StationRow, mount: string): Promise<LiveListener[]> {
  const auth = Buffer.from(`admin:${st.admin_password}`).toString('base64');
  const res = await fetch(`http://127.0.0.1:${st.stream_port}/admin/listclients?mount=${encodeURIComponent(mount)}`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`Icecast respondeu ${res.status}`);
  const xml = await res.text();
  const out: LiveListener[] = [];
  for (const m of xml.matchAll(/<listener>([\s\S]*?)<\/listener>/g)) {
    out.push(build(`${mount}#${tag(m[1], 'ID')}`, tag(m[1], 'IP'), tag(m[1], 'UserAgent'), Number(tag(m[1], 'Connected')) || 0, mount));
  }
  return out;
}

// ---------- Conexões que passam pelo proxy da API ----------
// Todo link do painel/player (/stream/..., player do site) passa pela API, então contamos aqui com o IP real
// (CF-Connecting-IP atrás do Cloudflare). O Icecast só precisa ser consultado para o link direto (porta do stream).
/** Marca no User-Agent enviado ao Icecast, para não contar duas vezes a mesma conexão. */
export const PROXY_MARK = 'RF-Proxy/1';

interface Conn {
  ip: string;
  ua: string;
  mount: string;
  startedAt: number;
}
const proxyConns = new Map<number, Map<number, Conn>>();
let connSeq = 0;

/** Registra uma conexão de ouvinte no proxy; devolve a função que a remove quando ela fecha. */
export function registerProxyConn(stationId: number, ip: string, ua: string, mount: string): () => void {
  const id = ++connSeq;
  let m = proxyConns.get(stationId);
  if (!m) proxyConns.set(stationId, (m = new Map()));
  m.set(id, { ip, ua, mount, startedAt: Date.now() });
  return () => void proxyConns.get(stationId)?.delete(id);
}

const cache = new Map<number, { at: number; items: LiveListener[] }>();
const errors = new Map<number, string | null>();
/** Último erro ao consultar o Icecast (null = ok). Afeta só os ouvintes do link direto. */
export const icecastError = (stationId: number): string | null => errors.get(stationId) ?? null;

/**
 * Ouvintes conectados agora (cada conexão = 1): os do proxy da API (sempre, em tempo real) + os que entram
 * direto pela porta do Icecast (consulta com cache de 4 s). No modo simples, vem do próprio motor.
 * Devolve null só no modo simples com a estação parada.
 */
export async function liveListeners(st: StationRow, engine: 'liquidsoap' | 'native'): Promise<LiveListener[] | null> {
  if (engine === 'native') {
    const c = nativeProvider?.(st.id) ?? null;
    return c ? c.map((x, i) => build(`n#${i}`, x.ip, x.ua, x.seconds, x.mount)) : null;
  }
  const now = Date.now();
  const viaProxy = [...(proxyConns.get(st.id)?.entries() ?? [])].map(([id, c]) => build(`p#${id}`, c.ip, c.ua, Math.round((now - c.startedAt) / 1000), c.mount));

  let direct: LiveListener[];
  const hit = cache.get(st.id);
  if (hit && now - hit.at < 4000) {
    direct = hit.items;
  } else {
    try {
      const mounts = [st.mount, ...mountsFor(st.id).map((m) => m.mount)];
      const all = (await Promise.all(mounts.map((m) => listMount(st, m)))).flat();
      direct = all.filter((l) => !l.userAgent.includes(PROXY_MARK)); // as do proxy já estão em viaProxy
      errors.set(st.id, null);
    } catch (e) {
      direct = [];
      errors.set(st.id, (e as Error).message || 'falha ao consultar o Icecast');
    }
    cache.set(st.id, { at: now, items: direct });
  }
  return [...viaProxy, ...direct];
}
