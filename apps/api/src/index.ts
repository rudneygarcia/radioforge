import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config, hostContext } from './config.js';
import './db.js';
import { engineMode, startAutostart, stopAll } from './engine/manager.js';
import { getTlsContext } from './engine/portfront.js';
import { startBackupScheduler } from './engine/backups.js';
import { backfillCovers } from './engine/covers.js';
import { startTimedPlaylists } from './engine/timed.js';
import { startIcecastLiveWatcher } from './engine/icecastlive.js';
import { startStatsCollector } from './engine/stats.js';
import { backupRoutes } from './routes/backups.js';
import { systemRoutes } from './routes/system.js';
import { timeClipRoutes } from './routes/timeclips.js';
import { stereoToolRoutes } from './routes/stereotool.js';
import { adRoutes } from './routes/ads.js';
import { mailRoutes } from './routes/mail.js';
import { acmeRoutes, tlsRoutes } from './routes/tls.js';
import { startSftp } from './engine/sftp.js';
import { startTlsRenewal } from './engine/tls.js';
import { setPortFront } from './engine/ports.js';
import { azuraCompatRoutes } from './routes/azuracast.js';
import { authRoutes } from './routes/auth.js';
import { djRoutes } from './routes/djs.js';
import { reportRoutes } from './routes/reports.js';
import { keyRoutes } from './routes/keys.js';
import { webhookRoutes } from './routes/webhooks.js';
import { mediaRoutes } from './routes/media.js';
import { sftpRoutes } from './routes/sftp.js';
import { playlistRoutes } from './routes/playlists.js';
import { publicRoutes } from './routes/public.js';
import { stationRoutes } from './routes/stations.js';
import { userRoutes } from './routes/users.js';

// Logs do painel com a hora local (fuso do servidor: variável TZ, padrão America/Sao_Paulo) em vez de milissegundos UTC.
const logTz = process.env.TZ || 'America/Sao_Paulo';
const logTime = () => {
  try {
    const t = new Intl.DateTimeFormat('sv-SE', { timeZone: logTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
    return `,"time":"${t}"`;
  } catch {
    return `,"time":"${new Date().toISOString()}"`;
  }
};
const app = Fastify({ logger: { timestamp: logTime }, trustProxy: true });

// Guarda o host da requisição para montar os links de stream quando PUBLIC_HOST não está definido.
app.addHook('onRequest', (req, _reply, done) => {
  const host = req.hostname.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (!/^[A-Za-z0-9.-]+$|^[0-9a-fA-F:]+$/.test(host)) return done();
  const shown = host.includes(':') ? `[${host}]` : host;
  // req.host mantém a porta (ex.: localhost:3000); req.hostname não.
  hostContext.run({ host: shown, origin: `${req.protocol}://${req.host || req.hostname}` }, done);
});

await app.register(cors, { origin: true });
await app.register(jwt, { secret: config.jwtSecret });
await app.register(multipart);

app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: err.issues.map((i) => i.message).join('; ') });
  }
  const status = err.statusCode ?? 500;
  if (status >= 500) app.log.error(err);
  reply.code(status).send({ error: status >= 500 ? 'Erro interno' : err.message });
});

await app.register(authRoutes);
await app.register(userRoutes);
await app.register(stationRoutes);
await app.register(mediaRoutes);
await app.register(sftpRoutes);
await app.register(playlistRoutes);
await app.register(djRoutes);
await app.register(reportRoutes);
await app.register(keyRoutes);
await app.register(webhookRoutes);
await app.register(publicRoutes);
await app.register(backupRoutes);
await app.register(systemRoutes);
await app.register(timeClipRoutes);
await app.register(stereoToolRoutes);
await app.register(adRoutes);
await app.register(mailRoutes);
await app.register(acmeRoutes);
await app.register(tlsRoutes);
await app.register(azuraCompatRoutes);

app.get('/api/health', async () => ({ ok: true, engine: config.engine.enabled, engineMode: engineMode() }));

// Em produção a própria API serve o painel React compilado.
if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
  await app.register(fastifyStatic, { root: config.webDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/internal')) {
      return reply.code(404).send({ error: 'Não encontrado' });
    }
    return reply.sendFile('index.html');
  });
}

const shutdown = async () => {
  await stopAll();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
// HTTPS do próprio painel (como o AzuraCast na 443): mesmo certificado das portas das rádios, escolhido por SNI. Sem certificado ainda,
// a conexão HTTPS simplesmente não completa (o painel segue em HTTP até emitir em Sistema → HTTPS).
if (config.httpsPort > 0) {
  const secure = https.createServer(
    { SNICallback: (_name, cb) => { const ctx = getTlsContext(); ctx ? cb(null, ctx) : cb(new Error('sem certificado')); } },
    (req, res) => app.routing(req, res),
  );
  secure.on('tlsClientError', () => {});
  secure.on('error', (e) => app.log.error(`HTTPS do painel: ${e.message}`));
  secure.listen(config.httpsPort, config.host);
}
// Modo Icecast+Liquidsoap: as portas das estações passam a ser atendidas pelo painel (HTTP e HTTPS) e o Icecast fica só em 127.0.0.1.
setPortFront(engineMode() === 'liquidsoap');
startTlsRenewal();
startSftp();
await startAutostart();
startStatsCollector();
backfillCovers();
startBackupScheduler();
startTimedPlaylists();
startIcecastLiveWatcher();
