import fs from 'node:fs';
import path from 'node:path';
import { config, stationDir } from '../config.js';

/**
 * Stereo Tool (processador de áudio comercial, exige licença própria): o Liquidsoap carrega a biblioteca
 * compartilhada (.so) enviada pelo administrador e aplica o preset (.sts) da estação.
 * A biblioteca é única do servidor; os presets e a chave de licença são por estação.
 */
export const stereoLibDir = () => path.join(config.dataDir, 'stereotool');
export const stereoLibPath = () => path.join(stereoLibDir(), 'libStereoTool.so');
export const presetsDir = (stationId: number) => path.join(stationDir(stationId), 'stereotool', 'presets');

export const libraryInfo = () => {
  try {
    const s = fs.statSync(stereoLibPath());
    return { present: true, size: s.size, updatedAt: s.mtime.toISOString() };
  } catch {
    return { present: false, size: 0, updatedAt: null as string | null };
  }
};

/** Nome de arquivo seguro para o preset (sem pastas, só letras/números/ponto/hífen/sublinhado). */
export function safePresetName(raw: string): string | null {
  const base = path.basename(raw).replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  if (!/\.(sts|ini)$/i.test(base) || base.length > 80) return null;
  return base;
}

export const listPresets = (stationId: number): string[] => {
  try {
    return fs.readdirSync(presetsDir(stationId)).filter((n) => /\.(sts|ini)$/i.test(n)).sort();
  } catch {
    return [];
  }
};

export const presetPath = (stationId: number, name: string) => path.join(presetsDir(stationId), name);
