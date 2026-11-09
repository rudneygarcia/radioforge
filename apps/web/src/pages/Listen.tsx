import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type NowPlaying, type StreamInfo } from '../api';
import { Cover, Icon } from '../ui';

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
interface Req {
  id: number;
  title: string;
  artist: string;
  createdAt: string;
  mine: boolean;
  played: boolean;
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
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [sending, setSending] = useState<number | null>(null);
  const [sent, setSent] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
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
    const load = () => {
      api<Pub>(`/api/public/stations/${slug}`).then(setInfo).catch(() => setInfo(null));
      api<Hist[]>(`/api/public/stations/${slug}/history`).then(setHistory).catch(() => {});
      api<Req[]>(`/api/public/stations/${slug}/requests`).then(setReqs).catch(() => {});
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
      a.play().then(() => setPlaying(true)).catch(() => setMsg({ text: 'Não foi possível iniciar o áudio.', ok: false }));
    }
  }

  async function request(s: Song) {
    setSending(s.id);
    setMsg(null);
    try {
      await api(`/api/public/stations/${slug}/request`, { method: 'POST', body: { mediaId: s.id } });
      setSent((cur) => new Set(cur).add(s.id));
      setMsg({ text: `Pedido enviado! “${s.title}” entra na fila e toca em breve.`, ok: true });
      api<Req[]>(`/api/public/stations/${slug}/requests`).then(setReqs).catch(() => {});
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Não foi possível enviar o pedido.', ok: false });
    } finally {
      setSending(null);
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
        <div className="volume">
          <button type="button" className="icon-btn" onClick={() => setMuted((m) => !m)} aria-label={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'} title={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'}>
            <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
          </button>
          <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} aria-label="Volume" onChange={(e) => { const v = Number(e.target.value); setVolume(v); setMuted(false); }} />
        </div>
        <p className="muted">👥 {info.listeners} ouvintes</p>
        <audio ref={audio} />
      </div>
      {msg && <div className={`req-msg ${msg.ok ? 'ok' : 'err'}`} role="status"><Icon name={msg.ok ? 'check' : 'alert'} size={18} /><span>{msg.text}</span><button type="button" className="icon-btn" onClick={() => setMsg(null)} aria-label="Fechar"><Icon name="x" size={14} /></button></div>}
      <div className="card">
        <h3>Tocou recentemente</h3>
        {history.slice(0, info.historyLimit).map((h, i) => <div key={i} className="hist-item"><Cover url={h.coverUrl} size={36} /><span>{h.artist ? `${h.artist} — ` : ''}{h.title}</span></div>)}
        {history.length === 0 && <p className="muted">Nada tocou ainda.</p>}
      </div>
      {info.requestsEnabled && songs.length > 0 && !(info.live && info.liveContinue) && (
        <div className="card">
          <h3>Peça uma música</h3>
          <input className="req-search" type="search" placeholder="Buscar música ou artista…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="req-list">
            {songs
              .filter((s) => `${s.artist} ${s.title}`.toLowerCase().includes(filter.trim().toLowerCase()))
              .map((s) => (
                <div key={s.id} className="req-item">
                  <span className="req-ico"><Icon name="music" size={16} /></span>
                  <span className="req-txt"><strong>{s.title}</strong><small>{s.artist || '—'}</small></span>
                  <button type="button" className={`req-btn${sent.has(s.id) ? ' done' : ''}`} onClick={() => request(s)} disabled={s.recent || sending !== null} title={s.recent ? 'Tocou há pouco' : undefined}>
                    {sending === s.id ? 'Enviando…' : sent.has(s.id) ? 'Pedido ✓' : s.recent ? 'Tocou há pouco' : 'Pedir'}
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}
      {info.requestsEnabled && (
        <div className="card">
          <h3>Pedidos dos ouvintes</h3>
          {reqs.length === 0 && <p className="muted">Nenhum pedido ainda. Seja o primeiro!</p>}
          {reqs.map((r) => (
            <div key={r.id} className="req-item">
              <span className="req-ico"><Icon name="music" size={16} /></span>
              <span className="req-txt"><strong>{r.title}</strong><small>{r.artist || '—'}{r.mine ? ' · seu pedido' : ''}</small></span>
              <span className={`req-state ${r.played ? 'played' : 'queued'}`}>{r.played ? 'Tocou' : 'Na fila'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}
