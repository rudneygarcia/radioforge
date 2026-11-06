import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { parseFile } from 'music-metadata';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { config, stationDir } from '../config.js';
import { all, get, run, type MediaRow } from '../db.js';
import { ensureStationDirs, writePlaylists } from '../engine/manager.js';

const ALLOWED = new Set(['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.aac']);
const params = z.object({ id: z.coerce.number().int(), mediaId: z.coerce.number().int().optional() });

const mediaView = (m: MediaRow) => ({
  id: m.id,
  title: m.title,
  artist: m.artist,
  album: m.album,
  duration: m.duration,
  size: m.size,
  originalName: m.original_name,
  createdAt: m.created_at,
});

export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/media', async (req) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    return all<MediaRow>('SELECT * FROM media WHERE station_id = ? ORDER BY artist, title', st.id).map(mediaView);
  });

  app.post('/api/stations/:id/media', async (req, reply) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    ensureStationDirs(st.id);
    const created: ReturnType<typeof mediaView>[] = [];

    for await (const part of req.files({ limits: { fileSize: 300 * 1024 * 1024 } })) {
      const ext = path.extname(part.filename).toLowerCase();
      if (!ALLOWED.has(ext)) {
        part.file.resume();
        throw new HttpError(400, `Formato não suportado: ${ext || part.filename}`);
      }
      // Nome em disco é sempre gerado por nós: evita path traversal e colisões.
      const rel = path.join('stations', String(st.id), 'media', `${crypto.randomUUID()}${ext}`);
      const abs = path.join(config.dataDir, rel);
      await pipeline(part.file, fs.createWriteStream(abs));
      if (part.file.truncated) {
        fs.rmSync(abs, { force: true });
        throw new HttpError(413, `Arquivo muito grande: ${part.filename}`);
      }

      let title = path.basename(part.filename, ext);
      let artist = '';
      let album = '';
      let duration = 0;
      try {
        const meta = await parseFile(abs, { duration: true });
        title = meta.common.title || title;
        artist = meta.common.artist ?? '';
        album = meta.common.album ?? '';
        duration = meta.format.duration ?? 0;
      } catch {
        // Sem tags legíveis: mantém o nome do arquivo como título.
      }
      const r = run(
        `INSERT INTO media (station_id, path, original_name, title, artist, album, duration, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        st.id,
        rel,
        part.filename,
        title,
        artist,
        album,
        duration,
        fs.statSync(abs).size,
      );
      created.push(mediaView(get<MediaRow>('SELECT * FROM media WHERE id = ?', Number(r.lastInsertRowid))!));
    }
    return reply.code(201).send(created);
  });

  app.put('/api/stations/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = z.object({ title: z.string().min(1), artist: z.string(), album: z.string() }).parse(req.body);
    const r = run(
      'UPDATE media SET title = ?, artist = ?, album = ? WHERE id = ? AND station_id = ?',
      b.title,
      b.artist,
      b.album,
      mediaId ?? -1,
      st.id,
    );
    if (r.changes === 0) throw new HttpError(404, 'Mídia não encontrada');
    return { ok: true };
  });

  app.delete('/api/stations/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = params.parse(req.params);
    const st = stationFor(req, id);
    const m = get<MediaRow>('SELECT * FROM media WHERE id = ? AND station_id = ?', mediaId ?? -1, st.id);
    if (!m) throw new HttpError(404, 'Mídia não encontrada');
    run('DELETE FROM media WHERE id = ?', m.id);
    fs.rmSync(path.join(config.dataDir, m.path), { force: true });
    writePlaylists(st.id);
    return { ok: true };
  });
}

export { stationDir };
