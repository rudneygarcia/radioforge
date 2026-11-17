import fs from 'node:fs';
import path from 'node:path';
import { config, stationDir } from '../config.js';

/** Pasta onde os discos extras (HDs externos) aparecem dentro do contêiner: cada subpasta é um disco que a estação pode usar. */
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'; // junção no Windows (desenvolvimento): não exige privilégio
export const disksRoot = process.env.DISKS_DIR ?? '/disks';

export interface MountInfo { device: string; fsType: string; mountPoint: string }

/** Disco (ponto de montagem mais específico) em que uma pasta está: dispositivo e sistema de arquivos, lidos de /proc/self/mounts. */
export function mountOf(dir: string): MountInfo | null {
  try {
    const real = fs.realpathSync(dir);
    let best: MountInfo | null = null;
    for (const line of fs.readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
      const [device, mountPoint, fsType] = line.split(' ');
      if (!device || !mountPoint) continue;
      const mp = mountPoint.replace(/\\040/g, ' ');
      if ((real === mp || real.startsWith(mp.endsWith('/') ? mp : `${mp}/`)) && (!best || mp.length >= best.mountPoint.length)) best = { device, fsType, mountPoint: mp };
    }
    return best;
  } catch {
    return null; // sem /proc (Windows, desenvolvimento)
  }
}

export function diskUsage(dir: string) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

function canWrite(dir: string): boolean {
  try {
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface DiskInfo {
  /** '' = disco principal (onde ficam as músicas por padrão); senão o nome da subpasta de /disks. */
  id: string;
  name: string;
  total: number;
  free: number;
  device: string | null;
  fsType: string | null;
  writable: boolean;
}

/** Disco principal + um por subpasta de /disks. */
export function listDisks(): DiskInfo[] {
  const main = path.join(config.dataDir, 'stations');
  fs.mkdirSync(main, { recursive: true });
  const m = mountOf(main);
  const out: DiskInfo[] = [{ id: '', name: 'Disco principal', ...diskUsage(main), device: m?.device ?? null, fsType: m?.fsType ?? null, writable: canWrite(main) }];
  let names: string[] = [];
  try {
    names = fs.readdirSync(disksRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
  } catch {
    /* sem /disks: só o disco principal */
  }
  for (const n of names) {
    const dir = path.join(disksRoot, n);
    const mm = mountOf(dir);
    out.push({ id: n, name: n, ...diskUsage(dir), device: mm?.device ?? null, fsType: mm?.fsType ?? null, writable: canWrite(dir) });
  }
  return out;
}

const mediaLink = (id: number) => path.join(stationDir(id), 'media');
/** Pasta das músicas da estação dentro de um disco extra. */
const diskMediaDir = (disk: string, id: number) => path.join(disksRoot, disk, 'stations', String(id), 'media');

/** Disco em que as músicas da estação estão ('' = principal). */
export function stationDisk(id: number): string {
  try {
    if (!fs.lstatSync(mediaLink(id)).isSymbolicLink()) return '';
    const target = path.resolve(path.dirname(mediaLink(id)), fs.readlinkSync(mediaLink(id)));
    const rel = path.relative(disksRoot, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return rel.split(path.sep)[0] ?? '';
  } catch {
    return '';
  }
}

function checkDisk(disk: string) {
  if (!disk) return;
  if (!/^[^/\\\0]+$/.test(disk) || disk === '.' || disk === '..') throw new Error('Disco inválido');
  const d = listDisks().find((x) => x.id === disk);
  if (!d) throw new Error(`O disco "${disk}" não está disponível no servidor`);
  if (!d.writable) throw new Error(`Sem permissão para gravar no disco "${disk}" (a pasta precisa pertencer ao usuário 1001)`);
}

/**
 * Faz as músicas de uma estação NOVA (ainda vazia) ficarem no disco escolhido. Os caminhos no banco não mudam:
 * stations/<id>/media vira um atalho (link simbólico) para a pasta no outro disco.
 */
export function placeNewStation(id: number, disk: string) {
  checkDisk(disk);
  if (!disk) return;
  const target = diskMediaDir(disk, id);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(stationDir(id), { recursive: true });
  fs.rmSync(mediaLink(id), { recursive: true, force: true });
  fs.symlinkSync(target, mediaLink(id), LINK_TYPE);
}

export type MoveState = { to: string; state: 'moving' | 'error'; error?: string };
const moves = new Map<number, MoveState>();
export const moveState = (id: number) => moves.get(id) ?? null;
export const clearMoveError = (id: number) => { if (moves.get(id)?.state === 'error') moves.delete(id); };

function walk(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = walk(p);
      files += r.files;
      bytes += r.bytes;
    } else if (e.isFile()) {
      files++;
      bytes += fs.statSync(p).size;
    }
  }
  return { files, bytes };
}

/** Valida e devolve a função que move (em segundo plano) as músicas da estação para outro disco; null = já está lá. */
export function prepareMove(id: number, disk: string): (() => Promise<void>) | null {
  checkDisk(disk);
  if (moves.get(id)?.state === 'moving') throw new Error('As músicas desta estação já estão sendo movidas');
  if (stationDisk(id) === disk) return null;
  const link = mediaLink(id);
  if (!fs.existsSync(link)) throw new Error('A pasta das músicas não foi encontrada (o disco atual está montado?)');
  const wasLink = fs.lstatSync(link).isSymbolicLink();
  const src = fs.realpathSync(link);
  const need = walk(src).bytes;
  const dest = disk ? diskMediaDir(disk, id) : path.join(stationDir(id), 'media.new');
  const free = diskUsage(disk ? path.join(disksRoot, disk) : path.join(config.dataDir, 'stations')).free;
  if (need * 1.02 + 256 * 1024 ** 2 > free) {
    throw new Error(`Espaço insuficiente no disco de destino: precisa de ${(need / 1024 ** 3).toFixed(1)} GB e há ${(free / 1024 ** 3).toFixed(1)} GB livres`);
  }

  return async () => {
    moves.set(id, { to: disk, state: 'moving' });
    let swapped = false;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await fs.promises.cp(src, dest, { recursive: true, preserveTimestamps: true });
      const a = walk(src);
      const b = walk(dest);
      if (a.files !== b.files || a.bytes !== b.bytes) throw new Error('A cópia não confere com o original; nada foi apagado');
      // Só troca a pasta/atalho depois de a cópia conferir.
      if (wasLink) fs.unlinkSync(link);
      else fs.renameSync(link, `${link}.old`);
      swapped = true;
      if (disk) fs.symlinkSync(dest, link, LINK_TYPE);
      else fs.renameSync(dest, link);
      fs.rmSync(wasLink ? src : `${link}.old`, { recursive: true, force: true });
      // Pasta da estação no disco antigo, se ficou vazia.
      if (wasLink) try { fs.rmdirSync(path.dirname(src)); } catch { /* não está vazia */ }
      moves.delete(id);
    } catch (e) {
      // Desfaz: os arquivos originais continuam intactos até a cópia conferir.
      try {
        if (swapped) {
          fs.rmSync(link, { recursive: true, force: true });
          if (wasLink) fs.symlinkSync(src, link, LINK_TYPE);
          else fs.renameSync(`${link}.old`, link);
        }
        if (fs.existsSync(src)) fs.rmSync(dest, { recursive: true, force: true });
      } catch { /* melhor esforço */ }
      moves.set(id, { to: disk, state: 'error', error: (e as Error).message });
    }
  };
}

/** Apaga as músicas da estação, inclusive as que estão em outro disco (a pasta da estação só guarda o atalho). */
export function removeStationFiles(id: number) {
  try {
    if (fs.lstatSync(mediaLink(id)).isSymbolicLink()) fs.rmSync(path.dirname(fs.realpathSync(mediaLink(id))), { recursive: true, force: true });
  } catch { /* nada a apagar */ }
  fs.rmSync(stationDir(id), { recursive: true, force: true });
  moves.delete(id);
}
