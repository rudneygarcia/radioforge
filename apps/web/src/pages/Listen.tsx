import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type NowPlaying, type StreamInfo } from '../api';
import { Icon } from '../ui';
import { useWidgetTheme } from './widgetTheme';

interface Pub {
  name: string;
  description: string;
  streamUrl: string;
  streams: StreamInfo[];
  online: boolean;
  listeners: number;
  nowPlaying: NowPlaying | null;
  live: { name: string } | null;
  coverUrl?: string | null;
}

/** Player público: só o player. Não exige login e pode ser aberto em iframe (`embed` = versão sem margens, para os widgets). */
export default function Listen({ embed = false }: { embed?: boolean }) {
  const { slug } = useParams();
  useWidgetTheme(embed);
  const [info, setInfo] = useState<Pub | null>(null);
  const [playing, setPlaying] = useState(false);
  const [msg, setMsg] = useState('');
  const [quality, setQuality] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  // Volume do ouvinte (0–1), lembrado neste navegador.
  const [volume, setVolume] = useState(() => {
    try { const v = Number(localStorage.getItem('rf_volume')); return Number.isFinite(v) && localStorage.getItem('rf_volume') !== null ? Math.min(1, Math.max(0, v)) : 1; } catch { return 1; }
  });
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (audio.current) { audio.current.volume = volume; audio.current.muted = muted; }
    try { localStorage.setItem('rf_volume', String(volume)); } catch { /* sem armazenamento */ }
  }, [volume, muted]);

  useEffect(() => {
    const load = () => api<Pub>(`/api/public/stations/${slug}`).then(setInfo).catch(() => setInfo(null));
    load();
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
      a.play().then(() => { setPlaying(true); setMsg(''); }).catch(() => setMsg('Não foi possível iniciar o áudio.'));
    }
  }

  if (!info) return <p className="center muted">Estação não encontrada.</p>;
  // Capa da música; sem ela, a capa da rádio; sem nenhuma, o ícone.
  const shownCover = info.nowPlaying?.coverUrl ?? info.coverUrl ?? null;

  return (
    <div className={embed ? 'listen-wrap embed' : 'listen-wrap'}>
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
          <div className="volume">
            <button type="button" className="icon-btn" onClick={() => setMuted((m) => !m)} aria-label={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'} title={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'}>
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
            </button>
            <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} aria-label="Volume" onChange={(e) => { const v = Number(e.target.value); setVolume(v); setMuted(false); }} />
          </div>
          <p className="muted">👥 {info.listeners} ouvintes</p>
          {msg && <p className="muted">{msg}</p>}
          <audio ref={audio} />
        </div>
      </div>
    </div>
  );
}
