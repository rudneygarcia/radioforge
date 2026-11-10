import crypto from 'node:crypto';
import geoip from 'geoip-country';
import geoCity from 'geoip-lite';
import { config } from '../config.js';
import { run } from '../db.js';

/** Agrupa os user-agents mais comuns em nomes legíveis. */
export function classifyPlayer(ua: string): string {
  const s = ua.toLowerCase();
  if (!s) return 'Desconhecido';
  if (s.includes('vlc')) return 'VLC';
  if (s.includes('winamp')) return 'Winamp';
  if (s.includes('itunes') || s.includes('applecoremedia')) return 'Apple (iOS/macOS)';
  if (s.includes('exoplayer') || s.includes('okhttp') || s.includes('stagefright')) return 'App Android';
  if (s.includes('edg/')) return 'Edge';
  if (s.includes('firefox')) return 'Firefox';
  if (s.includes('chrome') || s.includes('chromium')) return 'Chrome';
  if (s.includes('safari')) return 'Safari';
  if (s.includes('alexa') || s.includes('echo')) return 'Alexa';
  if (s.includes('curl') || s.includes('wget')) return 'Ferramenta (curl/wget)';
  return 'Outro';
}

export const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

const hashIp = (ip: string) => crypto.createHash('sha256').update(ip + config.internalToken).digest('hex').slice(0, 16);

function countryOf(ip: string): string {
  try {
    return geoip.lookup(ip.replace(/^::ffff:/, ''))?.country ?? '??';
  } catch {
    return '??';
  }
}

/** Grava uma sessão de escuta (o IP vira só um hash anônimo + país). */
export function recordSession(stationId: number, ip: string, userAgent: string, mount: string, startedAt: Date, durationSec: number) {
  run(
    `INSERT INTO listener_sessions (station_id, ip_hash, country, player, mount, started_at, duration)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    stationId,
    hashIp(ip),
    countryOf(ip),
    classifyPlayer(userAgent),
    mount,
    sqlTime(startedAt),
    Math.round(durationSec),
  );
}

/** Tipo de aparelho e sistema, pelo user-agent (heurística simples). */
export function classifyDevice(ua: string): { device: string; os: string } {
  const s = ua.toLowerCase();
  if (!s) return { device: 'Desconhecido', os: '—' };
  if (/alexa|echo/.test(s)) return { device: 'Alto-falante (Alexa)', os: '—' };
  if (/smart-?tv|tizen|webos|hbbtv|roku|appletv|bravia|crkey/.test(s)) return { device: 'TV', os: /tizen/.test(s) ? 'Tizen' : /webos/.test(s) ? 'webOS' : '—' };
  if (/iphone|ipod/.test(s)) return { device: 'Celular', os: 'iOS' };
  if (/ipad/.test(s)) return { device: 'Tablet', os: 'iPadOS' };
  if (/android/.test(s)) return { device: /mobile/.test(s) || /okhttp|exoplayer|stagefright/.test(s) ? 'Celular' : 'Tablet', os: 'Android' };
  if (/okhttp|exoplayer|stagefright/.test(s)) return { device: 'Celular', os: 'Android' };
  if (/applecoremedia|cfnetwork/.test(s)) return { device: 'Celular/Tablet Apple', os: 'iOS' };
  if (/windows/.test(s)) return { device: 'Computador', os: 'Windows' };
  if (/macintosh|mac os/.test(s)) return { device: 'Computador', os: 'macOS' };
  if (/cros/.test(s)) return { device: 'Computador', os: 'ChromeOS' };
  if (/linux|x11/.test(s)) return { device: 'Computador', os: 'Linux' };
  if (/vlc|winamp|foobar|mpv|ffmpeg|lavf|curl|wget/.test(s)) return { device: 'Computador / app', os: '—' };
  return { device: 'Desconhecido', os: '—' };
}

const regionNames = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
const isPrivate = (ip: string) =>
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);

/** Cidade e estado do IP (base GeoLite embutida, sem consultar serviços externos). A precisão de cidade é aproximada: é a do provedor. */
function cityOf(ip: string): { city: string; region: string } {
  try {
    const r = geoCity.lookup(ip);
    return { city: r?.city ?? '', region: r?.region ?? '' };
  } catch {
    return { city: '', region: '' };
  }
}

/** Local do IP: país (código, nome em português e bandeira) e, quando a base conhece, cidade e estado. */
export function locateIp(rawIp: string): { code: string; name: string; flag: string; city: string; region: string } {
  const ip = rawIp.replace(/^::ffff:/, '');
  if (isPrivate(ip)) return { code: 'LAN', name: 'Rede local', flag: '🏠', city: '', region: '' };
  const code = countryOf(ip);
  if (code === '??') return { code: '??', name: 'Desconhecido', flag: '🌐', city: '', region: '' };
  const { city, region } = cityOf(ip);
  let name = code;
  try {
    name = regionNames.of(code) ?? code;
  } catch {
    /* código inválido */
  }
  const flag = String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  return { code, name, flag, city, region };
}
