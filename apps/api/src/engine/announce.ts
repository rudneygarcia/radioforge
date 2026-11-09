import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { stationDir } from '../config.js';
import { all, type StationRow } from '../db.js';
import { getLive } from './nowplaying.js';
import { engineMode, isRunning, pushRequest } from './manager.js';
import { clipFor, clipPath, slotLabel } from './timeclips.js';

/**
 * "Hora certa": a cada 15/30/60 min o AutoDJ avisa a hora com voz sintética (espeak-ng, português do Brasil).
 * O áudio é gerado na primeira vez e guardado em cache (data/stations/<id>/announce). O aviso entra na fila de
 * pedidos, toca ao fim da música atual e não aparece em "Tocando agora", histórico nem webhooks (como vinheta).
 */

const HOURS = [
  'meia-noite', 'uma hora', 'duas horas', 'três horas', 'quatro horas', 'cinco horas', 'seis horas', 'sete horas', 'oito horas',
  'nove horas', 'dez horas', 'onze horas', 'meio-dia', 'treze horas', 'catorze horas', 'quinze horas', 'dezesseis horas',
  'dezessete horas', 'dezoito horas', 'dezenove horas', 'vinte horas', 'vinte e uma horas', 'vinte e duas horas', 'vinte e três horas',
];
const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta'];

function minutesWords(m: number): string {
  if (m < 20) return UNITS[m];
  const t = Math.floor(m / 10);
  const u = m % 10;
  return u ? `${TENS[t]} e ${UNITS[u]}` : TENS[t];
}

/** Texto falado, ex.: "Hora certa. São catorze horas e meia." (números por extenso para a voz não errar o gênero). */
export function timeText(hour: number, minute: number): string {
  const h = HOURS[hour % 24];
  const verb = hour === 1 ? 'É' : hour === 0 || hour === 12 ? 'É' : 'São';
  let text = `${verb} ${h}`;
  if (minute === 30) text += ' e meia';
  else if (minute > 0) text += ` e ${minutesWords(minute)} ${minute === 1 ? 'minuto' : 'minutos'}`;
  return `Hora certa. ${text}.`;
}

/** Hora e minuto atuais no fuso da estação (ex.: America/Sao_Paulo). */
export function localTime(timezone: string, at = new Date()): { hour: number; minute: number; key: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { hour, minute, key: `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}` };
}

export const isValidTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const announceDir = (stationId: number) => path.join(stationDir(stationId), 'announce');

/** Gera o áudio da fala (WAV) com o espeak-ng. TTS_BIN/TTS_PREFIX só existem para testes. */
function synthesize(text: string, outFile: string): Promise<void> {
  const bin = process.env.TTS_BIN ?? 'espeak-ng';
  const prefix: string[] = process.env.TTS_PREFIX ? (JSON.parse(process.env.TTS_PREFIX) as string[]) : [];
  // -v pt-br: português do Brasil · -s: palavras por minuto · -a: volume (0-200) · -w: grava em arquivo
  const args = [...prefix, '-v', 'pt-br', '-s', '150', '-a', '190', '-w', outFile, text];
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15_000 }, (err) => {
      if (err) reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'O gerador de voz (espeak-ng) não está instalado neste servidor' : err.message));
      else resolve();
    });
  });
}

/** Caminho do áudio da hora/minuto indicados, gerando-o se ainda não existir. */
export async function ensureClip(stationId: number, hour: number, minute: number): Promise<string> {
  fs.mkdirSync(announceDir(stationId), { recursive: true });
  const file = path.join(announceDir(stationId), `${String(hour).padStart(2, '0')}-${String(minute).padStart(2, '0')}.wav`);
  if (!fs.existsSync(file) || fs.statSync(file).size < 100) await synthesize(timeText(hour, minute), file);
  return file;
}

/**
 * Escolhe o áudio certo para o horário: 1) o arquivo enviado pelo usuário para exatamente esse horário;
 * 2) se não houver e a voz sintética estiver ligada, a voz; 3) senão, nada (não avisa).
 */
export async function resolveClip(st: StationRow, hour: number, minute: number): Promise<{ file: string; source: 'arquivo' | 'voz' } | null> {
  const clip = clipFor(st.id, hour, minute);
  if (clip && fs.existsSync(clipPath(clip))) return { file: clipPath(clip), source: 'arquivo' };
  if (st.time_announce_voice) return { file: await ensureClip(st.id, hour, minute), source: 'voz' };
  return null;
}

/** Enfileira o aviso agora (hora atual do fuso da estação). */
export async function announceNow(st: StationRow, at = new Date()): Promise<{ text: string; source: 'arquivo' | 'voz' }> {
  const { hour, minute } = localTime(st.timezone, at);
  const clip = await resolveClip(st, hour, minute);
  if (!clip) throw new Error(`Não há arquivo de áudio para ${slotLabel(hour, minute)} e a voz sintética está desligada`);
  await pushRequest(st.id, clip.file, true);
  return { text: clip.source === 'voz' ? timeText(hour, minute) : `arquivo das ${slotLabel(hour, minute)}`, source: clip.source };
}

const lastSlot = new Map<number, string>();

/** Chamado a cada ~30 s: quando vira uma marca (ex.: :00 e :30), enfileira o aviso uma única vez. */
export async function tickAnnouncements(now = new Date()) {
  if (engineMode() !== 'liquidsoap') return; // o motor simples só toca MP3
  for (const st of all<StationRow>('SELECT * FROM stations WHERE time_announce > 0')) {
    if (!isRunning(st.id)) continue;
    const t = localTime(st.timezone, now);
    if (t.minute % st.time_announce !== 0 || lastSlot.get(st.id) === t.key) continue;
    lastSlot.set(st.id, t.key);
    if (getLive(st.id)) continue; // DJ no ar: não interrompe a transmissão
    try {
      await announceNow(st, now);
    } catch (e) {
      console.error(`[hora certa] ${st.slug}:`, (e as Error).message);
    }
  }
}
