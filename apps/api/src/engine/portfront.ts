import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { StationRow } from '../db.js';
import { icePort } from './ports.js';

/**
 * "Front" das portas das estações: o painel atende a porta pública de cada estação (ex.: 8070) aceitando HTTP **e** HTTPS
 * na mesma porta (pelo primeiro byte da conexão) e repassa tudo, como TCP, para o Icecast, que escuta só em 127.0.0.1.
 * Assim https://dominio:8070/stream e http://dominio:8070/stream funcionam, no mesmo estilo do AzuraCast.
 * - Pedidos de ouvinte (GET/HEAD) recebem o cabeçalho X-Forwarded-For com o IP real, que o Icecast usa na lista de ouvintes.
 * - Encoders (SOURCE/PUT) passam sem alteração.
 */
let secureContext: tls.SecureContext | null = null;
export function setTlsContext(ctx: tls.SecureContext | null) {
  secureContext = ctx;
}
export const tlsReady = () => secureContext !== null;
/** Contexto TLS em uso (o mesmo certificado serve as portas das rádios e o HTTPS do painel). */
export const getTlsContext = () => secureContext;

const servers = new Map<number, net.Server>();
const MAX_HEAD = 16 * 1024;

function pipeToIcecast(client: net.Socket | tls.TLSSocket, ip: string, icePortNumber: number) {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), 15_000); // quem não manda o pedido logo é descartado
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0 && buf.length < MAX_HEAD) return;
    clearTimeout(timer);
    client.off('data', onData);
    client.pause();

    let out = buf;
    if (end >= 0) {
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const method = (lines[0].split(' ')[0] ?? '').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        // Sem "keep-alive": só o primeiro pedido da conexão é reescrito, então um segundo pedido não pode chegar com um IP falso.
        const kept = lines.filter((l, i) => i === 0 || !/^(x-forwarded-for|connection):/i.test(l));
        kept.splice(1, 0, `X-Forwarded-For: ${ip}`, 'Connection: close');
        out = Buffer.concat([Buffer.from(kept.join('\r\n') + '\r\n\r\n', 'latin1'), buf.subarray(end + 4)]);
      }
    }
    const up = net.connect(icePortNumber, '127.0.0.1');
    const close = () => {
      client.destroy();
      up.destroy();
    };
    up.on('error', close);
    client.on('error', close);
    up.on('connect', () => {
      up.write(out);
      client.pipe(up);
      up.pipe(client);
      client.resume();
    });
    client.on('close', close);
    up.on('close', close);
  };
  client.on('data', onData);
}

/** Abre a porta pública da estação. Devolve uma promessa que falha se a porta estiver ocupada. */
export function startFront(st: StationRow): Promise<void> {
  stopFront(st.id);
  return new Promise((resolve, reject) => {
    const target = icePort(st);
    const server = net.createServer({ pauseOnConnect: true }, (sock) => {
      const ip = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
      sock.setNoDelay(true);
      sock.once('error', () => sock.destroy());
      sock.once('data', (first: Buffer) => {
        sock.pause();
        sock.unshift(first);
        if (first[0] === 0x16) {
          // TLS (ClientHello). Sem certificado configurado não há como atender: fecha.
          if (!secureContext) return void sock.destroy();
          // O TLSSocket lê direto do "handle" do socket e ignoraria o primeiro pedaço que já lemos: usamos um Duplex intermediário.
          const wrap = new Duplex({
            read() {
              sock.resume();
            },
            write(chunk, _enc, cb) {
              sock.write(chunk, cb);
            },
            final(cb) {
              sock.end();
              cb();
            },
            destroy(err, cb) {
              sock.destroy();
              cb(err);
            },
          });
          sock.on('data', (d: Buffer) => {
            if (!wrap.push(d)) sock.pause();
          });
          sock.on('end', () => wrap.push(null));
          sock.on('close', () => wrap.destroy());
          const t = new tls.TLSSocket(wrap, { isServer: true, secureContext });
          t.on('error', () => t.destroy());
          t.on('close', () => sock.destroy());
          pipeToIcecast(t, ip, target);
          sock.resume();
          return;
        } else {
          pipeToIcecast(sock, ip, target);
        }
        sock.resume();
      });
      sock.resume();
    });
    server.once('error', (e) => reject(e));
    server.listen(st.stream_port, '0.0.0.0', () => {
      servers.set(st.id, server);
      resolve();
    });
  });
}

export function stopFront(stationId: number) {
  const s = servers.get(stationId);
  if (s) {
    s.close();
    servers.delete(stationId);
  }
}
