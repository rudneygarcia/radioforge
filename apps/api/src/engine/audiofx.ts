import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import type { StationRow } from '../db.js';

/**
 * Compressor multibanda com o plugin LADSPA da LSP (`lsp-plugins-ladspa`, instalado na imagem), entre o AutoDJ/DJ e o
 * compressor/limitador do painel. 4 bandas (cortes em 120 Hz, 1 kHz e 5 kHz). Os valores de limiar e ganho do plugin são
 * LINEARES (0,08 ≈ -22 dB). Antes de usar, o painel testa o trecho num script mínimo com `liquidsoap --check`; se o plugin
 * não existir ou o Liquidsoap recusar, a etapa fica de fora e a rádio sobe normalmente.
 */
export const MB_LEVELS = [
  { level: 0, label: 'Desligado' },
  { level: 1, label: 'Suave (compressão leve, som natural)' },
  { level: 2, label: 'Forte, estilo FM (compressão firme, som cheio)' },
] as const;

const PLUGIN = 'ladspa.lsp_mb_compressor_stereo';
const f3 = (n: number) => n.toFixed(3);

function mbCandidates(level: number): string[][] {
  const p =
    level === 2
      ? { ratio: 3.5, threshold: 0.08, attack: [40, 30, 20, 10], release: [400, 300, 250, 200], makeup: [1.3, 1.2, 1.2, 1.3] }
      : { ratio: 2, threshold: 0.12, attack: [40, 30, 20, 10], release: [400, 300, 250, 200], makeup: [1.12, 1.0, 1.0, 1.12] };
  const args: string[] = ['split_frequency_1 = 120.', 'split_frequency_2 = 1000.', 'split_frequency_3 = 5000.'];
  for (let b = 1; b <= 7; b++) args.push(`compression_band_enable_${b} = ${b <= 3 ? 'true' : 'false'}`);
  for (let b = 0; b <= 3; b++) {
    args.push(
      `compressor_enable_${b} = true`,
      `ratio_${b} = ${f3(p.ratio)}`,
      `attack_threshold_${b} = ${f3(p.threshold)}`,
      `attack_time_${b} = ${f3(p.attack[b])}`,
      `release_time_${b} = ${f3(p.release[b])}`,
      `makeup_gain_${b} = ${f3(p.makeup[b])}`,
    );
  }
  return [
    [`radio = ${PLUGIN}(`, ...args.map((a) => `  ${a},`), `  radio)`],
    // Plano B: só os cortes entre as bandas e o resto no padrão do plugin.
    [`radio = ${PLUGIN}(split_frequency_1 = 120., split_frequency_2 = 1000., split_frequency_3 = 5000., radio)`],
  ];
}

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

export const multibandLevel = (st: StationRow): number => (st.audio_multiband === 1 || st.audio_multiband === 2 ? st.audio_multiband : 0);
export const wantsFx = (st: StationRow) => multibandLevel(st) > 0;

/** Linhas do script das etapas pedidas que o Liquidsoap aceita, e o que ficou de fora. */
export function resolveFx(st: StationRow): { lines: string[]; skipped: string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  const level = multibandLevel(st);
  if (level > 0) {
    const c = firstAccepted(mbCandidates(level));
    if (c) lines.push(...c);
    else skipped.push('compressor multibanda (plugin LSP)');
  }
  return { lines, skipped };
}

/** O plugin está instalado e o Liquidsoap o aceita? (para a tela desabilitar o que não funciona) */
export const fxSupport = () => ({ multiband: !!firstAccepted(mbCandidates(1)) });
