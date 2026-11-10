import { all, type StationRow } from '../db.js';
import { isRunning } from './manager.js';
import { getLive, recordTrack, setLive } from './nowplaying.js';

/**
 * Estações sem AutoDJ: só o Icecast roda e o DJ conecta direto nele. Aqui o painel consulta o Icecast a cada poucos segundos
 * para saber se há alguém transmitindo ("ao vivo") e qual música/título o encoder está enviando (Agora tocando e histórico).
 */
const lastTitle = new Map<number, string>();

interface IceSource {
  listenurl?: string;
  title?: string;
}

async function poll(st: StationRow) {
  let sources: IceSource[] = [];
  try {
    const r = await fetch(`http://127.0.0.1:${st.stream_port}/status-json.xsl`, { signal: AbortSignal.timeout(2500) });
    const j = (await r.json()) as { icestats?: { source?: IceSource | IceSource[] } };
    const s = j.icestats?.source;
    sources = Array.isArray(s) ? s : s ? [s] : [];
  } catch {
    return;
  }
  const mine = sources.find((s) => (s.listenurl ?? '').endsWith(st.mount));
  if (!mine) {
    if (getLive(st.id)) setLive(st.id, false, 'source');
    lastTitle.delete(st.id);
    return;
  }
  if (!getLive(st.id)) setLive(st.id, true, 'source');
  const title = (mine.title ?? '').trim();
  if (title && lastTitle.get(st.id) !== title) {
    lastTitle.set(st.id, title);
    const i = title.indexOf(' - ');
    recordTrack(st.id, i > 0 ? title.slice(0, i) : '', i > 0 ? title.slice(i + 3) : title, null);
  }
}

export function startIcecastLiveWatcher() {
  setInterval(() => {
    for (const st of all<StationRow>('SELECT * FROM stations WHERE autodj = 0')) {
      if (isRunning(st.id)) void poll(st).catch(() => {});
      else if (getLive(st.id)) setLive(st.id, false, 'source');
    }
  }, 5000).unref();
}
