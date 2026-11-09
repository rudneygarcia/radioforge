import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Media, type Playlist } from '../api';
import { Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Resumo em etiquetas do que a playlist faz. */
function summary(p: Playlist): string[] {
  const out: string[] = [p.mode === 'shuffle' ? 'Aleatória' : 'Sequencial'];
  if (p.scheduleEnabled) out.push(`${p.startTime}–${p.endTime} · ${p.days.length === 7 ? 'todos os dias' : p.days.map((d) => DAYS[d]).join(', ')}`);
  else if (p.everyMinutes > 0) out.push(`1 faixa a cada ${p.everyMinutes} min`);
  else if (p.everySongs > 0) out.push(`1 faixa a cada ${p.everySongs} músicas`);
  else out.push(`Peso ${p.weight}`);
  return out;
}

export default function Playlists() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/stations/${station.id}`;

  const load = async () => {
    setLists(await api<Playlist[]>(`${base}/playlists`));
    setMedia(await api<Media[]>(`${base}/media`));
  };
  useEffect(() => {
    load();
  }, [station.id]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api<Playlist>(`${base}/playlists`, { method: 'POST', body: { name } });
      setName('');
      setCreating(false);
      await load();
      setEditing(p);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      await api(`${base}/playlists/${editing.id}`, { method: 'PUT', body: editing });
      toast('Playlist salva');
      setEditing(null);
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Playlist) {
    if (!(await confirm({ title: 'Excluir playlist?', message: `"${p.name}" será removida. As músicas continuam na biblioteca.`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/playlists/${p.id}`, { method: 'DELETE' });
    toast('Playlist excluída');
    setEditing(null);
    load();
  }

  const patch = (change: Partial<Playlist>) => setEditing((p) => (p ? { ...p, ...change } : p));
  const shown = media.filter((m) => !filter.trim() || `${m.title} ${m.artist}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <>
      <div className="section-title">
        <h3>Playlists <span className="muted">({lists?.length ?? 0})</span></h3>
        <button onClick={() => setCreating(true)}><Icon name="plus" /> Nova playlist</button>
      </div>

      {lists === null && <div className="card skeleton" style={{ height: 90 }} />}
      {lists && lists.length === 0 && (
        <div className="card">
          <Empty icon="music" title="Nenhuma playlist ainda" text="Sem playlists, a estação toca a biblioteca inteira. Crie playlists para organizar a programação." action={<button onClick={() => setCreating(true)}><Icon name="plus" /> Criar playlist</button>} />
        </div>
      )}
      {lists?.map((p) => (
        <div className="card item-card" key={p.id}>
          <div>
            <div className="item-title">{p.name} {!p.enabled && <span className="badge off">desativada</span>}</div>
            <div className="meta">
              <span className="tag"><Icon name="music" size={12} /> {p.mediaIds.length} faixas</span>
              {summary(p).map((t) => <span className="tag accent" key={t}>{t}</span>)}
            </div>
          </div>
          <div className="row" style={{ margin: 0 }}>
            <button className="ghost" onClick={() => setEditing(p)}><Icon name="edit" /> Editar</button>
            <button className="icon-btn" title="Excluir" onClick={() => remove(p)}><Icon name="trash" /></button>
          </div>
        </div>
      ))}

      <Modal
        open={creating}
        size="sm"
        title="Nova playlist"
        onClose={() => setCreating(false)}
        footer={<><button className="ghost" type="button" onClick={() => setCreating(false)}>Cancelar</button><button form="new-pl" disabled={busy}>Criar</button></>}
      >
        <form id="new-pl" className="fields" onSubmit={create}>
          <label className="field"><span>Nome</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Manhã animada" required /></label>
        </form>
      </Modal>

      <Modal
        open={!!editing}
        size="lg"
        title={editing ? `Editar: ${editing.name}` : ''}
        onClose={() => setEditing(null)}
        footer={
          editing && (
            <>
              <button type="button" className="danger" style={{ marginRight: 'auto' }} onClick={() => remove(editing)}><Icon name="trash" /> Excluir</button>
              <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancelar</button>
              <button form="edit-pl" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
            </>
          )
        }
      >
        {editing && (
          <form id="edit-pl" className="fields" onSubmit={save}>
            <div className="field-row">
              <label className="field"><span>Nome</span><input value={editing.name} onChange={(e) => patch({ name: e.target.value })} required /></label>
              <label className="field">
                <span>Ordem</span>
                <select value={editing.mode} onChange={(e) => patch({ mode: e.target.value as Playlist['mode'] })}>
                  <option value="shuffle">Aleatória</option>
                  <option value="sequential">Sequencial</option>
                </select>
              </label>
              <label className="field">
                <span>Peso na rotação</span>
                <input type="number" min={1} max={100} value={editing.weight} onChange={(e) => patch({ weight: Number(e.target.value) || 1 })} />
              </label>
            </div>
            <label className="check-line"><input type="checkbox" checked={editing.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> <span>Playlist ativa</span></label>

            <div className="card" style={{ margin: 0, background: 'var(--panel-2)', boxShadow: 'none' }}>
              <h3>Quando tocar</h3>
              <div className="field-row">
                <label className="field">
                  <span>Intercalar a cada N músicas <em className="hint">(0 = desligado)</em></span>
                  <input type="number" min={0} max={50} disabled={editing.scheduleEnabled} value={editing.everySongs} onChange={(e) => patch({ everySongs: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} />
                  <small className="hint">Para vinhetas e avisos. Só no modo completo.</small>
                </label>
                <label className="field">
                  <span>Por tempo, a cada N minutos <em className="hint">(0 = desligado)</em></span>
                  <input type="number" min={0} max={1440} disabled={editing.scheduleEnabled} value={editing.everyMinutes} onChange={(e) => patch({ everyMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })} />
                  <small className="hint">60 = uma faixa todo início de hora.</small>
                </label>
              </div>
              <label className="check-line" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={editing.scheduleEnabled} onChange={(e) => patch({ scheduleEnabled: e.target.checked })} />
                <span>Agendar por dia e horário <small>Toca só nessa janela e tem prioridade sobre a rotação.</small></span>
              </label>
              {editing.scheduleEnabled && (
                <div className="fields" style={{ marginTop: 12 }}>
                  <div className="field-row">
                    <label className="field"><span>Das</span><input type="time" value={editing.startTime} onChange={(e) => patch({ startTime: e.target.value })} /></label>
                    <label className="field"><span>Às</span><input type="time" value={editing.endTime} onChange={(e) => patch({ endTime: e.target.value })} /></label>
                  </div>
                  <div className="chips">
                    {DAYS.map((d, i) => (
                      <label className="chip" key={i}>
                        <input type="checkbox" checked={editing.days.includes(i)} onChange={(e) => patch({ days: e.target.checked ? [...editing.days, i] : editing.days.filter((x) => x !== i) })} />
                        {d}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="section-title" style={{ marginBottom: 8 }}>
                <h3>Músicas <span className="muted">({editing.mediaIds.length} selecionadas)</span></h3>
                <div className="row" style={{ margin: 0 }}>
                  <button type="button" className="ghost small" onClick={() => patch({ mediaIds: [...new Set([...editing.mediaIds, ...shown.map((m) => m.id)])] })}>Marcar todas</button>
                  <button type="button" className="ghost small" onClick={() => patch({ mediaIds: editing.mediaIds.filter((id) => !shown.some((m) => m.id === id)) })}>Limpar</button>
                </div>
              </div>
              {media.length > 0 && (
                <div className="search" style={{ maxWidth: 'none', marginBottom: 10 }}>
                  <Icon name="search" />
                  <input placeholder="Filtrar músicas" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
              )}
              <div className="picker">
                {shown.map((m) => (
                  <label key={m.id} className="check-line">
                    <input type="checkbox" checked={editing.mediaIds.includes(m.id)} onChange={(e) => patch({ mediaIds: e.target.checked ? [...editing.mediaIds, m.id] : editing.mediaIds.filter((x) => x !== m.id) })} />
                    <span>{m.artist ? `${m.artist} — ` : ''}{m.title}</span>
                  </label>
                ))}
                {media.length === 0 && <p className="muted">Envie músicas na Biblioteca primeiro.</p>}
                {media.length > 0 && shown.length === 0 && <p className="muted">Nenhuma música encontrada.</p>}
              </div>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
