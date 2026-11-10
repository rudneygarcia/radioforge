import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

/** Diagnóstico da biblioteca enviada: arquitetura, dependências que faltam (ldd) e nomes de funções exportadas. */
export function inspectLibrary() {
  const file = stereoLibPath();
  if (!fs.existsSync(file)) return { present: false as const };
  const buf = fs.readFileSync(file);
  const machine = buf.length > 20 ? buf.readUInt16LE(18) : 0;
  const arch = ({ 0x3e: 'x86-64 (correto)', 0xb7: 'ARM 64 bits (aarch64): NÃO serve neste servidor se ele for x86', 0x28: 'ARM 32 bits: não serve', 0x03: 'x86 32 bits: não serve' } as Record<number, string>)[machine] ?? `desconhecida (${machine})`;
  const class64 = buf[4] === 2;
  const ldd = spawnSync('ldd', [file], { encoding: 'utf8', timeout: 10_000 });
  const lddOut = `${ldd.stdout ?? ''}${ldd.stderr ?? ''}`.trim() || (ldd.error ? `ldd indisponível: ${ldd.error.message}` : '');
  // Nomes em texto dentro do arquivo (tabela de símbolos dinâmicos): mostra o que a biblioteca exporta com "stereo" no nome.
  const text = buf.toString('latin1');
  const names = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{3,60}/g)) {
    if (/stereo/i.test(m[0]) && !/^_?_?cxa/.test(m[0])) names.add(m[0]);
    if (names.size >= 60) break;
  }
  const missing = lddOut.split('\n').filter((l) => /not found/i.test(l));
  return { present: true as const, arch, class64, size: buf.length, missing, ldd: lddOut.slice(0, 3000), symbols: [...names].sort() };
}

export const uploadsDir = () => path.join(stereoLibDir(), '.uploads');

export interface LibTry {
  name: string;
  ok: boolean;
  note: string;
}

const isElf = (f: string) => {
  const fd = fs.openSync(f, 'r');
  const h = Buffer.alloc(20);
  fs.readSync(fd, h, 0, 20, 0);
  fs.closeSync(fd);
  return { elf: h[0] === 0x7f && h[1] === 0x45 && h[2] === 0x4c && h[3] === 0x46, machine: h.readUInt16LE(18) };
};

/** Extrai TODAS as bibliotecas .so do ZIP para `destDir` (limites contra ZIP malicioso). */
function extractAllLibs(zipFile: string, destDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(new Error('Não foi possível abrir o ZIP (arquivo corrompido?).'));
      if (zip.entryCount > 5000) return reject(new Error('ZIP com arquivos demais para ser o plugin do Stereo Tool.'));
      const out: string[] = [];
      let n = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (/\/$/.test(name) || !/\.so(\.\d+)*$/i.test(name) || /__macosx|\/\._/i.test(name) || entry.uncompressedSize > 250 * 1024 * 1024 || n >= 40) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return zip.readEntry();
          const dest = path.join(destDir, `${n++}__${path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_')}`);
          pipeline(stream, fs.createWriteStream(dest)).then(
            () => {
              out.push(dest);
              zip.readEntry();
            },
            reject,
          );
        });
      });
      zip.readEntry();
    });
  });
}

/** Carrega a biblioteca num Liquidsoap de teste: devolve '' se funcionou ou o motivo. */
function tryLibrary(lib: string, workDir: string): string {
  const script = path.join(workDir, 'test.liq');
  fs.writeFileSync(script, `x = stereotool(library_file = ${JSON.stringify(lib)}, blank())\nprint("RF_STEREO_OK")\nshutdown()\n`);
  const r = spawnSync(config.engine.liquidsoapBin, [script], { encoding: 'utf8', timeout: 40_000 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (/RF_STEREO_OK/.test(out) && !/Invalid stereotool/i.test(out)) return '';
  const msg = out.split('\n').filter((l) => /invalid|error|not found|cannot|undefined symbol|stereotool/i.test(l)).slice(-3).join(' | ');
  const ldd = spawnSync('ldd', [lib], { encoding: 'utf8', timeout: 10_000 });
  const missing = `${ldd.stdout ?? ''}`.split('\n').filter((l) => /not found/i.test(l)).map((l) => l.trim().split(' ')[0]);
  return (missing.length ? `faltam no servidor: ${missing.join(', ')}. ` : '') + (msg || 'o Liquidsoap não aceitou o arquivo');
}

/**
 * Recebe o arquivo enviado (ZIP do plugin ou .so solto), tira todas as bibliotecas e TESTA uma por uma no Liquidsoap:
 * a primeira que carregar vira a biblioteca do servidor.
 */
export async function installLibrary(file: string, originalName: string): Promise<{ chosen: string | null; results: LibTry[] }> {
  const work = path.join(uploadsDir(), `work-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    let candidates: string[];
    const head = Buffer.alloc(4);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (head[0] === 0x50 && head[1] === 0x4b) candidates = await extractAllLibs(file, work);
    else {
      const single = path.join(work, `0__${path.basename(originalName).replace(/[^A-Za-z0-9._-]/g, '_') || 'lib.so'}`);
      fs.copyFileSync(file, single);
      candidates = [single];
    }
    if (candidates.length === 0) throw new Error('Não achei nenhuma biblioteca (.so) dentro do arquivo enviado.');
    const base = (f: string) => path.basename(f).replace(/^\d+__/, '');
    candidates.sort((a, b) => libScore(base(b)) - libScore(base(a)));
    const results: LibTry[] = [];
    for (const c of candidates) {
      const name = base(c);
      const { elf, machine } = isElf(c);
      if (!elf) {
        results.push({ name, ok: false, note: 'não é uma biblioteca Linux' });
        continue;
      }
      if (machine !== 0x3e) {
        results.push({ name, ok: false, note: machine === 0xb7 ? 'é para ARM 64 bits (este servidor é x86-64)' : 'arquitetura diferente do servidor (precisa ser x86-64)' });
        continue;
      }
      fs.chmodSync(c, 0o755);
      const why = tryLibrary(c, work);
      if (why) {
        results.push({ name, ok: false, note: why });
        continue;
      }
      fs.mkdirSync(stereoLibDir(), { recursive: true });
      fs.copyFileSync(c, stereoLibPath());
      fs.chmodSync(stereoLibPath(), 0o755);
      setLibraryName(name);
      results.push({ name, ok: true, note: 'carregou no Liquidsoap — em uso' });
      return { chosen: name, results };
    }
    return { chosen: null, results };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
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
