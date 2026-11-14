import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../auth.js';
import { config, stationDir } from '../config.js';
import { all, avoidRecent, djsFor, get, mountsFor, playlistMedia, recentMedia, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { buildIcecastConfig } from './icecast.js';
import { cueCacheOn, cueFor, cueMap } from './cuecache.js';
import { dispatch } from './webhooks.js';
import { clearLive } from './nowplaying.js';
import { nativeEnqueue, nativeRunning, startNative, stopNative } from './native.js';
import { buildLiquidsoapScript, telnetPort, type LiqPlaylist } from './liquidsoap.js';
import { isHiddenTrack } from './hide.js';
import { getLicenseKey, libraryInfo, listPresets } from './stereotool.js';
import { lastNextCall } from './dynstate.js';
import { icePort, setPortFront } from './ports.js';
import { startFront, stopFront } from './portfront.js';

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
    private env: NodeJS.ProcessEnv = {},
  ) {}

  get running() {
    return this.child !== null && this.child.exitCode === null;
  }

  start() {
    this.stopping = false;
    // Log que cresce sem parar pesa em disco e na leitura: passado de 5 MB, o antigo vira .1 e começa um novo.
    try {
      if (fs.statSync(this.logFile).size > 5 * 1024 * 1024) fs.renameSync(this.logFile, `${this.logFile}.1`);
    } catch {
      /* sem log ainda */
    }
    const log = fs.openSync(this.logFile, 'a');
    const startedAt = Date.now();
    const child = spawn(this.bin, this.args, { stdio: ['ignore', log, log], env: { ...process.env, ...this.env } });
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
  /** null = estação sem AutoDJ (só Icecast). */
  liquidsoap: Supervised | null;
}
const procs = new Map<number, StationProcs>();

export function ensureStationDirs(id: number) {
  const base = stationDir(id);
  for (const d of ['media', 'playlists', 'config', 'logs']) fs.mkdirSync(path.join(base, d), { recursive: true });
}

/**
 * URI de uma vinheta para o Liquidsoap: rf_jingle faz o aviso ao servidor ser ignorado e título/artista são
 * trocados pelo nome da estação, para o Icecast e os players não exibirem as tags do arquivo.
 */
export function jingleUri(st: StationRow, abs: string, duration = 0, adId = 0) {
  const label = st.jingle_hide_name ? '' : st.name.replace(/["\\\r\n,]/g, ' ').trim();
  // Com AutoCue: cue exato (começa em 0 e vai até o fim real, sem a análise cortar o meio), sem pular silêncio,
  // sobreposição própria (padrão 0: vinheta→vinheta não se atropelam) e ganho opcional.
  const cue = st.autocue
    ? `liq_blankskip="0.0",${duration > 0 ? `liq_cue_out="${(duration + 0.2).toFixed(2)}",` : 'liq_cue_in="0.0",'}liq_cross_duration="${st.jingle_overlap.toFixed(2)}",${st.jingle_gain ? `liq_amplify="${Math.pow(10, st.jingle_gain / 20).toFixed(3)}",` : ''}`
    : '';
  // liq_fade_in/out curtos: vinheta e aviso entram e saem sem estalo, e o AutoCue encaixa a passagem.
  return `annotate:rf_jingle="1",${adId ? `rf_ad="${adId}",` : ''}${cue}liq_fade_in="0.10",liq_fade_out="0.10",title="${label}",artist="",album="":${abs}`;
}

/**
 * Música normal: título e artista vêm da biblioteca (o que o painel mostra e o administrador pode corrigir), não das tags do
 * arquivo. Assim o Icecast e os players nunca exibem o nome interno do arquivo (um código aleatório) quando a tag está vazia.
 */
export function songUri(abs: string, title: string, artist: string, cue = '') {
  // Aspas, barra invertida, quebras de linha e vírgula quebrariam o annotate: viram espaço.
  const clean = (v: string) => v.split('"').join(' ').split('\\').join(' ').split(',').join(' ').split(/[\r\n\s]+/).filter(Boolean).join(' ');
  const t = clean(title);
  if (!t) return abs;
  return `annotate:${cue}title="${t}",artist="${clean(artist)}":${abs}`;
}

/** Mesma coisa para um arquivo da biblioteca identificado só pelo caminho (pedidos e horários). */
function songUriFor(abs: string) {
  const m = get<{ id: number; title: string; artist: string }>('SELECT id, title, artist FROM media WHERE path = ?', path.relative(config.dataDir, abs));
  const stn = m ? get<StationRow>('SELECT s.* FROM stations s JOIN media x ON x.station_id = s.id WHERE x.id = ?', m.id) : undefined;
  return m ? songUri(abs, m.title, m.artist, stn ? cueFor(stn, m.id) : '') : abs;
}

/** Faixa oculta: toca normalmente, mas sem título/artista (nada é enviado ao servidor nem ao Icecast, nem o nome da estação). */
export function hiddenUri(abs: string) {
  return `annotate:rf_jingle="1",rf_hide="1",title="",artist="",album="":${abs}`;
}

/** Reescreve os arquivos .m3u de cada playlist; o Liquidsoap recarrega sozinho (reload_mode=watch). */
export function writePlaylists(stationId: number): LiqPlaylist[] {
  ensureStationDirs(stationId);
  const playlists = all<PlaylistRow>('SELECT * FROM playlists WHERE station_id = ? AND enabled = 1', stationId);
  const out: LiqPlaylist[] = [];
  // Regra "não repetir por N minutos": as tocadas há pouco ficam fora do arquivo (o Liquidsoap recarrega sozinho).
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  const recent = recentMedia(stationId, st?.no_repeat_minutes ?? 0);
  const cues = st ? cueMap(st) : new Map<number, string>(); // análises do AutoCue já salvas
  for (const p of playlists) {
    if (p.every_minutes > 0) continue; // entra por tempo (ver timed.ts), não na rotação
    const full = playlistMedia(p.id);
    const media = p.is_jingle ? full : avoidRecent(full, recent); // vinhetas não entram na regra
    if (media.length === 0) continue;
    const m3uPath = path.join(stationDir(stationId), 'playlists', `${p.id}.m3u`);
    // Vinheta: o prefixo annotate marca a faixa para o Liquidsoap não avisar o servidor do nome dela.
    const uri = (m: MediaRow) => {
      const abs = path.join(config.dataDir, m.path);
      if (st && isHiddenTrack(st, m)) return hiddenUri(abs);
      return p.is_jingle && st ? jingleUri(st, abs, m.duration) : songUri(abs, m.title, m.artist, cues.get(m.id) ?? '');
    };
    const content = media.map(uri).join('\n') + '\n';
    // Só regrava se mudou: cada gravação faz o Liquidsoap recarregar a playlist.
    if (!fs.existsSync(m3uPath) || fs.readFileSync(m3uPath, 'utf8') !== content) fs.writeFileSync(m3uPath, content);
    out.push({
      id: p.id,
      mode: p.mode,
      weight: p.weight,
      jingle: !!p.is_jingle,
      isDefault: !!p.is_default,
      // Playlist de música agendada ignora "a cada N" (ela toca sozinha); vinheta agendada é o contrário: "a cada N"
      // é o que diz como ela entra na janela (junto com a música que tiver o MESMO horário — ver liquidsoap.ts).
      everySongs: p.is_default || (p.schedule_enabled && !p.is_jingle) ? 0 : p.every_songs,
      m3uPath,
      schedule: p.schedule_enabled
        ? { days: p.days.split(',').filter(Boolean).map(Number), start: p.start_time, end: p.end_time }
        : undefined,
    });
  }
  return out;
}

/** Versão do script que vale por estação: processador (0 completo, 1 só padrões, 2 desligado) e AutoDJ em segundo plano. */
type Variant = { audio: 0 | 1 | 2; keepAlive: boolean; autocue: boolean; tuned: boolean; stereo?: boolean; dyn?: boolean; root?: boolean; cue?: boolean };
const variantOf = new Map<number, Variant>();
const audioWarnings = new Map<number, string>();
/** A estação roda com a próxima faixa escolhida pela API (não pelas playlists .m3u)? */
export const usesDynamic = (stationId: number) => !!variantOf.get(stationId)?.dyn;
/** Aviso para o painel quando o processador ou o "AutoDJ em segundo plano" precisaram ser reduzidos/desligados por erro no script. */
export const audioWarningFor = (stationId: number): string | null => audioWarnings.get(stationId) ?? null;

/** Grava radio.liq/icecast.xml; devolve quantas playlists entram na rotação. */
function writeConfigs(st: StationRow, variant: Variant = variantOf.get(st.id) ?? { audio: 0, keepAlive: !!st.live_continue && !!st.live_enabled, autocue: !!st.autocue, tuned: !!st.autocue && !!st.autocue_custom }) {
  ensureStationDirs(st.id);
  const base = stationDir(st.id);
  const playlists = writePlaylists(st.id);
  fs.writeFileSync(path.join(base, 'config', 'icecast.xml'), buildIcecastConfig(st, path.join(base, 'logs')));
  fs.writeFileSync(
    path.join(base, 'config', 'radio.liq'),
    buildLiquidsoapScript(st, playlists, mountsFor(st.id), djsFor(st.id), variant),
  );
  return playlists.length;
}

export function isRunning(stationId: number) {
  if (engineMode() === 'native') return nativeRunning(stationId);
  const p = procs.get(stationId);
  return !!p && p.icecast.running && (p.liquidsoap === null || p.liquidsoap.running);
}

/** Tira a chave de licença do Stereo Tool de qualquer texto que vá para log/painel. */
const maskKey = (s: string) => {
  const k = getLicenseKey();
  return k.length >= 6 ? s.split(k).join('<chave oculta>') : s;
};

/** Scripts do Liquidsoap já aprovados no --check (vale enquanto o contêiner/Liquidsoap for o mesmo: o arquivo fica em /tmp). */
const checkFile = path.join(os.tmpdir(), 'radioforge-liq-checked.json');
const scriptHash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function checkedOk(file: string): boolean {
  try {
    const list = JSON.parse(fs.readFileSync(checkFile, 'utf8')) as string[];
    return list.includes(scriptHash(file));
  } catch {
    return false;
  }
}
function rememberChecked(file: string) {
  try {
    let list: string[] = [];
    try {
      list = JSON.parse(fs.readFileSync(checkFile, 'utf8')) as string[];
    } catch {
      /* primeiro uso */
    }
    list = [...list.filter((h) => h !== scriptHash(file)), scriptHash(file)].slice(-200);
    fs.writeFileSync(checkFile, JSON.stringify(list));
  } catch {
    /* só otimização */
  }
}

/**
 * `liquidsoap --check` SEM travar a thread do Node (ao contrário de `spawnSync`). O painel repassa o áudio de TODAS as
 * estações numa thread só (o "front" de portas, em portfront.ts); se esta checagem travasse, o áudio de todo mundo
 * pausaria toda vez que uma estação fosse salva/reiniciada, até achar a primeira versão do script que o Liquidsoap aceita.
 */
function runLiquidsoapCheck(file: string): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(config.engine.liquidsoapBin, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ status: null, stdout: '', stderr: '', error: e as Error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (status: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, new Error('tempo esgotado (60 s)'));
    }, 60_000);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

export async function startStation(st: StationRow, skip: { stereo?: boolean; dyn?: boolean; root?: boolean } = {}) {
  const skipStereo = !!skip.stereo;
  if (!config.engine.enabled) throw new Error('Engine desativada (ENGINE_ENABLED=false)');
  if (engineMode() === 'native') {
    await startNative(st);
    dispatch(st.id, 'station_start', {});
    return;
  }
  if (procs.has(st.id)) await stopStation(st.id);
  const base = stationDir(st.id);
  // Sem AutoDJ: só o Icecast (nada de Liquidsoap, análise de áudio, processadores ou Stereo Tool). O DJ conecta direto nele.
  if (!st.autodj) {
    ensureStationDirs(st.id);
    fs.writeFileSync(path.join(base, 'config', 'icecast.xml'), buildIcecastConfig(st, path.join(base, 'logs')));
    audioWarnings.delete(st.id);
    variantOf.delete(st.id);
    const ice = new Supervised(`icecast:${st.slug}`, config.engine.icecastBin, ['-c', path.join(base, 'config', 'icecast.xml')], path.join(base, 'logs', 'icecast.out.log'), { TZ: st.timezone || process.env.TZ || 'America/Sao_Paulo' });
    procs.set(st.id, { icecast: ice, liquidsoap: null });
    ice.start();
    await startFront(st).catch(async (e) => {
      await stopStation(st.id);
      throw startError(`Não foi possível abrir a porta ${st.stream_port}: ${(e as Error).message}`);
    });
    await new Promise((r) => setTimeout(r, 2500));
    if (!procs.get(st.id)?.icecast.running) {
      await stopStation(st.id);
      let log = '';
      try {
        log = fs.readFileSync(path.join(base, 'logs', 'icecast.out.log'), 'utf8');
      } catch {
        /* sem log */
      }
      throw startError(`Icecast não ficou no ar:\n${tail(log) || '(sem saída no log)'}`);
    }
    dispatch(st.id, 'station_start', {});
    return;
  }
  // Assíncrono de propósito: o painel atende os ouvintes de TODAS as estações numa única thread (o "front" de portas
  // repassa o áudio); se isto travasse a thread (como `spawnSync`), o áudio de todo mundo pausaria enquanto o Liquidsoap
  // confere o script (pode acontecer várias vezes numa só troca de estação, até achar a primeira versão aceita).
  const runCheck = () => runLiquidsoapCheck(path.join(base, 'config', 'radio.liq'));

  // Valida o script antes de subir: erros de sintaxe/tipo aparecem direto no painel.
  // Se o erro for do processador de áudio, tenta uma versão mais simples e por fim sem processamento,
  // para a rádio ir ao ar mesmo assim (e o painel avisa o que aconteceu).
  const wantsChain = st.audio_preset !== 'off' || st.audio_gain > 0;
  const wantsKeep = !!st.live_continue && !!st.live_enabled;
  // Tentativas, da mais completa à mais simples: com AutoDJ em segundo plano primeiro, depois sem.
  const audios: (0 | 1 | 2)[] = wantsChain ? [0, 1, 2] : [2];
  const wantsAutocue = !!st.autocue;
  // Todas as combinações, da mais completa à mais simples (cada recurso que o Liquidsoap recusar é desligado sozinho).
  const attempts: Variant[] = [];
  // AutoCue em três níveis: personalizado (se a estação personalizou), padrão do Liquidsoap, desligado.
  const cueLevels = wantsAutocue ? [...(st.autocue_custom ? [{ autocue: true, tuned: true }] : []), { autocue: true, tuned: false }, { autocue: false, tuned: false }] : [{ autocue: false, tuned: false }];
  for (const cue of cueLevels)
    for (const keepAlive of wantsKeep ? [true, false] : [false])
      for (const audio of audios) attempts.push({ audio, keepAlive, autocue: cue.autocue, tuned: cue.tuned });
  const reductions = (v: Variant) => audios.indexOf(v.audio) + (wantsKeep && !v.keepAlive ? 1 : 0) + cueLevels.findIndex((c) => c.autocue === v.autocue && c.tuned === v.tuned);
  attempts.sort((a, b) => reductions(a) - reductions(b));
  // Stereo Tool (se ligado, com biblioteca e preset enviados): tentado primeiro; se o Liquidsoap recusar, cai no processador interno.
  const stereoProblem = !st.stereo_enabled
    ? ''
    : !libraryInfo().present
      ? 'A biblioteca do Stereo Tool ainda não foi enviada (Configurações → Stereo Tool).'
      : st.stereo_preset && !listPresets(st.id).includes(st.stereo_preset)
        ? `O preset "${st.stereo_preset}" do Stereo Tool não foi encontrado.`
        : '';
  const wantsStereo = !!st.stereo_enabled && !stereoProblem && !skipStereo;
  if (wantsStereo) {
    const stereoAttempts: Variant[] = attempts.filter((v) => v.audio === attempts[0].audio || v.audio === 2).map((v) => ({ ...v, audio: 2 as const, stereo: true }));
    const seen = new Set<string>();
    attempts.unshift(...stereoAttempts.filter((v) => !seen.has(JSON.stringify(v)) && seen.add(JSON.stringify(v))));
  }
  // Rotação pela API (regras de repetição exatas) primeiro; se o Liquidsoap recusar, volta às playlists .m3u.
  if (!skip.dyn) {
    const expanded = [...attempts.map((v) => ({ ...v, dyn: true })), ...attempts.map((v) => ({ ...v, dyn: false }))];
    attempts.splice(0, attempts.length, ...expanded);
  }
  // Mount "/" do DJ (compatível com encoders do AzuraCast): aplicado a todas as tentativas; se o Liquidsoap não subir com ele, volta sem.
  if (!skip.root) {
    const withRoot = [...attempts.map((v) => ({ ...v, root: true })), ...attempts.map((v) => ({ ...v, root: false }))];
    attempts.splice(0, attempts.length, ...withRoot);
  }
  // Cache do AutoCue: a melhor tentativa ganha uma versão com o aprendizado das análises logo na frente (se o Liquidsoap recusar, segue sem ele).
  if (wantsAutocue && cueCacheOn() && attempts[0]?.autocue) attempts.unshift({ ...attempts[0], cue: true });
  audioWarnings.delete(st.id);
  let firstError = '';
  let lastOut = '';
  let chosen: Variant | null = null;
  let dynPlaylists = 0;
  for (const v of attempts) {
    dynPlaylists = writeConfigs(st, v);
    // Script idêntico já validado neste contêiner: não compila de novo (a verificação custa CPU a cada início/reinício).
    const checked = checkedOk(path.join(base, 'config', 'radio.liq'));
    const check = checked ? { status: 0, stdout: '', stderr: '', error: undefined } : await runCheck();
    if (check.error) throw startError(`Não foi possível executar o Liquidsoap: ${check.error.message}`);
    if (check.status === 0) {
      if (!checked) rememberChecked(path.join(base, 'config', 'radio.liq'));
      chosen = v;
      break;
    }
    lastOut = tail(`${check.stdout}\n${check.stderr}`);
    if (!firstError) firstError = lastOut;
  }
  // Nem a versão mais simples passou: o problema é outro, mostra o erro dela.
  if (!chosen) throw startError(`Script do Liquidsoap inválido:\n${lastOut}`);
  variantOf.set(st.id, chosen);
  const notes: string[] = [];
  if (stereoProblem) notes.push(stereoProblem + ' Usando o processador interno.');
  if (wantsStereo && !chosen.stereo) notes.push('O Stereo Tool NÃO foi carregado (o Liquidsoap recusou o script: verifique se esta versão do Liquidsoap tem o suporte a Stereo Tool). Usando o processador interno.');
  if (!skip.dyn && !chosen.dyn) notes.push('A rotação pela API (regras exatas de não repetir música/artista) não foi aceita pelo Liquidsoap: usando as playlists comuns.');
  if (wantsChain && !chosen.stereo && chosen.audio === 1) notes.push(`O processador de áudio roda só com valores padrão (os ajustes finos não foram aceitos pelo Liquidsoap).`);
  if (wantsChain && !chosen.stereo && chosen.audio === 2) notes.push(`O processador de áudio foi DESLIGADO porque o Liquidsoap recusou o script.`);
  if (wantsAutocue && chosen.autocue && !chosen.tuned && st.autocue_custom) notes.push(`O AutoCue roda com a configuração padrão (os valores personalizados de duração/fade não foram aceitos pelo Liquidsoap).`);
  if (wantsAutocue && !chosen.autocue) notes.push(`O AutoCue foi DESLIGADO porque o Liquidsoap recusou o script (as passagens ficam sem o ajuste automático).`);
  if (wantsKeep && !chosen.keepAlive) notes.push(`O AutoDJ não continua em segundo plano durante o ao vivo (o Liquidsoap recusou): ao voltar, ele pode começar uma música nova.`);
  if (notes.length) audioWarnings.set(st.id, maskKey(`${notes.join('\n')}\n${firstError}`));
  if (audioWarnings.has(st.id)) console.warn(`[engine] ${st.slug}: ${audioWarnings.get(st.id)}`);

  // Horas dos logs do Icecast/Liquidsoap no fuso da estação (o servidor roda em UTC): bate com o relógio de quem lê.
  const logTz = st.timezone || process.env.TZ || 'America/Sao_Paulo';
  const icecast = new Supervised(
    `icecast:${st.slug}`,
    config.engine.icecastBin,
    ['-c', path.join(base, 'config', 'icecast.xml')],
    path.join(base, 'logs', 'icecast.out.log'),
    { TZ: logTz },
  );
  const liquidsoap = new Supervised(
    `liquidsoap:${st.slug}`,
    config.engine.liquidsoapBin,
    [path.join(base, 'config', 'radio.liq')],
    path.join(base, 'logs', 'liquidsoap.out.log'),
    { TZ: logTz },
  );
  procs.set(st.id, { icecast, liquidsoap });
  icecast.start();
  // Porta pública da estação (HTTP e HTTPS) atendida pelo painel; o Icecast fica só em 127.0.0.1.
  await startFront(st).catch(async (e) => {
    await stopStation(st.id);
    throw startError(`Não foi possível abrir a porta ${st.stream_port}: ${(e as Error).message}`);
  });
  // Dá um instante para o Icecast abrir a porta antes do Liquidsoap conectar.
  setTimeout(() => procs.get(st.id)?.liquidsoap?.start(), 1500);

  // Se algum dos dois cair logo na partida, devolve o motivo (fim do log) em vez de "subir" e voltar a "parada".
  await new Promise((r) => setTimeout(r, 4500));
  const p = procs.get(st.id);
  const dead = !p?.icecast.running ? 'icecast' : !p.liquidsoap?.running ? 'liquidsoap' : null;
  if (dead) {
    await stopStation(st.id);
    let log = '';
    try {
      log = fs.readFileSync(path.join(base, 'logs', `${dead}.out.log`), 'utf8');
    } catch {
      /* sem log */
    }
    // O Stereo Tool só falha de verdade ao carregar a biblioteca (depois do --check): sobe de novo sem ele, para a rádio não ficar fora do ar.
    if (dead === 'liquidsoap' && chosen.stereo && !skipStereo) {
      const reason = maskKey(tail(log));
      console.warn(`[engine] ${st.slug}: Stereo Tool recusado, subindo sem ele:\n${reason}`);
      await startStation(st, { ...skip, stereo: true });
      audioWarnings.set(st.id, `O Stereo Tool NÃO carregou e a rádio subiu com o processador interno. Motivo informado pelo Liquidsoap:\n${reason}`);
      return;
    }
    if (dead === 'liquidsoap' && chosen.root && !skip.root) {
      console.warn(`[engine] ${st.slug}: mount "/" do DJ recusado, subindo sem ele:\n${maskKey(tail(log))}`);
      await startStation(st, { ...skip, root: true });
      return;
    }
    throw startError(`${dead === 'icecast' ? 'Icecast' : 'Liquidsoap'} não ficou no ar:\n${tail(log) || '(sem saída no log)'}`);
  }
  // Rotação pela API: o Liquidsoap precisa pedir a primeira faixa logo ao subir. Se não pedir em ~25 s, a rádio ficaria muda:
  // sobe de novo com as playlists comuns.
  if (chosen.dyn && dynPlaylists > 0) {
    const since = Date.now() - 5000;
    for (let i = 0; i < 25 && lastNextCall(st.id) < since; i++) await new Promise((r) => setTimeout(r, 1000));
    if (lastNextCall(st.id) < since) {
      console.warn(`[engine] ${st.slug}: o Liquidsoap não pediu faixas à API; voltando às playlists comuns`);
      await stopStation(st.id);
      await startStation(st, { ...skip, dyn: true });
      audioWarnings.set(st.id, `A rotação pela API não respondeu e a rádio subiu com as playlists comuns (regra de artista indisponível).\n${audioWarnings.get(st.id) ?? ''}`.trim());
      return;
    }
  }
  dispatch(st.id, 'station_start', {});
}

/** Registra o motivo no log do contêiner (para diagnóstico remoto) e devolve o erro 422 ao painel. */
const startError = (msg: string) => {
  console.error(`[engine] falha ao iniciar estação: ${msg}`);
  return new HttpError(422, msg);
};

const tail = (s: string, n = 15) => maskKey(s.trim().split('\n').slice(-n).join('\n'));

export async function stopStation(stationId: number) {
  if (engineMode() === 'native') {
    if (!nativeRunning(stationId)) return;
    await stopNative(stationId);
    dispatch(stationId, 'station_stop', {});
    return;
  }
  clearLive(stationId);
  stopFront(stationId);
  const p = procs.get(stationId);
  if (!p) return;
  procs.delete(stationId);
  await Promise.all([p.liquidsoap?.stop(), p.icecast.stop()]);
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
  if (!p || !p.liquidsoap) return;
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

/** Derruba o encoder que está no ar (comando `live.stop` do harbor); o AutoDJ volta na hora. */
export async function kickLive(st: StationRow): Promise<void> {
  if (!st.autodj) {
    // Sem AutoDJ o encoder está direto no Icecast: derruba pela API de administração dele.
    const auth = Buffer.from(`admin:${st.admin_password}`).toString('base64');
    const r = await fetch(`http://127.0.0.1:${icePort(st)}/admin/killsource?mount=${encodeURIComponent(st.mount)}`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`Icecast respondeu ${r.status}`);
    return;
  }
  return kickLiveHarbor(st);
}

function kickLiveHarbor(st: StationRow): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(telnetPort(st), '127.0.0.1');
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('tempo esgotado'));
    });
    sock.on('error', reject);
    sock.on('connect', () => sock.write('live.stop\nquit\n'));
    sock.on('close', () => resolve());
  });
}

/** Executa comandos no console (telnet) local do Liquidsoap e devolve a resposta (para diagnóstico). */
export function telnetRun(stationId: number, commands: string, timeoutMs = 5000): Promise<string> {
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!st || engineMode() === 'native') return Promise.resolve('(indisponível neste modo)');
  return new Promise((resolve) => {
    let out = '';
    const sock = net.connect(telnetPort(st), '127.0.0.1');
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve(`${out.trim()}\n(sem resposta em ${timeoutMs / 1000}s: o Liquidsoap pode estar ocupado)`.trim());
    });
    sock.on('error', (e) => resolve(`(erro: ${e.message})`));
    sock.on('connect', () => sock.write(`${commands}\nquit\n`));
    sock.on('data', (d) => (out += d.toString()));
    sock.on('close', () => resolve(out.replace(/Bye!?/gi, '').trim()));
  });
}

/** Últimas linhas do log do Liquidsoap da estação (diagnóstico no painel). */
export function engineLogTail(stationId: number, lines = 120): string {
  const file = path.join(stationDir(stationId), 'logs', 'liquidsoap.out.log');
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return maskKey(buf.toString('utf8').split('\n').slice(-lines).join('\n'));
  } catch {
    return '(sem log)';
  }
}

/** Empurra um arquivo na fila de pedidos do Liquidsoap via telnet local. */
export function pushRequest(stationId: number, absPath: string, silent = false, duration = 0, hide = false, adId = 0): Promise<void> {
  const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  if (!st) return Promise.reject(new Error('Estação não encontrada'));
  if (engineMode() === 'native') {
    const m = get<MediaRow>('SELECT * FROM media WHERE station_id = ? AND path = ?', stationId, path.relative(config.dataDir, absPath));
    if (!m) return Promise.reject(new Error('Música não encontrada'));
    nativeEnqueue(stationId, m.id, silent);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const sock = net.connect(telnetPort(st), '127.0.0.1');
    // requests.push só responde depois que o Liquidsoap prepara o arquivo (com AutoCue isso inclui a análise da música,
    // que pode levar vários segundos): 3 s dava "erro interno" no pedido do ouvinte.
    // Depois de 6 s sem resposta o pedido é dado como aceito (o comando já foi entregue e continua rodando no
    // Liquidsoap); a conexão só é fechada se passar de 2 min. Assim o ouvinte não fica preso em "Enviando…".
    let settled = false;
    let reply = '';
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(soft);
      err ? reject(err) : resolve();
    };
    const soft = setTimeout(() => {
      if (sock.bytesWritten > 0) done();
    }, 50_000);
    sock.setTimeout(150_000, () => {
      sock.destroy();
      done(new Error('Timeout falando com o Liquidsoap'));
    });
    sock.on('error', (e) => done(e));
    // Vinheta pedida pela fila: o annotate mantém o nome fora do servidor.
    const uri = hide ? hiddenUri(absPath) : silent ? jingleUri(st, absPath, duration, adId) : songUriFor(absPath);
    sock.on('connect', () => sock.write(`requests.push ${uri}\nquit\n`));
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('close', () => {
      // Resposta do Liquidsoap: o número do pedido na fila (ex.: "12"). Erro ou vazio = o arquivo não entrou.
      const text = reply.replace(/Bye!?/gi, '').replace(/\bEND\b/g, '').trim();
      console.log(`[fila] ${st.slug}: requests.push ${path.basename(absPath)} -> ${text || '(sem resposta)'}`);
      if (/error|invalid|not\s+found|unknown/i.test(text) || !/\d/.test(text)) return done(new Error(`O Liquidsoap não aceitou o arquivo na fila: ${text || 'sem resposta'}`));
      done();
    });
  });
}
