import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useCan } from '../auth';
import { Empty, Icon, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

type Status = 'waiting' | 'queued' | 'played' | 'expired';
interface Item {
  id: number;
  title: string;
  artist: string;
  ip: string;
  createdAt: string;
  dueAt: string;
  status: Status;
}
interface Data {
  total: number;
  stats: { total: number; today: number; waiting: number; listeners: number; top: { title: string; artist: string; count: number }[] };
  items: Item[];
}

const LABEL: Record<Status, string> = { waiting: 'Agendado', queued: 'Na fila', played: 'Tocou', expired: 'Não tocou' };
const when = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString();

export default function RequestsPage() {
  const { station } = useOutletContext<StationCtx>();
  const can = useCan();
  const { confirm, toast } = useUi();
  const [data, setData] = useState<Data | null>(null);
  const [status, setStatus] = useState<'all' | Status>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(30);
  const isAdmin = can('requests');

  const load = useCallback(() => {
    const qs = new URLSearchParams({ status, q, limit: String(limit) });
    api<Data>(`/api/stations/${station.id}/requests/all?${qs}`).then(setData).catch((e) => toast((e as Error).message, 'error'));
  }, [station.id, status, q, limit, toast]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function cancel(r: Item) {
    if (!(await confirm({ title: 'Cancelar o pedido?', message: `“${r.title}” não entrará na fila do AutoDJ.`, confirmLabel: 'Cancelar pedido', danger: true }))) return;
    try {
      await api(`/api/stations/${station.id}/requests/${r.id}`, { method: 'DELETE' });
      toast('Pedido cancelado');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const stats = data?.stats;
  return (
    <>
      {!station.requestsEnabled && <div className="card notice">Os pedidos estão desligados. Ative em Editar estação → AutoDJ, ao vivo e pedidos.</div>}

      <div className="stat-grid">
        <div className="card"><div className="stat-label"><Icon name="heart" /> Pedidos hoje</div><p className="big">{stats?.today ?? '—'}</p></div>
        <div className="card"><div className="stat-label"><Icon name="clock" /> Agendados</div><p className="big">{stats?.waiting ?? '—'}</p></div>
        <div className="card"><div className="stat-label"><Icon name="users" /> Ouvintes que pediram</div><p className="big">{stats?.listeners ?? '—'}</p><span className="muted small-text">{stats ? `${stats.total} pedidos no total` : ''}</span></div>
      </div>

      {stats && stats.top.length > 0 && (
        <div className="card section">
          <div className="section-title"><h3>Mais pedidas</h3></div>
          {stats.top.map((t, i) => (
            <div key={i} className="req-item" style={{ marginBottom: 6 }}>
              <span className="req-ico">{i + 1}</span>
              <span className="req-txt"><strong>{t.title}</strong><small>{t.artist || '—'}</small></span>
              <span className="req-state played">{t.count}×</span>
            </div>
          ))}
        </div>
      )}

      <div className="card section">
        <div className="section-title"><h3>Pedidos dos ouvintes</h3></div>
        <div className="row" style={{ marginTop: 0 }}>
          <input type="search" placeholder="Buscar por música, artista ou IP…" value={q} onChange={(e) => { setQ(e.target.value); setLimit(30); }} style={{ flex: 1, minWidth: 200 }} />
          <div className="fchips">
            {(['all', 'waiting', 'queued', 'played', 'expired'] as const).map((s) => (
              <button key={s} type="button" className={`fchip${status === s ? ' active' : ''}`} onClick={() => { setStatus(s); setLimit(30); }}>
                {s === 'all' ? 'Todos' : LABEL[s]}
              </button>
            ))}
          </div>
        </div>
        {!data ? (
          <div className="skeleton" style={{ height: 80 }} />
        ) : data.items.length === 0 ? (
          <Empty icon="heart" title="Nenhum pedido" text="Quando os ouvintes pedirem músicas pelo player público, eles aparecem aqui." />
        ) : (
          <>
            {data.items.map((r) => (
              <div key={r.id} className="req-item" style={{ marginBottom: 6 }}>
                <span className="req-ico"><Icon name="music" size={16} /></span>
                <span className="req-txt">
                  <strong>{r.title}</strong>
                  <small>{r.artist || '—'} · {when(r.createdAt)} · {r.ip}{r.status === 'waiting' && r.dueAt ? ` · entra às ${when(r.dueAt)}` : ''}</small>
                </span>
                <span className={`req-state ${r.status === 'played' ? 'played' : 'queued'}`}>{LABEL[r.status]}</span>
                {isAdmin && r.status === 'waiting' && <button type="button" className="icon-btn" title="Cancelar pedido" onClick={() => cancel(r)}><Icon name="trash" /></button>}
              </div>
            ))}
            {data.total > data.items.length && (
              <div className="row" style={{ justifyContent: 'center', marginBottom: 0 }}>
                <button type="button" className="ghost" onClick={() => setLimit((n) => n + 30)}>Ver mais ({data.total - data.items.length})</button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
