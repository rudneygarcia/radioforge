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
  }, [volume, muted, info !== null]);

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
      a.volume = volume;
      a.muted = muted;
      a.src = `/api/public/stations/${slug}/stream/${idx}?t=${Date.now()}`;
      a.play().then(() => { setPlaying(true); setMsg(''); }).catch(() => setMsg('Não foi possível iniciar o áudio.'));
    }
  }

  if (!info) return <p className="center muted">Estação não encontrada.</p>;
  // Capa da música; sem ela, a capa da rádio; sem nenhuma, o ícone.
  const shownCover = info.nowPlaying?.coverUrl ?? info.coverUrl ?? null;
  const vol = muted ? 0 : volume;
  const title = info.nowPlaying?.title ?? (info.online ? 'Sem informação da música' : 'Rádio offline');

  return (
    <div className={`pl-page${embed ? ' embed' : ''}${playing ? ' is-playing' : ''}`}>
      <div className="pl-bg" style={shownCover ? { backgroundImage: `url(${shownCover})` } : undefined} aria-hidden="true" />
      <div className="pl-shell">
        {!embed && (
          <header className="pl-top">
            <div className="pl-brand">
              {info.coverUrl ? <img src={info.coverUrl} alt="" /> : <span className="pl-brand-ico">📻</span>}
              <div>
                <strong>{info.name}</strong>
                {info.description && <small>{info.description}</small>}
              </div>
            </div>
            <span className="pl-listeners"><Icon name="users" size={15} /> {info.listeners} {info.listeners === 1 ? 'ouvinte' : 'ouvintes'}</span>
          </header>
        )}

        <section className="pl-card">
          <div className="pl-art">
            {shownCover ? <img src={shownCover} alt="" /> : <span className="pl-art-ph">📻</span>}
          </div>
          <div className="pl-info">
            <span className={`pl-kicker ${info.online ? (info.live ? 'live' : 'on') : 'off'}`}>
              <i /> {info.online ? (info.live ? `AO VIVO · ${info.live.name}` : 'NO AR AGORA') : 'OFFLINE'}
            </span>
            {embed && <span className="pl-embed-name">{info.name}</span>}
            <h2 className="pl-title" title={title}>{title}</h2>
            <p className="pl-artist">{info.nowPlaying?.artist || (info.online ? info.name : '')}</p>

            <div className="pl-eq" aria-hidden="true">
              {Array.from({ length: 28 }, (_, i) => <i key={i} style={{ animationDelay: `${(i * 83) % 700}ms` }} />)}
            </div>

            <div className="pl-controls">
              <button type="button" className="pl-play" onClick={toggle} disabled={!info.online} aria-label={playing ? 'Pausar' : 'Ouvir'}>
                {playing ? (
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2" /><rect x="13.8" y="5" width="4.2" height="14" rx="1.2" /></svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" /></svg>
                )}
              </button>
              <div className="pl-vol">
                <button type="button" onClick={() => setMuted((m) => !m)} aria-label={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'} title={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'}>
                  <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={20} />
                </button>
                <input type="range" min={0} max={1} step={0.01} value={vol} aria-label="Volume" style={{ ['--v' as string]: `${Math.round(vol * 100)}%` }} onChange={(e) => { const v = Number(e.target.value); setVolume(v); setMuted(false); }} />
              </div>
              {info.streams.length > 1 && !playing && (
                <select className="pl-quality" value={quality} onChange={(e) => setQuality(Number(e.target.value))} aria-label="Qualidade">
                  {info.streams.map((st, i) => (
                    <option key={st.mount} value={i}>{st.format.toUpperCase()} {st.bitrate}k</option>
                  ))}
                </select>
              )}
            </div>
            {msg && <p className="pl-msg">{msg}</p>}
            {embed && <span className="pl-listeners small"><Icon name="users" size={14} /> {info.listeners} {info.listeners === 1 ? 'ouvinte' : 'ouvintes'}</span>}
          </div>
        </section>
      </div>
      <audio ref={audio} />
    </div>
  );
}
