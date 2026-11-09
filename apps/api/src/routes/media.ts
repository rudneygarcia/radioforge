import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { parseFile } from 'music-metadata';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { config, stationDir } from '../config.js';
import { all, db, get, run, type FolderRow, type MediaRow } from '../db.js';
import { coversDir, extractCover } from '../engine/covers.js';
import { ensureStationDirs, writePlaylists } from '../engine/manager.js';

const ALLOWED = new Set(['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.aac']);
const params = z.object({ id: z.coerce.number().int(), mediaId: z.coerce.number().int().optional() });

const mediaView = (m: MediaRow, slug = '') => ({
  coverUrl: m.cover && slug ? `/api/public/stations/${slug}/cover/${m.id}` : null,
  id: m.id,
  title: m.title,
  artist: m.artist,
  album: m.album,
  duration: m.duration,
  size: m.size,
  originalName: m.original_name,
  folderId: m.folder_id,
  hasCover: !!m.cover,
  createdAt: m.created_at,
});

const folderBody = z.object({ name: z.string().trim().min(1, 'Dê um nome à pasta').max(60) });
/** A pasta precisa ser da estação; null = sem pasta. */
function checkFolder(stationId: number, folderId: number | null | undefined): number | null {
  if (folderId === null || folderId === undefined) return null;
  if (!get('SELECT 1 AS ok FROM media_folders WHERE id = ? AND station_id = ?', folderId, stationId)) throw new HttpError(404, 'Pasta não encontrada');
  return folderId;
}

export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/media', async (req) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    return all<MediaRow>('SELECT * FROM media WHERE station_id = ? ORDER BY artist, title', st.id).map((m) => mediaView(m, st.slug));
  });

  app.post('/api/stations/:id/media', async (req, reply) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    ensureStationDirs(st.id);
    const folderId = checkFolder(st.id, z.object({ folderId: z.coerce.number().int().optional() }).parse(req.query).folderId);
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
        `INSERT INTO media (station_id, path, original_name, title, artist, album, duration, size, folder_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        st.id,
        rel,
        part.filename,
        title,
        artist,
        album,
        duration,
        fs.statSync(abs).size,
        folderId,
      );
      const row = get<MediaRow>('SELECT * FROM media WHERE id = ?', Number(r.lastInsertRowid))!;
      await extractCover(row); // capa embutida nas tags (se houver)
      created.push(mediaView(get<MediaRow>('SELECT * FROM media WHERE id = ?', row.id)!, st.slug));
    }
    writePlaylists(st.id); // pasta escolhida em playlists passa a incluir as músicas novas
    return reply.code(201).send(created);
  });

  app.put('/api/stations/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = z.object({ title: z.string().min(1), artist: z.string(), album: z.string(), folderId: z.number().int().nullable().optional() }).parse(req.body);
    const r = run(
      'UPDATE media SET title = ?, artist = ?, album = ?, folder_id = CASE WHEN ? = 1 THEN ? ELSE folder_id END WHERE id = ? AND station_id = ?',
      b.title,
      b.artist,
      b.album,
      b.folderId === undefined ? 0 : 1,
      b.folderId === undefined ? null : checkFolder(st.id, b.folderId),
      mediaId ?? -1,
      st.id,
    );
    if (r.changes === 0) throw new HttpError(404, 'Mídia não encontrada');
    writePlaylists(st.id);
    return { ok: true };
  });

  // Move várias músicas de uma vez (folderId null = tirar da pasta).
  app.post('/api/stations/:id/media/move', async (req) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = z.object({ mediaIds: z.array(z.number().int()).min(1).max(5000), folderId: z.number().int().nullable() }).parse(req.body);
    const folderId = checkFolder(st.id, b.folderId);
    db.exec('BEGIN');
    try {
      for (const mid of new Set(b.mediaIds)) run('UPDATE media SET folder_id = ? WHERE id = ? AND station_id = ?', folderId, mid, st.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    writePlaylists(st.id);
    return { ok: true };
  });

  // ---------- Pastas ----------
  app.get('/api/stations/:id/folders', async (req) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    return all<FolderRow & { n: number }>(
      `SELECT f.*, (SELECT COUNT(*) FROM media m WHERE m.folder_id = f.id) AS n FROM media_folders f WHERE f.station_id = ? ORDER BY lower(f.name)`,
      st.id,
    ).map((f) => ({ id: f.id, name: f.name, count: f.n }));
  });

  app.post('/api/stations/:id/folders', async (req, reply) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    const { name } = folderBody.parse(req.body);
    if (get('SELECT 1 AS ok FROM media_folders WHERE station_id = ? AND lower(name) = lower(?)', st.id, name)) throw new HttpError(409, 'Já existe uma pasta com esse nome');
    const r = run('INSERT INTO media_folders (station_id, name) VALUES (?, ?)', st.id, name);
    return reply.code(201).send({ id: Number(r.lastInsertRowid), name, count: 0 });
  });

  app.put('/api/stations/:id/folders/:folderId', async (req) => {
    const { id, folderId } = z.object({ id: z.coerce.number().int(), folderId: z.coerce.number().int() }).parse(req.params);
    const st = stationFor(req, id);
    const { name } = folderBody.parse(req.body);
    if (get('SELECT 1 AS ok FROM media_folders WHERE station_id = ? AND lower(name) = lower(?) AND id <> ?', st.id, name, folderId)) throw new HttpError(409, 'Já existe uma pasta com esse nome');
    const r = run('UPDATE media_folders SET name = ? WHERE id = ? AND station_id = ?', name, folderId, st.id);
    if (r.changes === 0) throw new HttpError(404, 'Pasta não encontrada');
    return { ok: true };
  });

  // Excluir a pasta NÃO apaga as músicas: elas voltam para "sem pasta".
  app.delete('/api/stations/:id/folders/:folderId', async (req) => {
    const { id, folderId } = z.object({ id: z.coerce.number().int(), folderId: z.coerce.number().int() }).parse(req.params);
    const st = stationFor(req, id);
    run('DELETE FROM media_folders WHERE id = ? AND station_id = ?', folderId, st.id);
    writePlaylists(st.id);
    return { ok: true };
  });

  app.delete('/api/stations/:id/media/:mediaId', async (req) => {
    const { id, mediaId } = params.parse(req.params);
    const st = stationFor(req, id);
    const m = get<MediaRow>('SELECT * FROM media WHERE id = ? AND station_id = ?', mediaId ?? -1, st.id);
    if (!m) throw new HttpError(404, 'Mídia não encontrada');
    run('DELETE FROM media WHERE id = ?', m.id);
    if (m.cover) fs.rmSync(path.join(coversDir(st.id), m.cover), { force: true });
    fs.rmSync(path.join(config.dataDir, m.path), { force: true });
    writePlaylists(st.id);
    return { ok: true };
  });
}

export { stationDir };
