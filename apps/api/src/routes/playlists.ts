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
  jingle: z.boolean().default(false),
  /** Vinheta só para os blocos comerciais (saída/entrada de bloco): não entra na programação e não tem regra. */
  adOnly: z.boolean().default(false),
  /** Playlist padrão da estação (uma só): rotação base; as outras entram por regra. Omitido = mantém / 1ª playlist vira padrão. */
  isDefault: z.boolean().optional(),
  requestable: z.boolean().default(false),
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
    jingle: !!p.is_jingle,
    adOnly: !!p.ad_only,
    isDefault: !!p.is_default,
    requestable: !!p.requestable,
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

/**
 * A playlist padrão é a base da programação: não tem regra própria (nem agendamento, nem "a cada N"),
 * e vinheta não pode ser padrão. Ajusta o corpo e devolve se ela deve ser a padrão.
 */
function normalizeDefault(b: z.infer<typeof body>, wanted: boolean): boolean {
  const isDef = wanted && !b.jingle;
  if (isDef) {
    b.everySongs = 0;
    b.everyMinutes = 0;
    b.scheduleEnabled = false;
    b.enabled = true; // a padrão precisa estar ativa
  }
  return isDef;
}

/** Vinheta só para comercial: é sempre vinheta, nunca padrão nem pedida, e não tem regra de entrada (ela toca só nos blocos comerciais). */
function normalizeAdOnly(b: z.infer<typeof body>) {
  if (!b.adOnly) return;
  b.jingle = true;
  b.isDefault = false;
  b.requestable = false;
  b.everySongs = 0;
  b.everyMinutes = 0;
  b.scheduleEnabled = false;
}

/** Marca (ou desmarca) a padrão; só pode existir uma por estação. */
function applyDefault(stationId: number, playlistId: number, isDef: boolean) {
  if (isDef) run('UPDATE playlists SET is_default = 0 WHERE station_id = ? AND id <> ?', stationId, playlistId);
  run('UPDATE playlists SET is_default = ? WHERE id = ? AND station_id = ?', isDef ? 1 : 0, playlistId, stationId);
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
    const first = !get('SELECT 1 AS ok FROM playlists WHERE station_id = ?', st.id);
    normalizeAdOnly(b);
    const makeDefault = normalizeDefault(b, b.isDefault ?? first);
    const r = run(
      `INSERT INTO playlists (station_id, name, enabled, mode, weight, every_songs, every_minutes, is_jingle, requestable, schedule_enabled, start_time, end_time, days, ad_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      st.id,
      b.name,
      b.enabled ? 1 : 0,
      b.mode,
      b.weight,
      b.everySongs,
      b.everyMinutes,
      b.jingle ? 1 : 0,
      b.jingle ? 0 : b.requestable ? 1 : 0, // vinheta não pode ser pedida
      b.scheduleEnabled ? 1 : 0,
      b.startTime,
      b.endTime,
      [...new Set(b.days)].sort().join(','),
      b.adOnly ? 1 : 0,
    );
    const pid = Number(r.lastInsertRowid);
    applyDefault(st.id, pid, makeDefault);
    setMedia(pid, st.id, b.mediaIds);
    setFolders(pid, st.id, b.folderIds);
    writePlaylists(st.id);
    return reply.code(201).send(view(get<PlaylistRow>('SELECT * FROM playlists WHERE id = ?', pid)!));
  });

  app.put('/api/stations/:id/playlists/:playlistId', async (req) => {
    const { id, playlistId } = params.parse(req.params);
    const st = stationFor(req, id);
    const b = body.parse(req.body);
    const cur = get<PlaylistRow>('SELECT * FROM playlists WHERE id = ? AND station_id = ?', playlistId ?? -1, st.id);
    normalizeAdOnly(b);
    const makeDefault = normalizeDefault(b, b.isDefault ?? !!cur?.is_default);
    const r = run(
      `UPDATE playlists SET name = ?, enabled = ?, mode = ?, weight = ?, every_songs = ?, every_minutes = ?, is_jingle = ?, requestable = ?,
         schedule_enabled = ?, start_time = ?, end_time = ?, days = ?, ad_only = ? WHERE id = ? AND station_id = ?`,
      b.name,
      b.enabled ? 1 : 0,
      b.mode,
      b.weight,
      b.everySongs,
      b.everyMinutes,
      b.jingle ? 1 : 0,
      b.jingle ? 0 : b.requestable ? 1 : 0,
      b.scheduleEnabled ? 1 : 0,
      b.startTime,
      b.endTime,
      [...new Set(b.days)].sort().join(','),
      b.adOnly ? 1 : 0,
      playlistId ?? -1,
      st.id,
    );
    if (r.changes === 0) throw new HttpError(404, 'Playlist não encontrada');
    applyDefault(st.id, playlistId!, makeDefault);
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
