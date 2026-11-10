import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { config, stationDir } from '../config.js';

/**
 * Stereo Tool (processador de áudio comercial, exige licença própria): o Liquidsoap carrega a biblioteca
 * compartilhada (.so) enviada pelo administrador e aplica o preset (.sts) da estação.
 * A biblioteca é única do servidor; os presets e a chave de licença são por estação.
 */
export const stereoLibDir = () => path.join(config.dataDir, 'stereotool');
export const stereoLibPath = () => path.join(stereoLibDir(), 'libStereoTool.so');
export const presetsDir = (stationId: number) => path.join(stationDir(stationId), 'stereotool', 'presets');

/** Chave de licença do servidor (vale para todas as estações), guardada só em arquivo no servidor. */
const licensePath = () => path.join(stereoLibDir(), 'license.key');
export const getLicenseKey = (): string => {
  try {
    return fs.readFileSync(licensePath(), 'utf8').trim();
  } catch {
    return '';
  }
};
export function setLicenseKey(key: string) {
  const k = key.trim();
  if (!k) return fs.rmSync(licensePath(), { force: true });
  fs.mkdirSync(stereoLibDir(), { recursive: true });
  fs.writeFileSync(licensePath(), k, { mode: 0o600 });
}

const libNamePath = () => path.join(stereoLibDir(), 'libStereoTool.name');
export const setLibraryName = (name: string) => {
  try {
    fs.writeFileSync(libNamePath(), path.basename(name).slice(0, 120));
  } catch {
    /* só informativo */
  }
};

export const libraryInfo = () => {
  try {
    const s = fs.statSync(stereoLibPath());
    let name = '';
    try {
      name = fs.readFileSync(libNamePath(), 'utf8').trim();
    } catch {
      /* sem nome guardado */
    }
    return { present: true, size: s.size, updatedAt: s.mtime.toISOString(), name };
  } catch {
    return { present: false, size: 0, updatedAt: null as string | null, name: '' };
  }
};

/** Pontua uma entrada do ZIP: queremos a biblioteca Linux 64 bits (x86_64), não a de ARM/32 bits/Windows/Mac. */
function libScore(name: string): number {
  const n = name.toLowerCase();
  if (!/\.so(\.\d+)*$/.test(n) || /__macosx|\/\._/.test(n)) return -1;
  if (!/libstereotool/.test(n)) return -1;
  let score = 1;
  if (/intel64|x86[_-]?64|amd64|x64/.test(n)) score += 5;
  else if (/64/.test(n)) score += 1;
  if (/arm|aarch|armhf|pi\d|i386|i686|intel32|x86(?![_-]?64)|32/.test(n)) score -= 7;
  if (/x11|gui|gtk|qt/.test(n)) score -= 4; // versão com interface gráfica, não serve de plugin
  if (/linux/.test(n)) score += 1;
  return score;
}

/** Extrai a biblioteca Linux (.so) de dentro do ZIP baixado do site do Stereo Tool para `dest`. Devolve o nome do arquivo usado. */
export function extractLibraryFromZip(zipFile: string, dest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(new Error('Não foi possível abrir o ZIP (arquivo corrompido?).'));
      if (zip.entryCount > 2000) return reject(new Error('ZIP com arquivos demais para ser o plugin do Stereo Tool.'));
      const found: { entry: yauzl.Entry; score: number }[] = [];
      zip.on('error', (e) => reject(e));
      zip.on('entry', (entry: yauzl.Entry) => {
        const score = /\/$/.test(entry.fileName) ? -1 : libScore(entry.fileName);
        if (score >= 0 && entry.uncompressedSize < 200 * 1024 * 1024) found.push({ entry, score });
        zip.readEntry();
      });
      zip.on('end', () => {
        const best = found.sort((a, b) => b.score - a.score)[0];
        if (!best) return reject(new Error('Não achei a biblioteca Linux (libStereoTool_*.so) dentro do ZIP.'));
        yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (e2, z2) => {
          if (e2 || !z2) return reject(new Error('Não foi possível reabrir o ZIP.'));
          z2.on('entry', (entry: yauzl.Entry) => {
            if (entry.fileName !== best.entry.fileName) return z2.readEntry();
            z2.openReadStream(entry, (e3, stream) => {
              if (e3 || !stream) return reject(new Error('Não foi possível extrair a biblioteca do ZIP.'));
              pipeline(stream, fs.createWriteStream(dest)).then(() => resolve(path.basename(entry.fileName)), reject);
            });
          });
          z2.on('error', reject);
          z2.readEntry();
        });
      });
      zip.readEntry();
    });
  });
}

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
