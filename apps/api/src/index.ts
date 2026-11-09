import fs from 'node:fs';
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
import { startStatsCollector } from './engine/stats.js';
import { authRoutes } from './routes/auth.js';
import { djRoutes } from './routes/djs.js';
import { reportRoutes } from './routes/reports.js';
import { keyRoutes } from './routes/keys.js';
import { webhookRoutes } from './routes/webhooks.js';
import { mediaRoutes } from './routes/media.js';
import { playlistRoutes } from './routes/playlists.js';
import { publicRoutes } from './routes/public.js';
import { stationRoutes } from './routes/stations.js';
import { userRoutes } from './routes/users.js';

const app = Fastify({ logger: true, trustProxy: true });

// Guarda o host da requisição para montar os links de stream quando PUBLIC_HOST não está definido.
app.addHook('onRequest', (req, _reply, done) => {
  const host = req.hostname.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  /^[A-Za-z0-9.-]+$|^[0-9a-fA-F:]+$/.test(host) ? hostContext.run(host.includes(':') ? `[${host}]` : host, done) : done();
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
await app.register(playlistRoutes);
await app.register(djRoutes);
await app.register(reportRoutes);
await app.register(keyRoutes);
await app.register(webhookRoutes);
await app.register(publicRoutes);

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
await startAutostart();
startStatsCollector();
