/**
 * Motor "simples" embutido: serve o stream MP3 direto pelo Node, sem Icecast nem Liquidsoap.
 * Serve para testar o áudio em qualquer máquina (inclusive Windows) e como alternativa quando
 * os programas de streaming não estão instalados.
 *
 * Limitações em relação ao motor Icecast + Liquidsoap: só toca MP3, sem DJ ao vivo, sem crossfade,
 * sem normalização, sem gravação e sem transcodificação (os streams extras repetem o principal).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config } from '../config.js';
import { all, avoidRecent, get, mountsFor, playlistMedia, recentMedia, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { setNativeClientProvider } from './listeners.js';
import { recordTrack, setNativeListenerCounter } from './nowplaying.js';
import { recordSession } from './sessions.js';

interface Client {
  res: http.ServerResponse;
  startedAt: Date;
  ip: string;
  ua: string;
  mount: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 100);

/** Remove tags ID3v2 (início) e ID3v1 (fim), deixando só os frames de áudio. */
function loadMp3(file: string): Buffer {
  const buf = fs.readFileSync(file);
  let start = 0;
  let end = buf.length;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  if (end - start > 128 && buf.toString('latin1', end - 128, end - 125) === 'TAG') end -= 128;
  return buf.subarray(start, end);
}

/** A janela (HH:MM) está ativa agora? Aceita janelas que cruzam a meia-noite. */
function inWindow(p: PlaylistRow, now: Date): boolean {
  if (!p.schedule_enabled) return false;
  const days = p.days.split(',').filter(Boolean).map(Number);
  if (days.length && !days.includes(now.getDay())) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const a = toMin(p.start_time);
  const b = toMin(p.end_time);
  return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b;
}

function realIp(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return xff && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') ? xff : remote;
}

class NativeStation {
  private server: http.Server | null = null;
  private clients = new Set<Client>();
  private recent: Buffer[] = [];
  private recentBytes = 0;
  private running = false;
  private queue: { id: number; silent: boolean }[] = [];
  /** Quantas faixas da rotação base já tocaram desde a última entrada de cada playlist "a cada N". */
  private since = new Map<number, number>();
  private seqIndex = new Map<number, number>();
  private lastPlayed: number[] = [];
  private nextStart = 0;

  constructor(private st: StationRow) {}

  get isRunning() {
    return this.running;
  }
  /** Ouvintes conectados agora (IP real, user-agent, tempo e stream). */
  get clientList() {
    const now = Date.now();
    return [...this.clients].map((c) => ({ ip: c.ip, ua: c.ua, mount: c.mount, seconds: Math.round((now - c.startedAt.getTime()) / 1000) }));
  }
  get listeners() {
    return this.clients.size;
  }

  enqueue(mediaId: number, silent = false) {
    this.queue.push({ id: mediaId, silent });
  }

  async start() {
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.st.stream_port, '0.0.0.0', () => {
        server.off('error', reject);
        server.on('error', (e) => console.error(`[native:${this.st.slug}]`, e));
        resolve();
      });
    });
    this.server = server;
    this.running = true;
    void this.loop();
  }

  async stop() {
    this.running = false;
    for (const c of [...this.clients]) c.res.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = (req.url ?? '/').split('?')[0];
    const mounts = new Set([this.st.mount, ...mountsFor(this.st.id).map((m) => m.mount)]);
    if (!mounts.has(url)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('RadioForge: use ' + this.st.mount);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'icy-name': ascii(this.st.name),
      'icy-br': String(this.st.bitrate),
    });
    if (req.method === 'HEAD') return void res.end();
    const client: Client = {
      res,
      startedAt: new Date(),
      // Vindo do proxy do painel (loopback), o IP real do ouvinte está em X-Forwarded-For.
      ip: realIp(req),
      ua: String(req.headers['user-agent'] ?? ''),
      mount: url,
    };
    // Entrega os últimos segundos já enviados para o player começar a tocar na hora.
    for (const chunk of this.recent) res.write(chunk);
    this.clients.add(client);
    req.on('close', () => {
      if (!this.clients.delete(client)) return;
      const secs = (Date.now() - client.startedAt.getTime()) / 1000;
      if (secs >= 5) {
        try {
          recordSession(this.st.id, client.ip, client.ua, client.mount, client.startedAt, secs);
        } catch (e) {
          console.error('[native] falha ao gravar sessão', e);
        }
      }
    });
  }

  private broadcast(chunk: Buffer, rate: number) {
    this.recent.push(chunk);
    this.recentBytes += chunk.length;
    while (this.recentBytes > rate * 3 && this.recent.length > 1) this.recentBytes -= this.recent.shift()!.length;
    for (const c of this.clients) {
      // Cliente que não acompanha (rede lenta) é desconectado para não acumular memória.
      if (c.res.writableLength > 1024 * 1024) c.res.destroy();
      else c.res.write(chunk);
    }
  }

  /** Escolhe a próxima faixa: pedidos > playlist agendada ativa > rotação por peso > biblioteca inteira. */
  /** `silent` = vinheta: toca, mas não é anunciada (fora do "tocando agora", do histórico e dos webhooks). */
  private pickNext(): { m: MediaRow; silent: boolean } | null {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      const m = get<MediaRow>('SELECT * FROM media WHERE id = ? AND station_id = ?', item.id, this.st.id);
      if (m && /\.mp3$/i.test(m.path)) return { m, silent: item.silent };
    }
    const lists = all<PlaylistRow>('SELECT * FROM playlists WHERE station_id = ? AND enabled = 1 AND every_minutes = 0', this.st.id)
      .map((p) => ({
        p,
        media: playlistMedia(p.id).filter((m) => /\.mp3$/i.test(m.path)),
      }))
      .filter((l) => l.media.length > 0);

    // Regra "não repetir por N minutos" (vinhetas ficam de fora).
    const recent = recentMedia(this.st.id, this.st.no_repeat_minutes);
    for (const l of lists) if (!l.p.is_jingle) l.media = avoidRecent(l.media, recent);

    const now = new Date();
    const scheduled = lists.filter((l) => inWindow(l.p, now));
    // Com playlist padrão, ela é a rotação; as outras só entram por regra (agendamento, "a cada N músicas" ou por tempo).
    const hasDefault = lists.some((l) => l.p.is_default && !l.p.schedule_enabled);
    const inserts = lists.filter((l) => !l.p.schedule_enabled && !l.p.is_default && l.p.every_songs > 0);

    let pool: typeof lists;
    if (scheduled.length) {
      pool = scheduled; // janela agendada ativa tem prioridade
    } else {
      // "A cada N músicas": quando a base já tocou N, entra uma faixa da playlist de inserção.
      for (const l of inserts) {
        if ((this.since.get(l.p.id) ?? 0) >= l.p.every_songs) {
          this.since.set(l.p.id, 0);
          return this.takeFrom(l);
        }
      }
      pool = hasDefault ? lists.filter((l) => l.p.is_default) : lists.filter((l) => !l.p.schedule_enabled && l.p.every_songs === 0);
      // Sem playlist padrão e só com playlists "a cada N": viram rotação comum (como no Liquidsoap).
      if (pool.length === 0 && !hasDefault) pool = inserts;
      if (!hasDefault || pool.length > 0) for (const l of inserts) this.since.set(l.p.id, (this.since.get(l.p.id) ?? 0) + 1);
    }

    if (pool.length === 0) {
      // Sem playlists utilizáveis: toca a biblioteca inteira em ordem aleatória.
      const media = avoidRecent(all<MediaRow>("SELECT * FROM media WHERE station_id = ? AND lower(path) LIKE '%.mp3'", this.st.id), recent);
      return media.length ? { m: this.shuffle(media), silent: false } : null;
    }

    // Sorteio ponderado entre as playlists elegíveis (com a padrão sozinha no pool, é ela).
    const total = pool.reduce((s, l) => s + Math.max(1, l.p.weight), 0);
    let r = Math.random() * total;
    let chosen = pool[0];
    for (const l of pool) {
      r -= Math.max(1, l.p.weight);
      if (r <= 0) {
        chosen = l;
        break;
      }
    }
    return this.takeFrom(chosen);
  }

  /** Próxima faixa de uma playlist (sequencial ou aleatória); vinheta sai silenciosa. */
  private takeFrom(l: { p: PlaylistRow; media: MediaRow[] }): { m: MediaRow; silent: boolean } {
    if (l.p.mode === 'sequential') {
      const i = this.seqIndex.get(l.p.id) ?? 0;
      this.seqIndex.set(l.p.id, (i + 1) % l.media.length);
      return { m: l.media[i % l.media.length], silent: !!l.p.is_jingle };
    }
    return { m: this.shuffle(l.media), silent: !!l.p.is_jingle };
  }

  /** Aleatório evitando repetir as últimas faixas tocadas. */
  private shuffle(media: MediaRow[]): MediaRow {
    const fresh = media.filter((m) => !this.lastPlayed.includes(m.id));
    const list = fresh.length ? fresh : media;
    const m = list[Math.floor(Math.random() * list.length)];
    this.lastPlayed.push(m.id);
    if (this.lastPlayed.length > Math.min(5, Math.max(0, media.length - 1))) this.lastPlayed.shift();
    return m;
  }

  private async loop() {
    while (this.running) {
      const pick = this.pickNext();
      const m = pick?.m;
      if (!pick || !m) {
        this.nextStart = 0;
        await sleep(3000);
        continue;
      }
      let audio: Buffer;
      try {
        audio = loadMp3(path.join(config.dataDir, m.path));
      } catch {
        await sleep(1000); // arquivo sumiu: tenta a próxima sem travar em loop quente
        continue;
      }
      // Velocidade real do arquivo em bytes/s (cobre CBR e VBR); limitada a 32–400 kbps.
      const rate = Math.min(50_000, Math.max(4_000, m.duration > 0 ? audio.length / m.duration : 16_000));
      const lead = rate; // ~1 s de folga à frente do relógio
      // Linha do tempo contínua: a faixa seguinte começa quando a anterior *termina de verdade*.
      const now = Date.now();
      if (!this.nextStart || this.nextStart < now - 2000) this.nextStart = now;
      const startedAt = this.nextStart;
      this.nextStart = startedAt + (audio.length / rate) * 1000;

      // Anuncia a música no momento em que ela realmente começa a tocar.
      const wait = startedAt - Date.now();
      if (wait > 0) await sleep(wait);
      if (!pick.silent) recordTrack(this.st.id, m.artist, m.title, m.id);

      let sent = 0;
      while (this.running && sent < audio.length) {
        const target = Math.min(audio.length, Math.floor(((Date.now() - startedAt) / 1000) * rate + lead));
        if (target > sent) {
          this.broadcast(audio.subarray(sent, target), rate);
          sent = target;
        }
        await sleep(100);
      }
    }
  }
}

const stations = new Map<number, NativeStation>();

setNativeListenerCounter((id) => stations.get(id)?.listeners ?? null);

export const nativeRunning = (id: number) => stations.get(id)?.isRunning ?? false;
export const nativeClients = (id: number) => stations.get(id)?.clientList ?? null;
setNativeClientProvider(nativeClients);

export async function startNative(st: StationRow) {
  await stopNative(st.id);
  const s = new NativeStation(st);
  try {
    await s.start();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === 'EADDRINUSE' ? `A porta ${st.stream_port} já está em uso` : `Falha ao abrir a porta ${st.stream_port}: ${(e as Error).message}`);
  }
  stations.set(st.id, s);
}

export async function stopNative(id: number) {
  const s = stations.get(id);
  if (!s) return;
  stations.delete(id);
  await s.stop();
}

export function nativeEnqueue(stationId: number, mediaId: number, silent = false) {
  stations.get(stationId)?.enqueue(mediaId, silent);
}
