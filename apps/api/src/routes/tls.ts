import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin } from '../auth.js';
import { acmeTokens, importFromTraefik, installPem, issueTls, saveTlsSettings, tlsInfo } from '../engine/tls.js';

const host = z.string().min(3).max(253).regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, 'Domínio inválido');

/** Desafio HTTP-01 do Let's Encrypt (público): prova que o domínio aponta para este painel. */
export async function acmeRoutes(app: FastifyInstance) {
  app.get('/.well-known/acme-challenge/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().max(200) }).parse(req.params);
    const auth = acmeTokens.get(token);
    if (!auth) throw new HttpError(404, 'Desafio não encontrado');
    return reply.header('Content-Type', 'text/plain').send(auth);
  });
}

/** HTTPS nas portas das estações (certificado Let's Encrypt), só administrador. */
export async function tlsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/system/tls', async (req) => {
    requireAdmin(req);
    return tlsInfo();
  });

  app.put('/api/system/tls', async (req) => {
    requireAdmin(req);
    const b = z.object({ hosts: z.array(host).max(5), email: z.union([z.string().email(), z.literal('')]).default('') }).parse(req.body);
    saveTlsSettings(b.hosts.map((h) => h.toLowerCase()), b.email);
    return tlsInfo();
  });

  // Usa um certificado que você já tem (ex.: o do Traefik do Velix): cole o certificado completo e a chave privada, em PEM.
  app.post('/api/system/tls/pem', async (req) => {
    requireAdmin(req);
    const b = z.object({ cert: z.string().min(50).max(60000), key: z.string().min(50).max(20000) }).parse(req.body);
    try {
      installPem(b.cert, b.key, 'manual');
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return tlsInfo();
  });

  // Lê o certificado direto do acme.json do Traefik (variável TRAEFIK_ACME_JSON apontando para o arquivo montado no contêiner).
  app.post('/api/system/tls/traefik', async (req) => {
    requireAdmin(req);
    const file = process.env.TRAEFIK_ACME_JSON;
    if (!file) throw new HttpError(400, 'Defina a variável TRAEFIK_ACME_JSON com o caminho do acme.json do Traefik (montado neste contêiner).');
    try {
      if (!importFromTraefik(file)) throw new Error('Nenhum certificado do acme.json cobre o domínio informado.');
    } catch (e) {
      throw new HttpError(400, `Não foi possível ler o acme.json: ${(e as Error).message}`);
    }
    return tlsInfo();
  });

  // Pede o certificado agora (leva alguns segundos). Os domínios precisam apontar para este servidor e a porta 80 chegar ao painel.
  app.post('/api/system/tls/issue', async (req) => {
    requireAdmin(req);
    try {
      await issueTls();
    } catch (e) {
      throw new HttpError(400, `Não foi possível emitir o certificado: ${(e as Error).message}`);
    }
    return tlsInfo();
  });
}
