import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { HttpError } from '../auth.js';
import { config, stationDir } from '../config.js';
import { all, djsFor, get, mountsFor, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { buildIcecastConfig } from './icecast.js';
import { dispatch } from './webhooks.js';
import { clearLive } from './nowplaying.js';
import { nativeEnqueue, nativeRunning, startNative, stopNative } from './native.js';
import { buildLiquidsoapScript, telnetPort, type LiqPlaylist } from './liquidsoap.js';

/** Mantém um processo vivo, reiniciando com backoff se cair. */
class Supervised {
  private child: ChildProcess | null = null;
  private stopping = false;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private label: string,
    private bin: string,
    private args: string[],
    private logFile: string,
  ) {}

  get running() {
    return this.child !== null && this.child.exitCode === null;
  }

  start() {
    this.stopping = false;
    const log = fs.openSync(this.logFile, 'a');
    const startedAt = Date.now();
    const child = spawn(this.bin, this.args, { stdio: ['ignore', log, log] });
    this.child = child;
    child.on('error', (err) => console.error(`[${this.label}] falha ao iniciar ${this.bin}: ${err.message}`));
    child.on('exit', (code) => {
      fs.closeSync(log);
      this.child = null;
      if (this.stopping) return;
      // Se viveu mais de 30s consideramos estável e zeramos o contador.
      this.failures = Date.now() - startedAt > 30_000 ? 1 : this.failures + 1;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
      console.warn(`[${this.label}] saiu (código ${code}); reiniciando em ${delay}ms`);
      this.timer = setTimeout(() => this.start(), delay);
    });
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

const hasBin = (bin: string, arg: string) => {
  try {
    return !spawnSync(bin, [arg], { stdio: 'ignore', timeout: 5000 }).error;
  } catch {
    return false;
  }
};

let resolvedMode: 'liquidsoap' | 'native' | null = null;
/** Motor em uso: Icecast+Liquidsoap (completo) ou o motor simples em Node (só MP3, ver native.ts). */
export function engineMode(): 'liquidsoap' | 'native' {
  if (resolvedMode) return resolvedMode;
  const want = config.engine.mode;
  resolvedMode =
    want === 'native' || want === 'liquidsoap'
      ? want
      : hasBin(config.engine.liquidsoapBin, '--version') && hasBin(config.engine.icecastBin, '-v')
        ? 'liquidsoap'
        : 'native';
  console.log(`[engine] modo de streaming: ${resolvedMode}`);
  return resolvedMode;
}

interface StationProcs {
  icecast: Supervised;
  liquidsoap: Supervised;
}
const procs = new Map<number, StationProcs>();

export function ensureStationDirs(id: number) {
  const base = stationDir(id);
  for (const d of ['media', 'playlists', 'config', 'logs', 'recordings']) fs.mkdirSync(path.join(base, d), { recursive: true });
}

/** Reescreve os arquivos .m3u de cada playlist; o Liquidsoap recarrega sozinho (reload_mode=watch). */
export function writePlaylists(stationId: number): LiqPlaylist[] {
  ensureStationDirs(stationId);
  const playlists = all<PlaylistRow>('SELECT * FROM playlists WHERE station_id = ? AND enabled = 1', stationId);
  const out: LiqPlaylist[] = [];
  for (const p of playlists) {
    const media = all<MediaRow>(
      `SELECT m.* FROM playlist_media pm JOIN media m ON m.id = pm.media_id
       WHERE pm.playlist_id = ? ORDER BY pm.position, m.id`,
      p.id,
    );
    if (media.length === 0) continue;
    const m3uPath = path.join(stationDir(stationId), 'playlists', `${p.id}.m3u`);
    fs.writeFileSync(m3uPath, media.map((m) => path.join(config.dataDir, m.path)).join('\n') + '\n');
    out.push({
      id: p.id,
      mode: p.mode,
      weight: p.weight,
      everySongs: p.schedule_enabled ? 0 : p.every_songs, // agendada tem prioridade: ignora "a cada N"
      m3uPath,
      schedule: p.schedule_enabled
        ? { days: p.days.split(',').filter(Boolean).map(Number), start: p.start_time, end: p.end_time }
        : undefined,
    });
  }
  return out;
}

function writeConfigs(st: StationRow) {
  ensureStationDirs(st.id);
  const base = stationDir(st.id);
  const playlists = writePlaylists(st.id);
  fs.writeFileSync(path.join(base, 'config', 'icecast.xml'), buildIcecastConfig(st, path.join(base, 'logs')));
  fs.writeFileSync(path.join(base, 'config', 'radio.liq'), buildLiquidsoapScript(st, playlists, mountsFor(st.id), djsFor(st.id), path.join(base, 'recordings')),
  );
}

export function isRunning(stationId: number) {
  if (engineMode() === 'native') return nativeRunning(stationId);
  const p = procs.get(stationId);
  return !!p && p.icecast.running && p.liquidsoap.running;
}

export async function startStation(st: StationRow) {
  if (!config.engine.enabled) throw new Error('Engine desativada (ENGINE_ENABLED=false)');
  if (engineMode() === 'native') {
    await startNative(st);
    dispatch(st.id, 'station_start', {});
    return;
  }
  if (procs.has(st.id)) await stopStation(st.id);
  writeConfigs(st);
  const base = stationDir(st.id);

  // Valida o script antes de subir: erros de sintaxe/tipo aparecem direto no painel.
  const check = spawnSync(config.engine.liquidsoapBin, ['--check', path.join(base, 'config', 'radio.liq')], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (check.error) throw startError(`Não foi possível executar o Liquidsoap: ${check.error.message}`);
  if (check.status !== 0) {
    throw startError(`Script do Liquidsoap inválido:\n${tail(`${check.stdout}\n${check.stderr}`)}`);
  }

  const icecast = new Supervised(
    `icecast:${st.slug}`,
    config.engine.icecastBin,
    ['-c', path.join(base, 'config', 'icecast.xml')],
    path.join(base, 'logs', 'icecast.out.log'),
  );
  const liquidsoap = new Supervised(
    `liquidsoap:${st.slug}`,
    config.engine.liquidsoapBin,
    [path.join(base, 'config', 'radio.liq')],
    path.join(base, 'logs', 'liquidsoap.out.log'),
  );
  procs.set(st.id, { icecast, liquidsoap });
  icecast.start();
  // Dá um instante para o Icecast abrir a porta antes do Liquidsoap conectar.
  setTimeout(() => procs.get(st.id)?.liquidsoap.start(), 1500);

  // Se algum dos dois cair logo na partida, devolve o motivo (fim do log) em vez de "subir" e voltar a "parada".
  await new Promise((r) => setTimeout(r, 4500));
  const p = procs.get(st.id);
  const dead = !p?.icecast.running ? 'icecast' : !p.liquidsoap.running ? 'liquidsoap' : null;
  if (dead) {
    await stopStation(st.id);
    let log = '';
    try {
      log = fs.readFileSync(path.join(base, 'logs', `${dead}.out.log`), 'utf8');
    } catch {
      /* sem log */
    }
    throw startError(`${dead === 'icecast' ? 'Icecast' : 'Liquidsoap'} não ficou no ar:\n${tail(log) || '(sem saída no log)'}`);
  }
  dispatch(st.id, 'station_start', {});
}

/** Registra o motivo no log do contêiner (para diagnóstico remoto) e devolve o erro 422 ao painel. */
const startError = (msg: string) => {
  console.error(`[engine] falha ao iniciar estação: ${msg}`);
  return new HttpError(422, msg);
};

const tail = (s: string, n = 15) => s.trim().split('\n').slice(-n).join('\n');

export async function stopStation(stationId: number) {
  if (engineMode() === 'native') {
    if (!nativeRunning(stationId)) return;
    await stopNative(stationId);
    dispatch(stationId, 'station_stop', {});
    return;
  }
  clearLive(stationId);
  const p = procs.get(stationId);
  if (!p) return;
  procs.delete(stationId);
  await Promise.all([p.liquidsoap.stop(), p.icecast.stop()]);
  dispatch(stationId, 'station_stop', {});
}

export async function restartStation(st: StationRow) {
  await stopStation(st.id);
  await startStation(st);
}

/**
 * Regrava a configuração e reinicia só o Liquidsoap (usado ao mudar DJs).
 * O Icecast continua no ar, então os ouvintes conectados não são derrubados.
 */
export async function reloadLiquidsoap(st: StationRow) {
  if (engineMode() === 'native') return; // o motor simples lê o banco a cada faixa
  const p = procs.get(st.id);
  if (!p) return;
  writeConfigs(st);
  clearLive(st.id); // reiniciar o Liquidsoap derruba o DJ conectado
  await p.liquidsoap.stop();
  p.liquidsoap.start();
}

export async function stopAll() {
  const ids = engineMode() === 'native' ? all<{ id: number }>('SELECT id FROM stations').map((s) => s.id) : [...procs.keys()];
  await Promise.all(ids.map((id) => stopStation(id)));
}

export async function startAutostart() {
  if (!config.engine.enabled) return;
  for (const st of all<StationRow>('SELECT * FROM stations WHERE autostart = 1')) {
    try {
      await startStation(st);
    } catch (e) {
      console.error(`Falha ao iniciar estação ${st.slug}:`, e);
    }
  }
}

/** Empurra um arquivo na fila de pedidos do Liquidsoap via telnet local. */
export function pushRequest(stationId: number, absPath: string): Promise<void> {
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!st) return Promise.reject(new Error('Estação não encontrada'));
  if (engineMode() === 'native') {
    const m = get<MediaRow>('SELECT * FROM media WHERE station_id = ? AND path = ?', stationId, path.relative(config.dataDir, absPath));
    if (!m) return Promise.reject(new Error('Música não encontrada'));
    nativeEnqueue(stationId, m.id);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect(telnetPort(st), '127.0.0.1');
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('Timeout falando com o Liquidsoap'));
    });
    sock.on('error', reject);
    sock.on('connect', () => sock.write(`requests.push ${absPath}\nquit\n`));
    sock.on('close', () => resolve());
  });
}
