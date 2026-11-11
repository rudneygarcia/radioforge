import { all, type StationRow } from '../db.js';
import { isRunning } from './manager.js';
import { getLive, recordTrack, setLive } from './nowplaying.js';

/**
 * Estações sem AutoDJ: só o Icecast roda e o DJ conecta direto nele. Aqui o painel consulta o Icecast a cada poucos segundos
 * para saber se há alguém transmitindo ("ao vivo") e qual música/título o encoder está enviando (Agora tocando e histórico).
 */
const lastTitle = new Map<number, string>();

interface IceSource {
  mount: string;
  title: string;
  artist: string;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

/** Fontes conectadas, pela API de administração do Icecast (XML bem escapado). O status-json do Icecast pode vir com JSON quebrado quando o título tem aspas. */
async function viaAdminStats(st: StationRow): Promise<IceSource[] | null> {
  try {
    const auth = Buffer.from(`admin:${st.admin_password}`).toString('base64');
    const r = await fetch(`http://127.0.0.1:${st.stream_port}/admin/stats`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const xml = await r.text();
    const out: IceSource[] = [];
    for (const m of xml.matchAll(/<source mount="([^"]+)">([^]*?)<\/source>/g)) {
      const tag = (t: string) => decode(new RegExp(`<${t}>([^]*?)</${t}>`).exec(m[2])?.[1] ?? '');
      out.push({ mount: decode(m[1]), title: tag('title'), artist: tag('artist') });
    }
    return out;
  } catch {
    return null;
  }
}

async function viaStatusJson(st: StationRow): Promise<IceSource[] | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${st.stream_port}/status-json.xsl`, { signal: AbortSignal.timeout(2500) });
    const j = (await r.json()) as { icestats?: { source?: unknown } };
    const s = j.icestats?.source;
    const arr = (Array.isArray(s) ? s : s ? [s] : []) as { listenurl?: string; title?: string; artist?: string }[];
    return arr.map((x) => ({ mount: (x.listenurl ?? '').replace(/^https?:\/\/[^/]+/, ''), title: x.title ?? '', artist: x.artist ?? '' }));
  } catch {
    return null;
  }
}

async function poll(st: StationRow) {
  const sources = (await viaAdminStats(st)) ?? (await viaStatusJson(st));
  if (sources === null) return; // Icecast não respondeu: mantém o estado
  const mine = sources.find((s) => s.mount === st.mount);
  if (!mine) {
    if (getLive(st.id)) setLive(st.id, false, 'source');
    lastTitle.delete(st.id);
    return;
  }
  if (!getLive(st.id)) setLive(st.id, true, 'source');
  // O encoder manda "Artista - Música" num campo só, ou artista e título separados.
  let artist = mine.artist.trim();
  let title = mine.title.trim();
  if (!artist) {
    const i = title.indexOf(' - ');
    if (i > 0) {
      artist = title.slice(0, i).trim();
      title = title.slice(i + 3).trim();
    }
  }
  const key = `${artist}|${title}`;
  if (title && lastTitle.get(st.id) !== key) {
    lastTitle.set(st.id, key);
    recordTrack(st.id, artist, title, null);
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
