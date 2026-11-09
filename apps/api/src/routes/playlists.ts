import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, HttpError, stationFor } from '../auth.js';
import { all, db, get, playlistMedia, run, type PlaylistRow } from '../db.js';
import { writePlaylists } from '../engine/manager.js';

const params = z.object({ id: z.coerce.number().int(), playlistId: z.coerce.number().int().optional() });

const body = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  mode: z.enum(['shuffle', 'sequential']).default('shuffle'),
  weight: z.number().int().min(1).max(100).default(1),
  everySongs: z.number().int().min(0).max(50).default(0),
  everyMinutes: z.number().int().min(0).max(1440).default(0),
  scheduleEnabled: z.boolean().default(false),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inicial inválido').default('00:00'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário final inválido').default('23:59'),
  days: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  mediaIds: z.array(z.number().int()).default([]),
  folderIds: z.array(z.number().int()).default([]),
});

function view(p: PlaylistRow) {
  const mediaIds = all<{ media_id: number }>(
    'SELECT media_id FROM playlist_media WHERE playlist_id = ? ORDER BY position',
    p.id,
  ).map((r) => r.media_id);
  const folderIds = all<{ folder_id: number }>('SELECT folder_id FROM playlist_folders WHERE playlist_id = ?', p.id).map((r) => r.folder_id);
  return {
    id: p.id,
    name: p.name,
    enabled: !!p.enabled,
    mode: p.mode,
    weight: p.weight,
    everySongs: p.every_songs,
    everyMinutes: p.every_minutes,
    scheduleEnabled: !!p.schedule_enabled,
    startTime: p.start_time,
    endTime: p.end_time,
    days: p.days.split(',').filter(Boolean).map(Number),
    mediaIds,
    folderIds,
    // Total real de faixas: as escolhidas + as das pastas (sem repetir).
    trackCount: playlistMedia(p.id).length,
  };
}

/** Grava as pastas escolhidas, ignorando as que não pertencem à estação. */
function setFolders(playlistId: number, stationId: number, folderIds: number[]) {
  run('DELETE FROM playlist_folders WHERE playlist_id = ?', playlistId);
  for (const fid of new Set(folderIds)) {
    if (!get('SELECT 1 AS ok FROM media_folders WHERE id = ? AND station_id = ?', fid, stationId)) continue;
    run('INSERT INTO playlist_folders (playlist_id, folder_id) VALUES (?, ?)', playlistId, fid);
  }
}

/** Grava as faixas da playlist em ordem, ignorando mídias que não pertencem à estação. */
function setMedia(playlistId: number, stationId: number, mediaIds: number[]) {
  db.exec('BEGIN');
  try {
    run('DELETE FROM playlist_media WHERE playlist_id = ?', playlistId);
    let pos = 0;
    for (const mid of new Set(mediaIds)) {
      if (!get('SELECT 1 AS ok FROM media WHERE id = ? AND station_id = ?', mid, stationId)) continue;
      run('INSERT INTO playlist_media (playlist_id, media_id, position) VALUES (?, ?, ?)', playlistId, mid, pos++);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export async function playlistRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/api/stations/:id/playlists', async (req) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    return all<PlaylistRow>('SELECT * FROM playlists WHERE station_id = ? ORDER BY name', st.id).map(view);
  });

  app.post('/api/stations/:id/playlists', async (req, reply) => {
    const { id } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = body.parse(req.body);
    const r = run(
      `INSERT INTO playlists (station_id, name, enabled, mode, weight, every_songs, every_minutes, schedule_enabled, start_time, end_time, days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      st.id,
      b.name,
      b.enabled ? 1 : 0,
      b.mode,
      b.weight,
      b.everySongs,
      b.everyMinutes,
      b.scheduleEnabled ? 1 : 0,
      b.startTime,
      b.endTime,
      [...new Set(b.days)].sort().join(','),
    );
    const pid = Number(r.lastInsertRowid);
    setMedia(pid, st.id, b.mediaIds);
    setFolders(pid, st.id, b.folderIds);
    writePlaylists(st.id);
    return reply.code(201).send(view(get<PlaylistRow>('SELECT * FROM playlists WHERE id = ?', pid)!));
  });

  app.put('/api/stations/:id/playlists/:playlistId', async (req) => {
    const { id, playlistId } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = body.parse(req.body);
    const r = run(
      `UPDATE playlists SET name = ?, enabled = ?, mode = ?, weight = ?, every_songs = ?, every_minutes = ?,
         schedule_enabled = ?, start_time = ?, end_time = ?, days = ? WHERE id = ? AND station_id = ?`,
      b.name,
      b.enabled ? 1 : 0,
      b.mode,
      b.weight,
      b.everySongs,
      b.everyMinutes,
      b.scheduleEnabled ? 1 : 0,
      b.startTime,
      b.endTime,
      [...new Set(b.days)].sort().join(','),
      playlistId ?? -1,
      st.id,
    );
    if (r.changes === 0) throw new HttpError(404, 'Playlist não encontrada');
    setMedia(playlistId!, st.id, b.mediaIds);
    setFolders(playlistId!, st.id, b.folderIds);
    writePlaylists(st.id);
    return view(get<PlaylistRow>('SELECT * FROM playlists WHERE id = ?', playlistId!)!);
  });

  app.delete('/api/stations/:id/playlists/:playlistId', async (req) => {
    const { id, playlistId } = params.parse(req.params);
    const st = stationFor(req, id);
    run('DELETE FROM playlists WHERE id = ? AND station_id = ?', playlistId ?? -1, st.id);
    writePlaylists(st.id);
    return { ok: true };
  });
}
