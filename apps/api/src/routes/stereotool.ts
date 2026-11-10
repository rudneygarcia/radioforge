import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, requireAdmin, stationFor } from '../auth.js';
import crypto from 'node:crypto';
import { extractLibraryFromZip, getLicenseKey, inspectLibrary, installLibrary, libraryInfo, uploadsDir, setLibraryName, setLicenseKey, listPresets, presetPath, presetsDir, safePresetName, stereoLibDir, stereoLibPath } from '../engine/stereotool.js';

const idParam = z.object({ id: z.coerce.number().int() });
const MAX_LIB = 400 * 1024 * 1024; // o ZIP do plugin traz as bibliotecas de várias plataformas
const MAX_PRESET = 5 * 1024 * 1024;

export async function stereoToolRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // Biblioteca do Stereo Tool (do servidor inteiro).
  app.get('/api/stereotool', async () => ({ library: libraryInfo(), keySet: !!getLicenseKey() }));

  // Envio em partes (o ZIP do plugin passa de 300 MB e proxies/Cloudflare recusam requisições grandes): o navegador manda
  // pedaços de ~40 MB; no fim o servidor monta o arquivo, tira todas as bibliotecas e testa uma por uma.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const idOk = (id: string) => /^[a-f0-9-]{36}$/.test(id);
  const upFile = (id: string) => path.join(uploadsDir(), `${id}.part`);

  app.post('/api/stereotool/upload', async (req) => {
    requireAdmin(req);
    const body = z.object({ name: z.string().max(200), size: z.number().int().positive().max(1024 * 1024 * 1024) }).parse(req.body);
    fs.mkdirSync(uploadsDir(), { recursive: true });
    for (const f of fs.readdirSync(uploadsDir())) {
      // limpa envios abandonados há mais de 1 hora
      const p = path.join(uploadsDir(), f);
      if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { recursive: true, force: true });
    }
    const id = crypto.randomUUID();
    fs.writeFileSync(upFile(id), '');
    fs.writeFileSync(`${upFile(id)}.name`, body.name);
    return { id };
  });

  app.put('/api/stereotool/upload/:id', async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!idOk(id) || !fs.existsSync(upFile(id))) throw new HttpError(404, 'Envio não encontrado (recomece)');
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Parte inválida');
    fs.appendFileSync(upFile(id), req.body);
    return { received: fs.statSync(upFile(id)).size };
  });

  app.post('/api/stereotool/upload/:id/finish', async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!idOk(id) || !fs.existsSync(upFile(id))) throw new HttpError(404, 'Envio não encontrado (recomece)');
    const name = fs.readFileSync(`${upFile(id)}.name`, 'utf8');
    try {
      return { ...(await installLibrary(upFile(id), name)), library: libraryInfo() };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    } finally {
      fs.rmSync(upFile(id), { force: true });
      fs.rmSync(`${upFile(id)}.name`, { force: true });
    }
  });

  // Diagnóstico da biblioteca (arquitetura, dependências, funções exportadas) para entender "Invalid stereotool library".
  app.get('/api/stereotool/inspect', async (req) => {
    requireAdmin(req);
    return inspectLibrary();
  });

  // Chave de licença do servidor (uma só, vale para todas as estações). Nunca é devolvida.
  app.put('/api/stereotool/license', async (req) => {
    requireAdmin(req);
    const { key } = z.object({ key: z.string().max(300) }).parse(req.body);
    setLicenseKey(key);
    return { keySet: !!getLicenseKey() };
  });

  app.post('/api/stereotool/library', async (req) => {
    requireAdmin(req);
    const part = await req.file({ limits: { fileSize: MAX_LIB } });
    if (!part) throw new HttpError(400, 'Envie o arquivo da biblioteca (libStereoTool_*.so)');
    fs.mkdirSync(stereoLibDir(), { recursive: true });
    const tmp = path.join(stereoLibDir(), `.up-${Date.now()}`);
    try {
      await pipeline(part.file, fs.createWriteStream(tmp));
      if (part.file.truncated) throw new HttpError(413, 'Arquivo grande demais');
      // Aceita o ZIP baixado do site (extrai a biblioteca Linux x86_64) ou o .so direto.
      const readHead = (f: string) => {
        const fd = fs.openSync(f, 'r');
        const h = Buffer.alloc(4);
        fs.readSync(fd, h, 0, 4, 0);
        fs.closeSync(fd);
        return h;
      };
      let head = readHead(tmp);
      let libName = part.filename;
      if (head[0] === 0x50 && head[1] === 0x4b) {
        const extracted = `${tmp}.so`;
        try {
          libName = await extractLibraryFromZip(tmp, extracted);
          fs.renameSync(extracted, tmp);
        } catch (e) {
          fs.rmSync(extracted, { force: true });
          throw new HttpError(400, (e as Error).message);
        }
        head = readHead(tmp);
      }
      // Confere que é uma biblioteca Linux (ELF): o Liquidsoap roda dentro do contêiner Linux.
      if (!(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)) {
        throw new HttpError(400, 'Esse arquivo não é uma biblioteca Linux (.so). Baixe a versão "Linux" da biblioteca do Stereo Tool (libStereoTool_*.so, 64 bits).');
      }
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, stereoLibPath());
      setLibraryName(libName);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { library: libraryInfo() };
  });

  app.delete('/api/stereotool/library', async (req) => {
    requireAdmin(req);
    fs.rmSync(stereoLibPath(), { force: true });
    return { library: libraryInfo() };
  });

  // Presets por estação.
  app.get('/api/stations/:id/stereotool/presets', async (req) => {
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    return { presets: listPresets(st.id), active: st.stereo_preset };
  });

  app.post('/api/stations/:id/stereotool/presets', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const st = stationFor(req, id);
    const part = await req.file({ limits: { fileSize: MAX_PRESET } });
    if (!part) throw new HttpError(400, 'Envie o preset (.sts)');
    const name = safePresetName(part.filename);
    if (!name) {
      part.file.resume();
      throw new HttpError(400, 'O preset precisa ser um arquivo .sts (ou .ini)');
    }
    fs.mkdirSync(presetsDir(st.id), { recursive: true });
    const dest = presetPath(st.id, name);
    await pipeline(part.file, fs.createWriteStream(dest));
    if (part.file.truncated) {
      fs.rmSync(dest, { force: true });
      throw new HttpError(413, 'Preset grande demais (máximo 5 MB)');
    }
    return { presets: listPresets(st.id), name };
  });

  app.delete('/api/stations/:id/stereotool/presets/:name', async (req) => {
    requireAdmin(req);
    const { id, name } = z.object({ id: z.coerce.number().int(), name: z.string().max(100) }).parse(req.params);
    const st = stationFor(req, id);
    const safe = safePresetName(name);
    if (!safe) throw new HttpError(400, 'Nome inválido');
    fs.rmSync(presetPath(st.id, safe), { force: true });
    return { presets: listPresets(st.id) };
  });
}
