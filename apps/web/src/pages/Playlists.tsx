import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Folder, type Media, type Playlist } from '../api';
import { Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Resumo em etiquetas do que a playlist faz. */
function summary(p: Playlist, hasDefault: boolean): string[] {
  const out: string[] = [p.mode === 'shuffle' ? 'Aleatória' : 'Sequencial'];
  if (p.isDefault) return [...out, 'Toca sempre (base da programação)'];
  if (p.jingle) out.push('Vinheta');
  if (p.requestable) out.push('Permite pedidos');
  if (p.scheduleEnabled) out.push(`${p.startTime}–${p.endTime} · ${p.days.length === 7 ? 'todos os dias' : p.days.map((d) => DAYS[d]).join(', ')}`);
  else if (p.everyMinutes > 0) out.push(`1 faixa a cada ${p.everyMinutes} min`);
  else if (p.everySongs > 0) out.push(`1 faixa a cada ${p.everySongs} músicas`);
  else if (hasDefault) out.push('⚠ Sem regra: não toca');
  else out.push(`Peso ${p.weight}`);
  return out;
}

export default function Playlists() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const [lists, setLists] = useState<Playlist[] | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderView, setFolderView] = useState<string>('all');
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/stations/${station.id}`;

  const load = async () => {
    setLists(await api<Playlist[]>(`${base}/playlists`));
    setMedia(await api<Media[]>(`${base}/media`));
    setFolders(await api<Folder[]>(`${base}/folders`));
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

  const hasDefault = !!lists?.some((p) => p.isDefault && p.trackCount > 0);
  const sortedLists = lists ? [...lists].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)) : null;
  const patch = (change: Partial<Playlist>) => setEditing((p) => (p ? { ...p, ...change } : p));
  const shown = media.filter((m) => {
    if (folderView === 'none' && m.folderId !== null) return false;
    if (folderView !== 'all' && folderView !== 'none' && m.folderId !== Number(folderView)) return false;
    return !filter.trim() || `${m.title} ${m.artist}`.toLowerCase().includes(filter.trim().toLowerCase());
  });
  // Total que a playlist terá: músicas avulsas + as das pastas marcadas (sem contar duas vezes).
  const total = editing ? new Set([...editing.mediaIds, ...media.filter((m) => m.folderId !== null && editing.folderIds.includes(m.folderId)).map((m) => m.id)]).size : 0;

  return (
    <>
      <div className="section-title">
        <h3>Playlists <span className="muted">({lists?.length ?? 0})</span></h3>
        <button onClick={() => setCreating(true)}><Icon name="plus" /> Nova playlist</button>
      </div>

      {lists && lists.length > 0 && (
        <div className="card notice">
          {hasDefault ? (
            <>
              <strong>Playlist padrão:</strong> é a base da programação e toca sempre. As outras <strong>não se misturam</strong> com ela: cada uma entra pela regra que você definir — a cada N músicas da padrão, em um dia e horário, ou a cada N minutos. Playlist sem regra não toca.
            </>
          ) : (
            <>
              <strong>Dica:</strong> marque uma playlist como <strong>padrão</strong> para ser a base da programação. Hoje, sem padrão, as playlists se misturam por peso. Com uma padrão, as demais entram só quando a regra delas manda (ex.: 1 vinheta a cada 3 músicas).
            </>
          )}
        </div>
      )}

      {lists === null && <div className="card skeleton" style={{ height: 90 }} />}
      {lists && lists.length === 0 && (
        <div className="card">
          <Empty icon="music" title="Nenhuma playlist ainda" text="Sem playlists, a estação toca a biblioteca inteira. Crie playlists para organizar a programação." action={<button onClick={() => setCreating(true)}><Icon name="plus" /> Criar playlist</button>} />
        </div>
      )}
      {sortedLists?.map((p) => (
        <div className="card item-card" key={p.id} style={p.isDefault ? { borderColor: 'color-mix(in srgb, var(--accent) 55%, var(--border))' } : undefined}>
          <div>
            <div className="item-title">{p.name} {p.isDefault && <span className="badge on" style={{ marginLeft: 4 }}>padrão</span>} {!p.enabled && <span className="badge off">desativada</span>}</div>
            <div className="meta">
              <span className="tag"><Icon name="music" size={12} /> {p.trackCount} faixas</span>
              {p.folderIds.map((id) => folders.find((f) => f.id === id)).filter(Boolean).map((f) => <span className="tag" key={f!.id}><Icon name="folder" size={12} /> {f!.name}</span>)}
              {summary(p, hasDefault).map((t) => <span className={`tag ${t.startsWith('⚠') ? '' : 'accent'}`} style={t.startsWith('⚠') ? { color: 'var(--danger)' } : undefined} key={t}>{t}</span>)}
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
              {!hasDefault && !editing.isDefault && (
                <label className="field">
                  <span>Peso na rotação</span>
                  <input type="number" min={1} max={100} value={editing.weight} onChange={(e) => patch({ weight: Number(e.target.value) || 1 })} />
                  <small className="hint">Só vale sem playlist padrão.</small>
                </label>
              )}
            </div>
            <label className="check-line"><input type="checkbox" checked={editing.enabled || editing.isDefault} disabled={editing.isDefault} onChange={(e) => patch({ enabled: e.target.checked })} /> <span>Playlist ativa</span></label>
            <label className="check-line" style={{ opacity: editing.jingle ? 0.55 : 1 }}>
              <input type="checkbox" checked={editing.isDefault && !editing.jingle} disabled={editing.jingle} onChange={(e) => patch(e.target.checked ? { isDefault: true, everySongs: 0, everyMinutes: 0, scheduleEnabled: false, enabled: true } : { isDefault: false })} />
              <span>Playlist padrão <small>É a base da programação: toca sempre e não se mistura com as outras. Só uma por estação (marcar aqui desmarca a anterior). As demais entram pelas regras delas.</small></span>
            </label>

            <div className="card" style={{ margin: 0, background: 'var(--panel-2)', boxShadow: 'none' }}>
              <h3>Tipo e pedidos</h3>
              <div className="fields">
                <label className="check-line">
                  <input type="checkbox" checked={editing.jingle} onChange={(e) => patch({ jingle: e.target.checked, requestable: e.target.checked ? false : editing.requestable, isDefault: e.target.checked ? false : editing.isDefault })} />
                  <span>Vinheta <small>Toca normalmente, mas o nome do arquivo não é enviado ao servidor: não aparece em “Tocando agora”, no histórico nem nos webhooks.</small></span>
                </label>
                <label className="check-line" style={{ opacity: editing.jingle ? 0.55 : 1 }}>
                  <input type="checkbox" checked={editing.requestable && !editing.jingle} disabled={editing.jingle} onChange={(e) => patch({ requestable: e.target.checked })} />
                  <span>Permitir pedidos desta playlist <small>As músicas dela (e das pastas marcadas) aparecem para os ouvintes pedirem no player. Só aparece se “Permitir pedidos” também estiver ligado nas Configurações da estação.</small></span>
                </label>
              </div>
            </div>

            {editing.isDefault ? (
              <div className="card notice" style={{ margin: 0 }}>Esta é a <strong>playlist padrão</strong>: toca o tempo todo. Defina as regras de entrada (a cada N músicas, horário ou tempo) nas <strong>outras</strong> playlists.</div>
            ) : (
            <div className="card" style={{ margin: 0, background: 'var(--panel-2)', boxShadow: 'none' }}>
              <h3>Quando tocar</h3>
              {hasDefault && <p className="muted small-text" style={{ marginTop: -4 }}>Esta playlist não se mistura com a padrão: ela entra por uma destas regras.</p>}
              <div className="field-row">
                <label className="field">
                  <span>{hasDefault ? 'Entra a cada N músicas da padrão' : 'Intercalar a cada N músicas'} <em className="hint">(0 = desligado)</em></span>
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
            )}

            <div className="card" style={{ margin: 0, background: 'var(--panel-2)', boxShadow: 'none' }}>
              <h3>Pastas da biblioteca</h3>
              <p className="muted small-text" style={{ marginTop: -4 }}>Marque uma pasta para incluir todas as músicas dela — inclusive as que você enviar para ela depois.</p>
              {folders.length === 0 ? (
                <p className="muted small-text">Você ainda não criou pastas. Crie na aba Biblioteca para organizar as músicas.</p>
              ) : (
                <div className="chips">
                  {folders.map((f) => (
                    <label className="chip" key={f.id}>
                      <input type="checkbox" checked={editing.folderIds.includes(f.id)} onChange={(e) => patch({ folderIds: e.target.checked ? [...editing.folderIds, f.id] : editing.folderIds.filter((x) => x !== f.id) })} />
                      <Icon name="folder" size={13} /> {f.name} <span className="muted">({f.count})</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="small-text" style={{ margin: '12px 0 0' }}><strong>{total}</strong> <span className="muted">faixa(s) no total nesta playlist</span></p>
            </div>

            <div>
              <div className="section-title" style={{ marginBottom: 8 }}>
                <h3>Músicas avulsas <span className="muted">({editing.mediaIds.length} escolhidas)</span></h3>
                <div className="row" style={{ margin: 0 }}>
                  <button type="button" className="ghost small" onClick={() => patch({ mediaIds: [...new Set([...editing.mediaIds, ...shown.map((m) => m.id)])] })}>Marcar todas</button>
                  <button type="button" className="ghost small" onClick={() => patch({ mediaIds: editing.mediaIds.filter((id) => !shown.some((m) => m.id === id)) })}>Limpar</button>
                </div>
              </div>
              {media.length > 0 && (
                <div className="toolbar">
                  <div className="search" style={{ maxWidth: 'none' }}>
                    <Icon name="search" />
                    <input placeholder="Filtrar músicas" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  </div>
                  {folders.length > 0 && (
                    <select value={folderView} onChange={(e) => setFolderView(e.target.value)}>
                      <option value="all">Todas as pastas</option>
                      <option value="none">Sem pasta</option>
                      {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  )}
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
