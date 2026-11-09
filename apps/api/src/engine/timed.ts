import path from 'node:path';
import { config } from '../config.js';
import { all, avoidRecent, get, playlistMedia, recentMedia, run, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { tickAnnouncements } from './announce.js';
import { isRunning, pushRequest, writePlaylists } from './manager.js';
import { getLive } from './nowplaying.js';
import { isHiddenTrack } from './hide.js';

/**
 * Playlists "a cada N minutos" (ex.: 60 = uma faixa no início de cada hora).
 * A cada 30 s confere se virou um novo intervalo (alinhado ao relógio UTC) e coloca uma faixa
 * da playlist na fila de pedidos da estação; ela toca assim que a faixa atual terminar.
 */
const lastBucket = new Map<number, number>();
const seq = new Map<number, number>();

export function tickTimedPlaylists(now = Date.now()) {
  for (const st of all<StationRow>('SELECT * FROM stations')) {
    // Músicas que já passaram do tempo de "não repetir" voltam para as playlists.
    if (st.no_repeat_minutes > 0 && isRunning(st.id)) {
      try {
        writePlaylists(st.id);
      } catch (e) {
        console.error('[timed] falha ao atualizar playlists:', (e as Error).message);
      }
    }
    const lists = all<PlaylistRow>('SELECT * FROM playlists WHERE station_id = ? AND enabled = 1 AND every_minutes > 0', st.id);
    for (const p of lists) {
      const bucket = Math.floor(now / (p.every_minutes * 60_000));
      const prev = lastBucket.get(p.id);
      lastBucket.set(p.id, bucket);
      // Na primeira vez só registra o intervalo atual (não dispara logo ao ligar a API).
      if (prev === undefined || prev === bucket || !isRunning(st.id)) continue;
      if (st.live_continue && getLive(st.id)) continue; // DJ no ar: a faixa tocaria muda em segundo plano
      const media = playlistMedia(p.id);
      if (!p.is_jingle) media.splice(0, media.length, ...avoidRecent(media, recentMedia(st.id, st.no_repeat_minutes)));
      if (media.length === 0) continue;
      let m: MediaRow;
      if (p.mode === 'sequential') {
        const i = seq.get(p.id) ?? 0;
        seq.set(p.id, (i + 1) % media.length);
        m = media[i % media.length];
      } else {
        m = media[Math.floor(Math.random() * media.length)];
      }
      pushRequest(st.id, path.join(config.dataDir, m.path), !!p.is_jingle, m.duration, isHiddenTrack(st, m)).catch((e) =>
        console.error(`[timed] falha ao enfileirar "${m.title}" na estação ${st.slug}:`, (e as Error).message),
      );
    }
  }
}

/** Pedidos de ouvintes agendados (atraso configurado na estação): quando chega a hora, entram na fila do AutoDJ. */
export function tickScheduledRequests() {
  const due = all<{ id: number; station_id: number; path: string }>(
    `SELECT r.id, r.station_id, m.path FROM song_requests r JOIN media m ON m.id = r.media_id
     WHERE r.pushed = 0 AND r.due_at <= datetime('now') ORDER BY r.id LIMIT 20`,
  );
  for (const r of due) {
    const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', r.station_id);
    if (!st) continue;
    if (!isRunning(st.id) || (st.live_continue && getLive(st.id))) continue; // espera a rádio/AutoDJ voltar
    const m = get<MediaRow>('SELECT * FROM media WHERE station_id = ? AND path = ?', st.id, r.path);
    run('UPDATE song_requests SET pushed = 1 WHERE id = ?', r.id); // marca antes: não duplica se o envio demorar
    pushRequest(st.id, path.join(config.dataDir, r.path), false, 0, m ? isHiddenTrack(st, m) : false).catch((e) =>
      console.error(`[pedidos] falha ao enfileirar o pedido ${r.id}:`, (e as Error).message),
    );
  }
}

export function startTimedPlaylists() {
  tickTimedPlaylists();
  void tickAnnouncements();
  setInterval(() => {
    void tickAnnouncements().catch((e) => console.error('[hora certa] falhou:', e));
    try {
      tickTimedPlaylists();
      tickScheduledRequests();
    } catch (e) {
      console.error('[timed] falhou:', e);
    }
  }, 30_000).unref();
}
