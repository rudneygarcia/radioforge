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
  const m = new RegExp(`<${name}>([\s\S]*?)</${name}>`).exec(block);
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

const cache = new Map<number, { at: number; items: LiveListener[] | null }>();

/**
 * Ouvintes conectados agora (cada conexão = 1). Vem do Icecast ou, no modo simples, do próprio motor.
 * Devolve null se não for possível ler (estação parada ou Icecast fora do ar). Cache de 4 s.
 */
export async function liveListeners(st: StationRow, engine: 'liquidsoap' | 'native'): Promise<LiveListener[] | null> {
  if (engine === 'native') {
    const c = nativeProvider?.(st.id) ?? null;
    return c ? c.map((x, i) => build(`n#${i}`, x.ip, x.ua, x.seconds, x.mount)) : null;
  }
  const hit = cache.get(st.id);
  if (hit && Date.now() - hit.at < 4000) return hit.items;
  let items: LiveListener[] | null = null;
  try {
    const mounts = [st.mount, ...mountsFor(st.id).map((m) => m.mount)];
    items = (await Promise.all(mounts.map((m) => listMount(st, m)))).flat();
  } catch {
    items = null;
  }
  cache.set(st.id, { at: Date.now(), items });
  return items;
}
