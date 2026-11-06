import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Webhook } from '../api';
import type { StationCtx } from './StationLayout';

const EVENTS = [
  { id: 'song_change', label: 'Troca de música' },
  { id: 'station_start', label: 'Estação iniciada' },
  { id: 'station_stop', label: 'Estação parada' },
];

export default function IntegrationsPage() {
  const { station } = useOutletContext<StationCtx>();
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [f, setF] = useState({ name: '', type: 'discord' as 'discord' | 'generic', url: '', events: ['song_change'] as string[] });
  const [error, setError] = useState('');
  const [testing, setTesting] = useState<number | null>(null);
  const base = `/api/stations/${station.id}/webhooks`;

  const load = () => api<Webhook[]>(base).then(setHooks);
  useEffect(() => {
    load();
  }, [station.id]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(base, { method: 'POST', body: f });
      setF({ ...f, name: '', url: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(h: Webhook) {
    await api(`${base}/${h.id}`, { method: 'PUT', body: { name: h.name, type: h.type, url: h.url, events: h.events, enabled: !h.enabled } });
    load();
  }

  async function remove(h: Webhook) {
    if (!confirm(`Excluir o webhook "${h.name}"?`)) return;
    await api(`${base}/${h.id}`, { method: 'DELETE' });
    load();
  }

  async function test(h: Webhook) {
    setTesting(h.id);
    try {
      await api(`${base}/${h.id}/test`, { method: 'POST' });
    } finally {
      setTesting(null);
      load();
    }
  }

  return (
    <>
      <form className="card form" onSubmit={create}>
        <h3>Novo webhook</h3>
        <p className="muted">Avisa um serviço externo quando algo acontece na estação. Para o Discord, cole a URL do webhook do canal (Editar canal → Integrações → Webhooks).</p>
        <div className="row">
          <input placeholder="Nome (ex.: Canal #rádio)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as 'discord' | 'generic' })}>
            <option value="discord">Discord</option>
            <option value="generic">Genérico (JSON assinado)</option>
          </select>
        </div>
        <input placeholder="https://…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required style={{ width: '100%', marginBottom: 12 }} />
        <div className="row">
          {EVENTS.map((ev) => (
            <label key={ev.id} className="check">
              <input
                type="checkbox"
                checked={f.events.includes(ev.id)}
                onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev.id] : f.events.filter((x) => x !== ev.id) })}
              />{' '}
              {ev.label}
            </label>
          ))}
        </div>
        <button disabled={f.events.length === 0}>Criar webhook</button>
        {error && <p className="error">{error}</p>}
      </form>

      {hooks.map((h) => (
        <div className="card" key={h.id}>
          <div className="row between">
            <strong>
              {h.name} <span className="badge off">{h.type === 'discord' ? 'Discord' : 'Genérico'}</span>{' '}
              {!h.enabled && <span className="badge off">desativado</span>}
            </strong>
            <div className="row">
              <button className="ghost small" disabled={testing === h.id} onClick={() => test(h)}>{testing === h.id ? 'Enviando…' : 'Testar'}</button>
              <button className="ghost small" onClick={() => toggle(h)}>{h.enabled ? 'Desativar' : 'Ativar'}</button>
              <button className="danger small" onClick={() => remove(h)}>Excluir</button>
            </div>
          </div>
          <p className="muted"><code>{h.url.replace(/(\/api\/webhooks\/\d+\/).+/, '$1…')}</code></p>
          <p className="muted">Eventos: {h.events.map((e) => EVENTS.find((x) => x.id === e)?.label ?? e).join(', ')}</p>
          {h.lastAt && <p className="muted">Último envio ({h.lastAt} UTC): {h.lastStatus}</p>}
          {h.secret && (
            <p className="muted">
              Segredo da assinatura: <code>{h.secret}</code>. Cada envio traz o cabeçalho <code>X-RadioForge-Signature</code> (HMAC-SHA256 do corpo com este segredo).
            </p>
          )}
        </div>
      ))}
      {hooks.length === 0 && <p className="muted">Nenhum webhook ainda.</p>}
    </>
  );
}
