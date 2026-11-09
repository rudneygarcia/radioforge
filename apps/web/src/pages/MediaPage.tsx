import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, uploadForm, type Folder, type Media } from '../api';
import { Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "all" = todas as músicas, "none" = sem pasta, número = id da pasta. */
type View = 'all' | 'none' | number;

interface UpItem {
  id: number;
  name: string;
  size: number;
  loaded: number;
  /** wait = na fila, up = enviando, proc = enviado, o servidor está lendo as tags, done, error */
  status: 'wait' | 'up' | 'proc' | 'done' | 'error';
  error?: string;
}
const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function MediaPage() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const base = `/api/stations/${station.id}`;
  const [items, setItems] = useState<Media[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [view, setView] = useState<View>('all');
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<UpItem[]>([]);
  const [speed, setSpeed] = useState(0);
  const cancelled = useRef(false);
  const current = useRef<{ abort: () => void } | null>(null);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [folderModal, setFolderModal] = useState<{ id?: number; name: string } | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTo, setMoveTo] = useState<string>('none');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = async () => {
    const [m, f] = await Promise.all([api<Media[]>(`${base}/media`), api<Folder[]>(`${base}/folders`)]);
    setItems(m);
    setFolders(f);
    setPicked((p) => new Set([...p].filter((id) => m.some((x) => x.id === id))));
  };
  useEffect(() => {
    load();
  }, [station.id]);

  const folderName = (id: number | null) => folders.find((f) => f.id === id)?.name ?? null;
  const noFolderCount = (items ?? []).filter((m) => m.folderId === null).length;
  const currentFolder = typeof view === 'number' ? folders.find((f) => f.id === view) : undefined;
  // Se a pasta aberta foi apagada, volta para "Todas".
  useEffect(() => {
    if (typeof view === 'number' && folders.length && !folders.some((f) => f.id === view)) setView('all');
  }, [folders, view]);

  const patchItem = (id: number, change: Partial<UpItem>) => setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...change } : i)));

  /** Envia um arquivo por vez, mostrando o andamento de cada um e do total. */
  async function upload(files: FileList | File[] | null) {
    if (!files || !files.length || uploading) return;
    const list = [...files];
    const items: UpItem[] = list.map((f, i) => ({ id: Date.now() + i, name: f.name, size: f.size, loaded: 0, status: 'wait' }));
    setQueue(items);
    setUploading(true);
    setSpeed(0);
    cancelled.current = false;
    const qs = typeof view === 'number' ? `?folderId=${view}` : '';
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      const it = items[i];
      if (cancelled.current) {
        patchItem(it.id, { status: 'error', error: 'cancelado' });
        continue;
      }
      patchItem(it.id, { status: 'up' });
      const form = new FormData();
      form.append('file', list[i]);
      let last = { t: Date.now(), b: 0 };
      const up = uploadForm(`${base}/media${qs}`, form, (loaded, total) => {
        const now = Date.now();
        if (now - last.t >= 500) {
          setSpeed(((loaded - last.b) / (now - last.t)) * 1000);
          last = { t: now, b: loaded };
        }
        patchItem(it.id, { loaded, status: loaded >= total ? 'proc' : 'up' });
      });
      current.current = up;
      try {
        await up.promise;
        patchItem(it.id, { loaded: it.size, status: 'done' });
        ok++;
      } catch (e) {
        patchItem(it.id, { status: 'error', error: (e as Error).message });
        failed++;
      }
      current.current = null;
    }
    setUploading(false);
    setSpeed(0);
    if (input.current) input.current.value = '';
    await load();
    if (failed === 0 && ok > 0) toast(`${ok} arquivo(s) enviado(s)${currentFolder ? ` para "${currentFolder.name}"` : ''}`);
    else if (ok > 0) toast(`${ok} enviado(s), ${failed} com erro`, 'error');
    else if (failed > 0) toast('Nenhum arquivo foi enviado', 'error');
    // Some sozinho se tudo deu certo; com erro, fica até o usuário fechar.
    if (failed === 0) setTimeout(() => setQueue((q) => (q.every((x) => x.status === 'done') ? [] : q)), 4000);
  }

  function cancelUpload() {
    cancelled.current = true;
    current.current?.abort();
  }

  const totalSize = queue.reduce((s, i) => s + i.size, 0);
  const totalLoaded = queue.reduce((s, i) => s + (i.status === 'done' ? i.size : i.loaded), 0);
  const totalPct = totalSize ? Math.min(100, Math.round((totalLoaded / totalSize) * 100)) : 0;
  const doneCount = queue.filter((i) => i.status === 'done').length;
  const remaining = speed > 0 ? Math.max(0, Math.round((totalSize - totalLoaded) / speed)) : 0;

  async function removeMedia(m: Media) {
    if (!(await confirm({ title: 'Excluir música?', message: `"${m.title}" será removida da biblioteca e de todas as playlists.`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/media/${m.id}`, { method: 'DELETE' });
    toast('Música excluída');
    load();
  }

  async function saveFolder(e: FormEvent) {
    e.preventDefault();
    if (!folderModal) return;
    setError('');
    try {
      if (folderModal.id) {
        await api(`${base}/folders/${folderModal.id}`, { method: 'PUT', body: { name: folderModal.name } });
        toast('Pasta renomeada');
      } else {
        const f = await api<Folder>(`${base}/folders`, { method: 'POST', body: { name: folderModal.name } });
        toast('Pasta criada');
        setView(f.id);
      }
      setFolderModal(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeFolder(f: Folder) {
    if (!(await confirm({ title: 'Excluir pasta?', message: `A pasta "${f.name}" será removida. As ${f.count} música(s) dela NÃO são apagadas: voltam para "Sem pasta". Playlists que usavam a pasta deixam de incluí-las.`, confirmLabel: 'Excluir pasta', danger: true }))) return;
    await api(`${base}/folders/${f.id}`, { method: 'DELETE' });
    toast('Pasta excluída');
    setView('all');
    load();
  }

  async function move() {
    try {
      await api(`${base}/media/move`, { method: 'POST', body: { mediaIds: [...picked], folderId: moveTo === 'none' ? null : Number(moveTo) } });
      toast(`${picked.size} música(s) movida(s)`);
      setPicked(new Set());
      setMoveOpen(false);
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    upload(e.dataTransfer.files);
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((m) => {
      if (view === 'none' && m.folderId !== null) return false;
      if (typeof view === 'number' && m.folderId !== view) return false;
      return !t || `${m.title} ${m.artist} ${m.album}`.toLowerCase().includes(t);
    });
  }, [items, q, view]);

  const allShownPicked = shown.length > 0 && shown.every((m) => picked.has(m.id));
  const togglePick = (id: number) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setPicked((p) => { const n = new Set(p); if (allShownPicked) shown.forEach((m) => n.delete(m.id)); else shown.forEach((m) => n.add(m.id)); return n; });

  const viewTitle = view === 'all' ? 'Todas as músicas' : view === 'none' ? 'Sem pasta' : currentFolder?.name ?? '';

  return (
    <div className="lib">
      <aside className="folders card">
        <div className="section-title" style={{ marginBottom: 8 }}>
          <h3>Pastas</h3>
          <button className="icon-btn" title="Nova pasta" onClick={() => { setError(''); setFolderModal({ name: '' }); }}><Icon name="plus" /></button>
        </div>
        <nav className="folder-list">
          <button className={`folder-item ${view === 'all' ? 'active' : ''}`} onClick={() => setView('all')}>
            <Icon name="music" size={15} /> <span>Todas</span><em>{items?.length ?? 0}</em>
          </button>
          <button className={`folder-item ${view === 'none' ? 'active' : ''}`} onClick={() => setView('none')}>
            <Icon name="x" size={15} /> <span>Sem pasta</span><em>{noFolderCount}</em>
          </button>
          {folders.map((f) => (
            <button key={f.id} className={`folder-item ${view === f.id ? 'active' : ''}`} onClick={() => setView(f.id)}>
              <Icon name="folder" size={15} /> <span className="ellipsis">{f.name}</span><em>{f.count}</em>
            </button>
          ))}
        </nav>
        {folders.length === 0 && <p className="muted small-text" style={{ marginTop: 10 }}>Crie pastas para separar as músicas (ex.: Rock, Vinhetas, Jingles) e escolha a pasta inteira nas playlists.</p>}
      </aside>

      <section className="lib-main">
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        >
          <Icon name="upload" size={22} />
          <p style={{ margin: '6px 0 2px' }}><strong>{uploading ? 'Enviando… acompanhe abaixo' : currentFolder ? `Arraste músicas para "${currentFolder.name}" ou clique` : 'Arraste músicas aqui ou clique para escolher'}</strong></p>
          <span className="small-text">MP3, OGG, FLAC, WAV, M4A ou AAC (até 300 MB por arquivo)</span>
          <input ref={input} type="file" multiple hidden accept=".mp3,.ogg,.opus,.flac,.wav,.m4a,.aac" onChange={(e) => upload(e.target.files)} />
        </div>

        {queue.length > 0 && (
          <div className="card upload-panel">
            <div className="upload-head">
              <strong>
                {uploading ? `Enviando… ${doneCount} de ${queue.length}` : queue.some((i) => i.status === 'error') ? `Envio concluído com erros (${doneCount} de ${queue.length})` : `Envio concluído (${doneCount} de ${queue.length})`}
              </strong>
              <div className="row" style={{ margin: 0 }}>
                {uploading && speed > 0 && <span className="muted small-text">{bytes(speed)}/s{remaining > 0 ? ` · faltam ~${remaining < 60 ? `${remaining}s` : `${Math.ceil(remaining / 60)} min`}` : ''}</span>}
                {uploading ? <button className="danger small" onClick={cancelUpload}>Cancelar envio</button> : <button className="ghost small" onClick={() => setQueue([])}>Fechar</button>}
              </div>
            </div>
            <div className={`progress ${!uploading && queue.some((i) => i.status === 'error') ? 'error' : !uploading ? 'done' : ''}`}><i style={{ width: `${totalPct}%` }} /></div>
            <p className="muted small-text" style={{ margin: '6px 0 8px' }}>{bytes(totalLoaded)} de {bytes(totalSize)} · {totalPct}%</p>
            {queue.length > 1 || queue.some((i) => i.status === 'error') ? (
              <div className="upload-list">
                {queue.map((i) => (
                  <div className="upload-item" key={i.id}>
                    <span className="ellipsis" title={i.name}>{i.name}</span>
                    <span className={`st ${i.status === 'error' ? 'error' : i.status === 'done' ? 'done' : ''}`}>
                      {i.status === 'wait' && 'na fila'}
                      {i.status === 'up' && `${i.size ? Math.round((i.loaded / i.size) * 100) : 0}%`}
                      {i.status === 'proc' && 'processando…'}
                      {i.status === 'done' && '✓ enviado'}
                      {i.status === 'error' && (i.error ?? 'erro')}
                    </span>
                    {(i.status === 'up' || i.status === 'proc') && (
                      <div className={`progress ${i.status === 'proc' ? 'indeterminate' : ''}`}><i style={{ width: `${i.size ? Math.round((i.loaded / i.size) * 100) : 0}%` }} /></div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              uploading && queue[0]?.status === 'proc' && <p className="muted small-text" style={{ margin: 0 }}>Arquivo enviado; o servidor está lendo as informações da música…</p>
            )}
          </div>
        )}

        <div className="card tight">
          <div className="toolbar" style={{ padding: '16px 20px 0' }}>
            <h3 style={{ margin: 0 }}>{viewTitle} <span className="muted">({shown.length})</span></h3>
            {currentFolder && (
              <>
                <button className="icon-btn" title="Renomear pasta" onClick={() => { setError(''); setFolderModal({ id: currentFolder.id, name: currentFolder.name }); }}><Icon name="edit" /></button>
                <button className="icon-btn" title="Excluir pasta" onClick={() => removeFolder(currentFolder)}><Icon name="trash" /></button>
              </>
            )}
            <span className="spacer" />
            <div className="search">
              <Icon name="search" />
              <input placeholder="Buscar música" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>

          {picked.size > 0 && (
            <div className="bulkbar">
              <strong>{picked.size} selecionada(s)</strong>
              <button className="small" onClick={() => { setMoveTo('none'); setMoveOpen(true); }}><Icon name="folder" size={13} /> Mover para pasta…</button>
              <button className="ghost small" onClick={() => setPicked(new Set())}>Limpar seleção</button>
            </div>
          )}

          {items === null ? (
            <div className="skeleton" style={{ height: 120, margin: 20, borderRadius: 12 }} />
          ) : items.length === 0 ? (
            <Empty icon="music" title="Biblioteca vazia" text="Envie suas músicas para montar playlists e colocar a rádio no ar." />
          ) : shown.length === 0 ? (
            <Empty icon={q ? 'search' : 'folder'} title={q ? 'Nada encontrado' : 'Pasta vazia'} text={q ? `Nenhuma música combina com "${q}".` : 'Envie músicas para cá ou mova outras para esta pasta.'} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={allShownPicked} onChange={toggleAll} aria-label="Selecionar todas" /></th>
                  <th>Título</th><th>Artista</th>{view === 'all' && <th className="hide-sm">Pasta</th>}<th>Duração</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id} className={picked.has(m.id) ? 'picked' : ''}>
                    <td><input type="checkbox" checked={picked.has(m.id)} onChange={() => togglePick(m.id)} aria-label={`Selecionar ${m.title}`} /></td>
                    <td>{m.title}</td>
                    <td className="muted">{m.artist || '—'}</td>
                    {view === 'all' && <td className="hide-sm">{folderName(m.folderId) ? <span className="tag"><Icon name="folder" size={12} /> {folderName(m.folderId)}</span> : <span className="muted">—</span>}</td>}
                    <td className="muted">{fmt(m.duration)}</td>
                    <td><div className="table-actions"><button className="icon-btn" title="Excluir" onClick={() => removeMedia(m)}><Icon name="trash" /></button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <Modal
        open={!!folderModal}
        size="sm"
        title={folderModal?.id ? 'Renomear pasta' : 'Nova pasta'}
        onClose={() => setFolderModal(null)}
        footer={<><button className="ghost" type="button" onClick={() => setFolderModal(null)}>Cancelar</button><button form="folder-form">{folderModal?.id ? 'Salvar' : 'Criar pasta'}</button></>}
      >
        {folderModal && (
          <form id="folder-form" className="fields" onSubmit={saveFolder}>
            <label className="field"><span>Nome da pasta</span><input value={folderModal.name} onChange={(e) => setFolderModal({ ...folderModal, name: e.target.value })} placeholder="Ex.: Rock anos 90" maxLength={60} required /></label>
            {error && <p className="error">{error}</p>}
          </form>
        )}
      </Modal>

      <Modal
        open={moveOpen}
        size="sm"
        title={`Mover ${picked.size} música(s)`}
        onClose={() => setMoveOpen(false)}
        footer={<><button className="ghost" type="button" onClick={() => setMoveOpen(false)}>Cancelar</button><button onClick={move}>Mover</button></>}
      >
        <label className="field">
          <span>Para a pasta</span>
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="none">Sem pasta</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        {folders.length === 0 && <p className="muted small-text">Você ainda não tem pastas. Feche e crie uma no botão + ao lado de “Pastas”.</p>}
      </Modal>
    </div>
  );
}
