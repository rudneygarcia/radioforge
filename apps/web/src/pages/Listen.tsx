import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type NowPlaying, type StreamInfo } from '../api';
import { Cover } from '../ui';

interface Pub {
  name: string;
  description: string;
  streamUrl: string;
  streams: StreamInfo[];
  online: boolean;
  listeners: number;
  nowPlaying: NowPlaying | null;
  live: { name: string } | null;
  /** AutoDJ roda mudo durante o ao vivo: pedidos ficam indisponíveis enquanto há DJ. */
  liveContinue?: boolean;
  historyLimit: number;
  coverUrl?: string | null;
  requestsEnabled: boolean;
}
interface Song {
  id: number;
  title: string;
  artist: string;
  /** Tocou há pouco (regra de não repetir): não dá para pedir agora. */
  recent: boolean;
}
interface Hist {
  title: string;
  artist: string;
  coverUrl?: string | null;
}

/** Player público: não exige login e pode ser aberto em iframe. */
export default function Listen() {
  const { slug } = useParams();
  const [info, setInfo] = useState<Pub | null>(null);
  const [history, setHistory] = useState<Hist[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [playing, setPlaying] = useState(false);
  const [msg, setMsg] = useState('');
  const [quality, setQuality] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const load = () => {
      api<Pub>(`/api/public/stations/${slug}`).then(setInfo).catch(() => setInfo(null));
      api<Hist[]>(`/api/public/stations/${slug}/history`).then(setHistory).catch(() => {});
    };
    load();
    api<Song[]>(`/api/public/stations/${slug}/songs`).then(setSongs).catch(() => {});
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [slug]);

  // Tela de bloqueio / notificação do celular e teclas de mídia: mostra música, artista e capa.
  useEffect(() => {
    if (!info || !('mediaSession' in navigator)) return;
    const np = info.nowPlaying;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: np?.title || info.name,
      artist: np?.artist || info.name,
      album: info.name,
      artwork: (np?.coverUrl ?? info.coverUrl) ? [{ src: new URL((np?.coverUrl ?? info.coverUrl)!, location.origin).href }] : [],
    });
  }, [info?.name, info?.nowPlaying?.title, info?.nowPlaying?.artist, info?.nowPlaying?.coverUrl, info?.coverUrl]);

  function toggle() {
    const a = audio.current;
    if (!a || !info) return;
    if (playing) {
      a.pause();
      a.removeAttribute('src');
      a.load();
      setPlaying(false);
    } else {
      // Recarrega o stream a cada play para pegar o ao vivo, não o buffer antigo.
      // Passa pelo servidor do painel (mesma origem/HTTPS) em vez de http://host:porta, que o navegador bloqueia.
      const idx = info.streams[quality] ? quality : 0;
      a.src = `/api/public/stations/${slug}/stream/${idx}?t=${Date.now()}`;
      a.play().then(() => setPlaying(true)).catch(() => setMsg('Não foi possível iniciar o áudio.'));
    }
  }

  async function request(id: number) {
    try {
      await api(`/api/public/stations/${slug}/request`, { method: 'POST', body: { mediaId: id } });
      setMsg('Pedido enviado! Toca em breve.');
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (!info) return <p className="center muted">Estação não encontrada.</p>;
  // Capa da música; sem ela, a capa da rádio; sem nenhuma, o ícone.
  const shownCover = info.nowPlaying?.coverUrl ?? info.coverUrl ?? null;

  return (
    <div className="listen-wrap">
    <div className="listen">
      <div className="card player">
        <div className="cover" style={shownCover ? { background: `center/cover url(${shownCover})` } : undefined}>{shownCover ? null : '📻'}</div>
        <h1>{info.name}</h1>
        {info.description && <p className="muted">{info.description}</p>}
        <span className={`badge ${info.online ? 'on' : 'off'}`}>{info.online ? 'no ar' : 'offline'}</span>
        {info.online && info.live && <div><span className="live-tag">Ao vivo com {info.live.name}</span></div>}
        <p className="now">{info.nowPlaying?.title ?? '—'}</p>
        <p className="muted">{info.nowPlaying?.artist}</p>
        <button className="play" onClick={toggle} disabled={!info.online}>
          {playing ? '⏸ Pausar' : '▶ Ouvir'}
          {playing && <span className="eq" aria-hidden="true"><i /><i /><i /><i /></span>}
        </button>
        {info.streams.length > 1 && !playing && (
          <select value={quality} onChange={(e) => setQuality(Number(e.target.value))}>
            {info.streams.map((s, i) => (
              <option key={s.mount} value={i}>{s.format.toUpperCase()} {s.bitrate}k</option>
            ))}
          </select>
        )}
        <p className="muted">👥 {info.listeners} ouvintes</p>
        <audio ref={audio} />
      </div>
      {msg && <p className="muted center">{msg}</p>}
      <div className="card">
        <h3>Tocou recentemente</h3>
        {history.slice(0, info.historyLimit).map((h, i) => <div key={i} className="hist-item"><Cover url={h.coverUrl} size={36} /><span>{h.artist ? `${h.artist} — ` : ''}{h.title}</span></div>)}
        {history.length === 0 && <p className="muted">Nada tocou ainda.</p>}
      </div>
      {info.requestsEnabled && songs.length > 0 && !(info.live && info.liveContinue) && (
        <div className="card">
          <h3>Peça uma música</h3>
          <div className="picker">
            {songs.map((s) => (
              <div key={s.id} className="row between">
                <span>{s.artist ? `${s.artist} — ` : ''}{s.title}</span>
                <button className="small" onClick={() => request(s.id)} disabled={s.recent} title={s.recent ? "Tocou há pouco" : undefined}>{s.recent ? "Tocou há pouco" : "Pedir"}</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
