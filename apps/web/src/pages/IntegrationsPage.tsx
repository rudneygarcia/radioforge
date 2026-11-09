import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Webhook } from '../api';
import { CopyButton, Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const EVENTS = [
  { id: 'song_change', label: 'Troca de música' },
  { id: 'station_start', label: 'Estação iniciada' },
  { id: 'station_stop', label: 'Estação parada' },
];
const blank = { name: '', type: 'discord' as 'discord' | 'generic', url: '', events: ['song_change'] as string[] };

export default function IntegrationsPage() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(blank);
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
      setF(blank);
      setOpen(false);
      toast('Webhook criado');
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
    if (!(await confirm({ title: 'Excluir webhook?', message: `"${h.name}" deixa de receber avisos.`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/${h.id}`, { method: 'DELETE' });
    toast('Webhook excluído');
    load();
  }

  async function test(h: Webhook) {
    setTesting(h.id);
    try {
      await api(`${base}/${h.id}/test`, { method: 'POST' });
      toast('Teste enviado');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setTesting(null);
      load();
    }
  }

  return (
    <>
      <div className="section-title">
        <h3>Webhooks <span className="muted">({hooks?.length ?? 0})</span></h3>
        <button onClick={() => setOpen(true)}><Icon name="plus" /> Novo webhook</button>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>Avisa um serviço externo (Discord ou qualquer URL) quando algo acontece na estação.</p>

      {hooks && hooks.length === 0 && (
        <div className="card">
          <Empty icon="link" title="Nenhum webhook ainda" text="Conecte um canal do Discord para anunciar cada música, ou receba eventos assinados em um sistema seu." action={<button onClick={() => setOpen(true)}><Icon name="plus" /> Criar webhook</button>} />
        </div>
      )}

      {hooks?.map((h) => (
        <div className="card" key={h.id}>
          <div className="row between" style={{ marginBottom: 4 }}>
            <div className="item-title">
              {h.name} <span className="tag">{h.type === 'discord' ? 'Discord' : 'Genérico'}</span> {!h.enabled && <span className="badge off">desativado</span>}
            </div>
            <div className="table-actions">
              <button className="ghost small" disabled={testing === h.id} onClick={() => test(h)}>{testing === h.id ? 'Enviando…' : 'Testar'}</button>
              <button className="ghost small" onClick={() => toggle(h)}>{h.enabled ? 'Desativar' : 'Ativar'}</button>
              <button className="icon-btn" title="Excluir" onClick={() => remove(h)}><Icon name="trash" /></button>
            </div>
          </div>
          <p className="muted"><code>{h.url.replace(/(\/api\/webhooks\/\d+\/).+/, '$1…')}</code></p>
          <div className="chips" style={{ margin: '8px 0' }}>
            {h.events.map((e) => <span className="tag accent" key={e}>{EVENTS.find((x) => x.id === e)?.label ?? e}</span>)}
          </div>
          {h.lastAt && <p className="muted small-text">Último envio ({h.lastAt} UTC): {h.lastStatus}</p>}
          {h.secret && (
            <div className="copy-row">
              <span className="muted small-text">Segredo da assinatura (HMAC-SHA256 em <code>X-RadioForge-Signature</code>):</span>
              <code>{h.secret}</code>
              <CopyButton text={h.secret} />
            </div>
          )}
        </div>
      ))}

      <Modal
        open={open}
        title="Novo webhook"
        onClose={() => setOpen(false)}
        footer={<><button className="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button><button form="new-hook" disabled={f.events.length === 0}>Criar webhook</button></>}
      >
        <form id="new-hook" className="fields" onSubmit={create}>
          <div className="field-row">
            <label className="field"><span>Nome</span><input placeholder="Canal #rádio" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label className="field">
              <span>Tipo</span>
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as 'discord' | 'generic' })}>
                <option value="discord">Discord</option>
                <option value="generic">Genérico (JSON assinado)</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>URL</span>
            <input placeholder="https://…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required />
            {f.type === 'discord' && <small className="hint">No Discord: Editar canal → Integrações → Webhooks → Copiar URL.</small>}
          </label>
          <div className="field">
            <span className="label">Eventos</span>
            <div className="chips">
              {EVENTS.map((ev) => (
                <label key={ev.id} className="chip">
                  <input type="checkbox" checked={f.events.includes(ev.id)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev.id] : f.events.filter((x) => x !== ev.id) })} />
                  {ev.label}
                </label>
              ))}
            </div>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>
    </>
  );
}
