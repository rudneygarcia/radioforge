import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type NowPlaying, type StreamInfo } from '../api';

interface Pub {
  name: string;
  description: string;
  streamUrl: string;
  streams: StreamInfo[];
  online: boolean;
  listeners: number;
  nowPlaying: NowPlaying | null;
  live: { name: string } | null;
  requestsEnabled: boolean;
}
interface Song {
  id: number;
  title: string;
  artist: string;
}
interface Hist {
  title: string;
  artist: string;
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

  return (
    <div className="container listen">
      <div className="card center">
        <h1>{info.name}</h1>
        <p className="muted">{info.description}</p>
        <span className={`badge ${info.online ? 'on' : 'off'}`}>{info.online ? 'no ar' : 'offline'}</span>
        {info.online && info.live && <p>🎙 <strong>Ao vivo com {info.live.name}</strong></p>}
        <p className="big small">{info.nowPlaying?.title ?? '—'}</p>
        <p className="muted">{info.nowPlaying?.artist}</p>
        <button className="play" onClick={toggle} disabled={!info.online}>{playing ? '⏸ Pausar' : '▶ Ouvir'}</button>
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
        {history.slice(0, 8).map((h, i) => <p key={i} className="muted">{h.artist ? `${h.artist} — ` : ''}{h.title}</p>)}
      </div>
      {info.requestsEnabled && songs.length > 0 && (
        <div className="card">
          <h3>Peça uma música</h3>
          <div className="picker">
            {songs.map((s) => (
              <div key={s.id} className="row between">
                <span>{s.artist ? `${s.artist} — ` : ''}{s.title}</span>
                <button className="small" onClick={() => request(s.id)}>Pedir</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
