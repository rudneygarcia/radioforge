import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseFile } from 'music-metadata';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { config, stationDir } from '../config.js';
import { all, get, run, type EpisodeRow, type StationRow } from '../db.js';

const AUDIO: Record<string, string> = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
const params = z.object({ id: z.coerce.number().int(), epId: z.coerce.number().int().optional() });
const podcastDir = (stationId: number) => path.join(stationDir(stationId), 'podcast');

const view = (e: EpisodeRow) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  originalName: e.original_name,
  duration: e.duration,
  size: e.size,
  published: !!e.published,
  createdAt: e.created_at,
});

/** Lê o arquivo, descobre título/duração pelas tags e grava o episódio. `abs` já está dentro da pasta do podcast. */
async function addEpisode(st: StationRow, abs: string, originalName: string, title: string, description: string): Promise<EpisodeRow> {
  const ext = path.extname(abs).toLowerCase();
  let duration = 0;
  let finalTitle = title.trim();
  try {
    const meta = await parseFile(abs, { duration: true });
    duration = meta.format.duration ?? 0;
    if (!finalTitle) finalTitle = meta.common.title ?? '';
  } catch {
    /* sem tags legíveis */
  }
  if (!finalTitle) finalTitle = path.basename(originalName, path.extname(originalName));
  const r = run(
    `INSERT INTO podcast_episodes (station_id, title, description, path, original_name, mime, duration, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    st.id,
    finalTitle.slice(0, 200),
    description.slice(0, 4000),
    path.relative(config.dataDir, abs),
    originalName,
    AUDIO[ext] ?? 'audio/mpeg',
    duration,
    fs.statSync(abs).size,
  );
  return get<EpisodeRow>('SELECT * FROM podcast_episodes WHERE id = ?', Number(r.lastInsertRowid))!;
}

const xml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const rfc822 = (sqlDate: string) => new Date(sqlDate.replace(' ', 'T') + 'Z').toUTCString();
const origin = (req: FastifyRequest) => `${req.protocol}://${req.hostname}`;

function stationBySlug(slug: string): StationRow {
  const st = get<StationRow>('SELECT * FROM stations WHERE slug = ?', slug);
  if (!st) throw new HttpError(404, 'Estação não encontrada');
  return st;
}

export async function podcastRoutes(app: FastifyInstance) {
  // ---------- Painel (login ou chave de API) ----------
  app.register(async (admin) => {
    admin.addHook('preHandler', authenticate);

    admin.get('/api/stations/:id/podcast/episodes', async (req) => {
      const { id } = params.parse(req.params);
      const st = stationFor(req, id);
      return all<EpisodeRow>('SELECT * FROM podcast_episodes WHERE station_id = ? ORDER BY id DESC', st.id).map(view);
    });

    // multipart: campos "title" e "description" + um arquivo de áudio.
    admin.post('/api/stations/:id/podcast/episodes', async (req, reply) => {
      const { id } = params.parse(req.params);
      const st = stationFor(req, id);
      fs.mkdirSync(podcastDir(st.id), { recursive: true });
      const fields: Record<string, string> = {};
      let saved: { abs: string; name: string } | null = null;
      for await (const part of req.parts({ limits: { fileSize: 500 * 1024 * 1024, files: 1 } })) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value ?? '');
          continue;
        }
        const ext = path.extname(part.filename).toLowerCase();
        if (!AUDIO[ext]) {
          part.file.resume();
          throw new HttpError(400, `Formato não suportado: ${ext || part.filename}`);
        }
        const abs = path.join(podcastDir(st.id), `${crypto.randomUUID()}${ext}`);
        await pipeline(part.file, fs.createWriteStream(abs));
        if (part.file.truncated) {
          fs.rmSync(abs, { force: true });
          throw new HttpError(413, 'Arquivo muito grande (limite de 500 MB)');
        }
        saved = { abs, name: part.filename };
      }
      if (!saved) throw new HttpError(400, 'Envie um arquivo de áudio');
      const ep = await addEpisode(st, saved.abs, saved.name, fields.title ?? '', fields.description ?? '');
      return reply.code(201).send(view(ep));
    });

    // Publica uma gravação de transmissão ao vivo como episódio (copia o arquivo).
    admin.post('/api/stations/:id/podcast/from-recording', async (req, reply) => {
      const { id } = params.parse(req.params);
      const st = stationFor(req, id);
      const b = z
        .object({ file: z.string().regex(/^[A-Za-z0-9_.-]+\.(mp3|ogg)$/, 'Nome de arquivo inválido'), title: z.string().default(''), description: z.string().default('') })
        .parse(req.body);
      const src = path.join(stationDir(st.id), 'recordings', b.file);
      if (!fs.existsSync(src)) throw new HttpError(404, 'Gravação não encontrada');
      fs.mkdirSync(podcastDir(st.id), { recursive: true });
      const abs = path.join(podcastDir(st.id), `${crypto.randomUUID()}${path.extname(b.file).toLowerCase()}`);
      fs.copyFileSync(src, abs);
      const ep = await addEpisode(st, abs, b.file, b.title, b.description);
      return reply.code(201).send(view(ep));
    });

    admin.put('/api/stations/:id/podcast/episodes/:epId', async (req) => {
      const { id, epId } = params.parse(req.params);
      const st = stationFor(req, id);
      const b = z.object({ title: z.string().min(1).max(200), description: z.string().max(4000), published: z.boolean() }).parse(req.body);
      const r = run(
        'UPDATE podcast_episodes SET title = ?, description = ?, published = ? WHERE id = ? AND station_id = ?',
        b.title,
        b.description,
        b.published ? 1 : 0,
        epId ?? -1,
        st.id,
      );
      if (r.changes === 0) throw new HttpError(404, 'Episódio não encontrado');
      return view(get<EpisodeRow>('SELECT * FROM podcast_episodes WHERE id = ?', epId!)!);
    });

    admin.delete('/api/stations/:id/podcast/episodes/:epId', async (req) => {
      const { id, epId } = params.parse(req.params);
      const st = stationFor(req, id);
      const ep = get<EpisodeRow>('SELECT * FROM podcast_episodes WHERE id = ? AND station_id = ?', epId ?? -1, st.id);
      if (!ep) throw new HttpError(404, 'Episódio não encontrado');
      run('DELETE FROM podcast_episodes WHERE id = ?', ep.id);
      fs.rmSync(path.join(config.dataDir, ep.path), { force: true });
      return { ok: true };
    });
  });

  // ---------- Público: feed RSS e áudio (sem login, para apps de podcast) ----------
  app.get('/api/public/stations/:slug/podcast.xml', async (req, reply) => {
    const st = stationBySlug(z.object({ slug: z.string() }).parse(req.params).slug);
    const eps = all<EpisodeRow>('SELECT * FROM podcast_episodes WHERE station_id = ? AND published = 1 ORDER BY id DESC LIMIT 200', st.id);
    const base = origin(req);
    const items = eps
      .map(
        (e) => `    <item>
      <title>${xml(e.title)}</title>
      <description>${xml(e.description || e.title)}</description>
      <guid isPermaLink="false">${xml(`${st.slug}-${e.id}`)}</guid>
      <pubDate>${rfc822(e.created_at)}</pubDate>
      <enclosure url="${xml(`${base}/api/public/stations/${st.slug}/podcast/${e.id}/audio`)}" length="${e.size}" type="${xml(e.mime)}"/>
      <itunes:duration>${Math.round(e.duration)}</itunes:duration>
    </item>`,
      )
      .join('\n');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${xml(st.name)}</title>
    <link>${xml(`${base}/listen/${st.slug}`)}</link>
    <description>${xml(st.description || st.name)}</description>
    <language>pt-br</language>
    <itunes:author>${xml(st.name)}</itunes:author>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>
`;
    return reply.header('Content-Type', 'application/rss+xml; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(body);
  });

  // Áudio com suporte a Range (apps de podcast pedem trechos e fazem "pular" no episódio).
  app.get('/api/public/stations/:slug/podcast/:epId/audio', async (req, reply) => {
    const { slug, epId } = z.object({ slug: z.string(), epId: z.coerce.number().int() }).parse(req.params);
    const st = stationBySlug(slug);
    const ep = get<EpisodeRow>('SELECT * FROM podcast_episodes WHERE id = ? AND station_id = ? AND published = 1', epId, st.id);
    if (!ep) throw new HttpError(404, 'Episódio não encontrado');
    const abs = path.join(config.dataDir, ep.path);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Arquivo não encontrado');
    const size = fs.statSync(abs).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    reply.header('Content-Type', ep.mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=3600');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${size}`)
        .header('Content-Length', end - start + 1)
        .send(fs.createReadStream(abs, { start, end }));
    }
    return reply.header('Content-Length', size).send(fs.createReadStream(abs));
  });
}
