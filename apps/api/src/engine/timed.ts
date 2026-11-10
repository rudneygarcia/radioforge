import path from 'node:path';
import { config } from '../config.js';
import { all, avoidRecent, get, playlistMedia, recentMedia, run, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { tickAnnouncements } from './announce.js';
import { isRunning, pushRequest, telnetRun, usesDynamic, writePlaylists } from './manager.js';
import { notePick } from './rotation.js';
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
    if (st.no_repeat_minutes > 0 && isRunning(st.id) && !usesDynamic(st.id)) {
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
      if (!p.is_jingle) notePick(st.id, m);
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

/**
 * Pedido que o painel enviou mas o Liquidsoap perdeu (prazo da análise, queda…): se passaram 8 min sem tocar e a fila
 * de pedidos do Liquidsoap está vazia, reenvia UMA vez. Depois de 45 min sem tocar ele sai da lista como "Não tocou".
 */
let retrying = false;
export async function retryLostRequests() {
  if (retrying) return;
  retrying = true;
  try {
    const lost = all<{ id: number; station_id: number; path: string; title: string; artist: string }>(
      `SELECT r.id, r.station_id, m.path, m.title, m.artist FROM song_requests r JOIN media m ON m.id = r.media_id
       WHERE r.pushed = 1 AND r.retried = 0 AND r.created_at < datetime('now', '-8 minutes') AND r.created_at >= datetime('now', '-45 minutes')
         AND NOT EXISTS (SELECT 1 FROM history h WHERE h.station_id = r.station_id AND h.title = m.title AND h.artist = m.artist AND h.played_at >= r.created_at)
       ORDER BY r.id LIMIT 10`,
    );
    for (const r of lost) {
      const st = get<StationRow>('SELECT * FROM stations WHERE id = ?', r.station_id);
      if (!st || !isRunning(st.id) || (st.live_continue && getLive(st.id))) continue;
      const queue = (await telnetRun(st.id, 'requests.queue')).replace(/\bEND\b/g, '').trim();
      if (/\d/.test(queue)) continue; // ainda há pedidos na fila do Liquidsoap: pode estar só esperando a vez
      run('UPDATE song_requests SET retried = 1 WHERE id = ?', r.id);
      const m = get<MediaRow>('SELECT * FROM media WHERE station_id = ? AND path = ?', st.id, r.path);
      console.warn(`[pedidos] reenviando o pedido ${r.id} (${r.artist} - ${r.title}): não tocou e a fila do Liquidsoap está vazia`);
      await pushRequest(st.id, path.join(config.dataDir, r.path), false, 0, m ? isHiddenTrack(st, m) : false).catch((e) =>
        console.error(`[pedidos] falha ao reenviar o pedido ${r.id}:`, (e as Error).message),
      );
    }
  } finally {
    retrying = false;
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
      void retryLostRequests().catch((e) => console.error('[pedidos] reenvio falhou:', e));
    } catch (e) {
      console.error('[timed] falhou:', e);
    }
  }, 30_000).unref();
}
