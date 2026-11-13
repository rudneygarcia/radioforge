import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import type { StationRow } from '../db.js';

/**
 * Etapas extras do processador de áudio (antes do compressor/limitador): equalizador, largura estéreo e multibanda.
 * Usam só o que o Liquidsoap já traz (sem plugins externos). Como os nomes dos parâmetros mudam entre versões, cada etapa
 * tem alguns jeitos de escrever; o painel testa cada um com `liquidsoap --check` num script mínimo e usa o primeiro que
 * o Liquidsoap aceita (o resultado fica em cache). Etapa que nenhum jeito passa simplesmente não entra.
 */
export const EQ_PRESETS = {
  flat: { label: 'Neutro', bass: 0, treble: 0 },
  voice: { label: 'Voz (menos grave, mais clareza)', bass: -4, treble: 2 },
  bass: { label: 'Graves reforçados', bass: 4, treble: 0 },
  bright: { label: 'Agudos brilhantes', bass: 0, treble: 4 },
  rock: { label: 'Rock / Pop (graves e agudos)', bass: 3, treble: 3 },
} as const;
export type EqPreset = keyof typeof EQ_PRESETS;
export const WIDTHS = { normal: { label: 'Normal', value: 0 }, wide: { label: 'Mais aberto', value: 0.4 }, mono: { label: 'Mono', value: -1 } } as const;
export type Width = keyof typeof WIDTHS;

const gainFor = (db: number) => (Math.pow(10, db / 20) - 1).toFixed(3);

/** Jeitos de escrever cada etapa, do mais provável ao menos. `radio` é a variável do script. */
function eqCandidates(bass: number, treble: number): string[][] {
  const out: string[][] = [];
  const mk = (low: (g: string) => string, high: (g: string) => string) => {
    const lines: string[] = [];
    if (bass !== 0) lines.push(`radio = add(normalize = false, [radio, amplify(${gainFor(bass)}, ${low('radio')})])`);
    if (treble !== 0) lines.push(`radio = add(normalize = false, [radio, amplify(${gainFor(treble)}, ${high('radio')})])`);
    return lines;
  };
  out.push(mk((s) => `filter.iir.butterworth.low(frequency = 150., order = 2, ${s})`, (s) => `filter.iir.butterworth.high(frequency = 5000., order = 2, ${s})`));
  out.push(mk((s) => `filter.iir.butterworth.low(frequency = 150., ${s})`, (s) => `filter.iir.butterworth.high(frequency = 5000., ${s})`));
  out.push(mk((s) => `filter(freq = 150., q = 1., mode = "low", ${s})`, (s) => `filter(freq = 5000., q = 1., mode = "high", ${s})`));
  return out;
}
const widthCandidates = (w: number): string[][] => [[`radio = stereo.width(width = ${w.toFixed(2)}, radio)`], [`radio = stereo.width(${w.toFixed(2)}, radio)`]];
// Assinatura real (Liquidsoap 2.3): compress.multiband(~limit=true, ~wet=1., s, bandas). Cada banda: frequency (corte superior, crescente), attack, release, ratio, threshold, gain.
const band = (frequency: number, threshold: number, gain: number) => `{frequency = ${frequency}., attack = 30., release = 300., ratio = 3., threshold = ${threshold}., gain = ${gain}.}`;
const multibandCandidates = (): string[][] => [
  [`radio = compress.multiband(radio, [${band(200, -22, 2)}, ${band(3000, -22, 1)}, ${band(20000, -22, 1)}])`],
  [`radio = compress.multiband(limit = false, radio, [${band(200, -22, 2)}, ${band(3000, -22, 1)}, ${band(20000, -22, 1)}])`],
];

const probeFile = path.join(os.tmpdir(), 'radioforge-fx-probe.json');
const readProbe = (): Record<string, boolean> => {
  try {
    return JSON.parse(fs.readFileSync(probeFile, 'utf8')) as Record<string, boolean>;
  } catch {
    return {};
  }
};

/** O Liquidsoap aceita estas linhas? (script mínimo + --check; resultado em cache) */
function accepts(lines: string[]): boolean {
  const body = [`radio = blank()`, ...lines, `output.dummy(radio)`, ``].join('\n');
  const key = crypto.createHash('sha256').update(body).digest('hex');
  const known = readProbe();
  if (key in known) return known[key];
  const file = path.join(os.tmpdir(), `radioforge-fx-${key.slice(0, 12)}.liq`);
  let ok = false;
  try {
    fs.writeFileSync(file, body);
    const r = spawnSync(config.engine.liquidsoapBin, ['--check', file], { encoding: 'utf8', timeout: 60_000 });
    if (r.error) return false; // sem Liquidsoap aqui: não guarda (pode aparecer depois)
    ok = r.status === 0;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ok */
    }
  }
  try {
    fs.writeFileSync(probeFile, JSON.stringify({ ...known, [key]: ok }));
  } catch {
    /* só cache */
  }
  return ok;
}

const firstAccepted = (cands: string[][]): string[] | null => cands.find((c) => c.length > 0 && accepts(c)) ?? null;

export interface FxChoice {
  eq: EqPreset;
  width: Width;
  multiband: boolean;
}
export const fxOf = (st: StationRow): FxChoice => ({
  eq: (st.audio_eq in EQ_PRESETS ? st.audio_eq : 'flat') as EqPreset,
  width: (st.audio_width in WIDTHS ? st.audio_width : 'normal') as Width,
  multiband: !!st.audio_multiband,
});
export const wantsFx = (st: StationRow) => {
  const f = fxOf(st);
  return f.eq !== 'flat' || f.width !== 'normal' || f.multiband;
};

/** Linhas do script das etapas pedidas que o Liquidsoap aceita, e o que ficou de fora. */
export function resolveFx(st: StationRow): { lines: string[]; skipped: string[] } {
  const f = fxOf(st);
  const lines: string[] = [];
  const skipped: string[] = [];
  if (f.eq !== 'flat') {
    const p = EQ_PRESETS[f.eq];
    const c = firstAccepted(eqCandidates(p.bass, p.treble));
    if (c) lines.push(...c);
    else skipped.push('equalizador');
  }
  if (f.width !== 'normal') {
    const c = firstAccepted(widthCandidates(WIDTHS[f.width].value));
    if (c) lines.push(...c);
    else skipped.push('largura estéreo');
  }
  if (f.multiband) {
    const c = firstAccepted(multibandCandidates());
    if (c) lines.push(...c);
    else skipped.push('multibanda');
  }
  return { lines, skipped };
}

/** Quais etapas esta versão do Liquidsoap suporta (para a tela desabilitar o que não funciona). */
export function fxSupport() {
  return {
    eq: !!firstAccepted(eqCandidates(4, 4)),
    width: !!firstAccepted(widthCandidates(0.4)),
    multiband: !!firstAccepted(multibandCandidates()),
  };
}
