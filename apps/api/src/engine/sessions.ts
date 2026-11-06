import crypto from 'node:crypto';
import geoip from 'geoip-country';
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
