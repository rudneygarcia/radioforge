import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / metadados de nuvem
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast e reservados
  );
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIPv4(v4) ? isPrivateV4(v4) : true;
  }
  return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}

export function isPrivateAddress(ip: string): boolean {
  return net.isIPv4(ip) ? isPrivateV4(ip) : isPrivateV6(ip);
}

/**
 * Garante que a URL é http(s) e aponta para um endereço público.
 * Evita que um operador use webhooks para atingir serviços internos (SSRF), como o painel do Velix
 * ou o endereço de metadados da nuvem. Resolve o DNS e confere todos os endereços retornados.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL inválida');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use uma URL http ou https');
  if (config.webhooksAllowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error('Não foi possível resolver o endereço da URL');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('A URL aponta para um endereço interno/privado, o que não é permitido');
  return url;
}
