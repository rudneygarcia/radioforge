import path from 'node:path';
import { config } from '../config.js';
import { all, avoidRecent, playlistMedia, recentMedia, type MediaRow, type PlaylistRow, type StationRow } from '../db.js';
import { isRunning, pushRequest, writePlaylists } from './manager.js';

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
      pushRequest(st.id, path.join(config.dataDir, m.path), !!p.is_jingle).catch((e) =>
        console.error(`[timed] falha ao enfileirar "${m.title}" na estação ${st.slug}:`, (e as Error).message),
      );
    }
  }
}

export function startTimedPlaylists() {
  tickTimedPlaylists();
  setInterval(() => {
    try {
      tickTimedPlaylists();
    } catch (e) {
      console.error('[timed] falhou:', e);
    }
  }, 30_000).unref();
}
