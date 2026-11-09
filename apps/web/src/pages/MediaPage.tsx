import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, uploadForm, type Folder, type Media } from '../api';
import { Cover, Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface UpItem {
  id: number;
  name: string;
  size: number;
  loaded: number;
  /** wait = na fila, up = enviando, proc = enviado, o servidor está lendo as tags, done, error */
  status: 'wait' | 'up' | 'proc' | 'done' | 'error';
  error?: string;
}

/** 'root' = início da biblioteca (pastas + músicas sem pasta); número = pasta aberta. */
type View = 'root' | number;

export default function MediaPage() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const base = `/api/stations/${station.id}`;
  const [items, setItems] = useState<Media[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [view, setView] = useState<View>('root');
  const [uploading, setUploading] = useState(false);
  const [queue, setQueue] = useState<UpItem[]>([]);
  const [speed, setSpeed] = useState(0);
  const cancelled = useRef(false);
  const current = useRef<{ abort: () => void } | null>(null);
  const [over, setOver] = useState<'zone' | number | null>(null);
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
  const currentFolder = typeof view === 'number' ? folders.find((f) => f.id === view) : undefined;
  // Se a pasta aberta foi apagada, volta ao início.
  useEffect(() => {
    if (typeof view === 'number' && folders.length >= 0 && items !== null && !folders.some((f) => f.id === view)) setView('root');
  }, [folders, view, items]);

  const patchItem = (id: number, change: Partial<UpItem>) => setQueue((qq) => qq.map((i) => (i.id === id ? { ...i, ...change } : i)));

  /** Envia um arquivo por vez para a pasta indicada (null = sem pasta), mostrando o andamento. */
  async function upload(files: FileList | File[] | null, folderId: number | null) {
    if (!files || !files.length || uploading) return;
    const list = [...files];
    const items2: UpItem[] = list.map((f, i) => ({ id: Date.now() + i, name: f.name, size: f.size, loaded: 0, status: 'wait' }));
    setQueue(items2);
    setUploading(true);
    setSpeed(0);
    cancelled.current = false;
    const qs = folderId !== null ? `?folderId=${folderId}` : '';
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      const it = items2[i];
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
    const where = folderId !== null ? ` para "${folderName(folderId) ?? 'a pasta'}"` : '';
    if (failed === 0 && ok > 0) toast(`${ok} arquivo(s) enviado(s)${where}`);
    else if (ok > 0) toast(`${ok} enviado(s), ${failed} com erro`, 'error');
    else if (failed > 0) toast('Nenhum arquivo foi enviado', 'error');
    if (failed === 0) setTimeout(() => setQueue((qq) => (qq.every((x) => x.status === 'done') ? [] : qq)), 4000);
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
    if (!(await confirm({ title: 'Excluir pasta?', message: `A pasta "${f.name}" será removida. As ${f.count} música(s) dela NÃO são apagadas: voltam para o início da biblioteca (sem pasta). Playlists que usavam a pasta deixam de incluí-las.`, confirmLabel: 'Excluir pasta', danger: true }))) return;
    await api(`${base}/folders/${f.id}`, { method: 'DELETE' });
    toast('Pasta excluída');
    setView('root');
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

  const drop = (e: DragEvent, folderId: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    upload(e.dataTransfer.files, folderId);
  };
  const dragOver = (e: DragEvent, target: 'zone' | number) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(target);
  };

  const searching = q.trim().length > 0;
  // Início: só as músicas SEM pasta. Dentro de uma pasta: as dela. Busca: em toda a biblioteca.
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((m) => {
      if (t) return `${m.title} ${m.artist} ${m.album}`.toLowerCase().includes(t);
      return typeof view === 'number' ? m.folderId === view : m.folderId === null;
    });
  }, [items, q, view]);
  const filteredFolders = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? folders.filter((f) => f.name.toLowerCase().includes(t)) : folders;
  }, [folders, q]);

  const allShownPicked = shown.length > 0 && shown.every((m) => picked.has(m.id));
  const togglePick = (id: number) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setPicked((p) => { const n = new Set(p); if (allShownPicked) shown.forEach((m) => n.delete(m.id)); else shown.forEach((m) => n.add(m.id)); return n; });
  const uploadTarget = typeof view === 'number' ? view : null;
  const total = items?.length ?? 0;

  const table = (
    <>
      {picked.size > 0 && (
        <div className="bulkbar">
          <strong>{picked.size} selecionada(s)</strong>
          <button className="small" onClick={() => { setMoveTo(typeof view === 'number' ? 'none' : (folders[0] ? String(folders[0].id) : 'none')); setMoveOpen(true); }}><Icon name="folder" size={13} /> Mover para pasta…</button>
          <button className="ghost small" onClick={() => setPicked(new Set())}>Limpar seleção</button>
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th style={{ width: 36 }}><input type="checkbox" checked={allShownPicked} onChange={toggleAll} aria-label="Selecionar todas" /></th>
            <th>Título</th><th>Artista</th>{searching && <th className="hide-sm">Pasta</th>}<th>Duração</th><th />
          </tr>
        </thead>
        <tbody>
          {shown.map((m) => (
            <tr key={m.id} className={picked.has(m.id) ? 'picked' : ''}>
              <td><input type="checkbox" checked={picked.has(m.id)} onChange={() => togglePick(m.id)} aria-label={`Selecionar ${m.title}`} /></td>
              <td><span className="row" style={{ margin: 0, flexWrap: 'nowrap' }}><Cover url={m.coverUrl} size={32} />{m.title}</span></td>
              <td className="muted">{m.artist || '—'}</td>
              {searching && <td className="hide-sm">{folderName(m.folderId) ? <span className="tag"><Icon name="folder" size={12} /> {folderName(m.folderId)}</span> : <span className="muted">sem pasta</span>}</td>}
              <td className="muted">{fmt(m.duration)}</td>
              <td><div className="table-actions"><button className="icon-btn" title="Excluir" onClick={() => removeMedia(m)}><Icon name="trash" /></button></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );

  return (
    <div>
      {/* Cabeçalho: caminho (breadcrumb) + busca + ações */}
      <div className="toolbar" style={{ marginBottom: 14 }}>
        {typeof view === 'number' ? (
          <div className="crumbs">
            <button className="ghost small" onClick={() => { setView('root'); setQ(''); setPicked(new Set()); }}><Icon name="back" size={13} /> Biblioteca</button>
            <span className="muted">/</span>
            <strong>{currentFolder?.name}</strong>
            {currentFolder && (
              <>
                <button className="icon-btn" title="Renomear pasta" onClick={() => { setError(''); setFolderModal({ id: currentFolder.id, name: currentFolder.name }); }}><Icon name="edit" /></button>
                <button className="icon-btn" title="Excluir pasta" onClick={() => removeFolder(currentFolder)}><Icon name="trash" /></button>
              </>
            )}
          </div>
        ) : (
          <h3 style={{ margin: 0 }}>Biblioteca <span className="muted">({total} músicas)</span></h3>
        )}
        <span className="spacer" />
        <div className="search">
          <Icon name="search" />
          <input placeholder={typeof view === 'number' ? 'Buscar em toda a biblioteca' : 'Buscar música ou pasta'} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {typeof view !== 'number' && <button onClick={() => { setError(''); setFolderModal({ name: '' }); }}><Icon name="folder" /> Nova pasta</button>}
      </div>

      <div
        className={`dropzone ${over === 'zone' ? 'over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => dragOver(e, 'zone')}
        onDragLeave={() => setOver(null)}
        onDrop={(e) => drop(e, uploadTarget)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      >
        <Icon name="upload" size={22} />
        <p style={{ margin: '6px 0 2px' }}>
          <strong>{uploading ? 'Enviando… acompanhe abaixo' : currentFolder ? `Arraste músicas para "${currentFolder.name}" ou clique` : 'Arraste músicas aqui ou clique para escolher'}</strong>
        </p>
        <span className="small-text">MP3, OGG, FLAC, WAV, M4A ou AAC (até 300 MB por arquivo){typeof view !== 'number' && folders.length > 0 ? ' · solte sobre uma pasta para enviar direto para ela' : ''}</span>
        <input ref={input} type="file" multiple hidden accept=".mp3,.ogg,.opus,.flac,.wav,.m4a,.aac" onChange={(e) => upload(e.target.files, uploadTarget)} />
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

      {items === null ? (
        <div className="card skeleton" style={{ height: 140 }} />
      ) : typeof view === 'number' ? (
        /* ===== Dentro de uma pasta ===== */
        <div className="card tight">
          <div className="section-title" style={{ padding: '16px 20px 0', margin: 0 }}>
            <h3>{searching ? `Resultados (${shown.length})` : `Músicas da pasta (${shown.length})`}</h3>
          </div>
          {shown.length === 0 ? (
            <Empty icon={searching ? 'search' : 'folder'} title={searching ? 'Nada encontrado' : 'Pasta vazia'} text={searching ? `Nenhuma música combina com "${q}".` : 'Envie músicas para cá ou mova outras para esta pasta.'} />
          ) : table}
        </div>
      ) : (
        /* ===== Início: pastas + músicas sem pasta ===== */
        <>
          {!searching || filteredFolders.length > 0 ? (
            <div className="section" style={{ marginBottom: 18 }}>
              <div className="section-title"><h3>Pastas <span className="muted">({filteredFolders.length})</span></h3></div>
              {filteredFolders.length === 0 ? (
                <div className="card">
                  <Empty icon="folder" title="Nenhuma pasta ainda" text="Crie pastas para separar as músicas (Rock, Vinhetas, Jingles…) e escolha a pasta inteira nas playlists." action={<button onClick={() => { setError(''); setFolderModal({ name: '' }); }}><Icon name="folder" /> Criar pasta</button>} />
                </div>
              ) : (
                <div className="folder-grid">
                  {filteredFolders.map((f) => (
                    <button
                      key={f.id}
                      className={`folder-card ${over === f.id ? 'over' : ''}`}
                      onClick={() => { setView(f.id); setQ(''); setPicked(new Set()); }}
                      onDragOver={(e) => dragOver(e, f.id)}
                      onDragLeave={() => setOver(null)}
                      onDrop={(e) => drop(e, f.id)}
                    >
                      <span className="folder-ico"><Icon name="folder" size={22} /></span>
                      <span className="folder-info">
                        <strong className="ellipsis">{f.name}</strong>
                        <em>{f.count} {f.count === 1 ? 'música' : 'músicas'}</em>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          <div className="card tight">
            <div className="section-title" style={{ padding: '16px 20px 0', margin: 0 }}>
              <h3>{searching ? `Músicas encontradas (${shown.length})` : `Músicas sem pasta (${shown.length})`}</h3>
            </div>
            {shown.length === 0 ? (
              searching ? (
                <Empty icon="search" title="Nenhuma música encontrada" text={`Nada combina com "${q}".`} />
              ) : total === 0 ? (
                <Empty icon="music" title="Biblioteca vazia" text="Envie suas músicas (ou crie pastas e envie para elas) para montar playlists e colocar a rádio no ar." />
              ) : (
                <Empty icon="folder" title="Todas as músicas estão em pastas" text="Aqui aparecem só as músicas que não estão em nenhuma pasta. Abra uma pasta para ver o conteúdo dela." />
              )
            ) : table}
          </div>
        </>
      )}

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
          <span>Para</span>
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="none">Início da biblioteca (sem pasta)</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        {folders.length === 0 && <p className="muted small-text">Você ainda não tem pastas. Feche e crie uma em “Nova pasta”.</p>}
      </Modal>
    </div>
  );
}
