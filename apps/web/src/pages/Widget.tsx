import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Cover, Icon } from '../ui';
import Listen from './Listen';
import { useWidgetTheme } from './widgetTheme';

interface Pub {
  name: string;
  online: boolean;
  live: { name: string } | null;
  liveContinue?: boolean;
  historyLimit: number;
  requestsEnabled: boolean;
  coverUrl?: string | null;
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
  waiting: boolean;
}
interface Hist {
  title: string;
  artist: string;
  coverUrl?: string | null;
}

/** Widgets para incorporar em outros sites (iframe): /widget/<estação>/player | requests | history. */
export default function Widget() {
  const { type } = useParams();
  if (type === 'player') return <Listen embed />;
  if (type === 'requests') return <RequestsWidget />;
  if (type === 'history') return <HistoryWidget />;
  return <p className="center muted">Widget desconhecido.</p>;
}

function usePub(slug?: string) {
  const [info, setInfo] = useState<Pub | null>(null);
  useEffect(() => {
    const load = () => api<Pub>(`/api/public/stations/${slug}`).then(setInfo).catch(() => setInfo(null));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [slug]);
  return info;
}

/** Pedido de músicas: busca, botão pedir, resposta do envio e lista dos pedidos recentes. */
function RequestsWidget() {
  const { slug } = useParams();
  useWidgetTheme(true);
  const info = usePub(slug);
  const [songs, setSongs] = useState<Song[]>([]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [sent, setSent] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api<Song[]>(`/api/public/stations/${slug}/songs`).then(setSongs).catch(() => {});
    const load = () => api<Req[]>(`/api/public/stations/${slug}/requests`).then(setReqs).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [slug]);

  async function request(s: Song) {
    setSending(s.id);
    setMsg(null);
    try {
      const r = await api<{ delayMinutes?: number }>(`/api/public/stations/${slug}/request`, { method: 'POST', body: { mediaId: s.id } });
      setSent((cur) => new Set(cur).add(s.id));
      setMsg({ text: r.delayMinutes ? `Pedido recebido! “${s.title}” entra na programação em cerca de ${r.delayMinutes} min.` : `Pedido enviado! “${s.title}” entra na fila e toca em breve.`, ok: true });
      api<Req[]>(`/api/public/stations/${slug}/requests`).then(setReqs).catch(() => {});
    } catch (e) {
      setMsg({ text: (e as Error).message || 'Não foi possível enviar o pedido.', ok: false });
    } finally {
      setSending(null);
    }
  }

  if (!info) return <p className="center muted">Estação não encontrada.</p>;
  if (!info.requestsEnabled) return <p className="center muted">Os pedidos de música estão desativados nesta rádio.</p>;
  const blocked = !!(info.live && info.liveContinue);
  const list = songs.filter((s) => `${s.artist} ${s.title}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="widget">
      <h3>Peça uma música</h3>
      {msg && <div className={`req-msg ${msg.ok ? 'ok' : 'err'}`} role="status"><Icon name={msg.ok ? 'check' : 'alert'} size={18} /><span>{msg.text}</span><button type="button" className="icon-btn" onClick={() => setMsg(null)} aria-label="Fechar"><Icon name="x" size={14} /></button></div>}
      {blocked ? (
        <p className="muted">Estamos ao vivo agora. Os pedidos voltam quando o AutoDJ retornar.</p>
      ) : (
        <>
          <input className="req-search" type="search" placeholder="Buscar música ou artista…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="req-list">
            {list.map((s) => (
              <div key={s.id} className="req-item">
                <span className="req-ico"><Icon name="music" size={16} /></span>
                <span className="req-txt"><strong>{s.title}</strong><small>{s.artist || '—'}</small></span>
                <button type="button" className={`req-btn${sent.has(s.id) ? ' done' : ''}`} onClick={() => request(s)} disabled={s.recent || sending !== null} title={s.recent ? 'Tocou há pouco' : undefined}>
                  {sending === s.id ? 'Enviando…' : sent.has(s.id) ? 'Pedido ✓' : s.recent ? 'Tocou há pouco' : 'Pedir'}
                </button>
              </div>
            ))}
            {list.length === 0 && <p className="muted">Nenhuma música encontrada.</p>}
          </div>
        </>
      )}
      {reqs.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Pedidos dos ouvintes</h3>
          {reqs.slice(0, 8).map((r) => (
            <div key={r.id} className="req-item">
              <span className="req-ico"><Icon name="music" size={16} /></span>
              <span className="req-txt"><strong>{r.title}</strong><small>{r.artist || '—'}{r.mine ? ' · seu pedido' : ''}</small></span>
              <span className={`req-state ${r.played ? 'played' : 'queued'}`}>{r.played ? 'Tocou' : r.waiting ? 'Agendado' : 'Na fila'}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** Últimas músicas tocadas. */
function HistoryWidget() {
  const { slug } = useParams();
  useWidgetTheme(true);
  const info = usePub(slug);
  const [history, setHistory] = useState<Hist[]>([]);
  useEffect(() => {
    const load = () => api<Hist[]>(`/api/public/stations/${slug}/history`).then(setHistory).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [slug]);
  if (!info) return <p className="center muted">Estação não encontrada.</p>;
  return (
    <div className="widget">
      <h3>Tocou recentemente</h3>
      {history.slice(0, info.historyLimit).map((h, i) => (
        <div key={i} className="hist-item"><Cover url={h.coverUrl} size={36} /><span>{h.artist ? `${h.artist} — ` : ''}{h.title}</span></div>
      ))}
      {history.length === 0 && <p className="muted">Nada tocou ainda.</p>}
    </div>
  );
}
