import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, uploadForm, type Recording } from '../api';
import { CopyButton, Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

interface Episode {
  id: number;
  title: string;
  description: string;
  originalName: string;
  duration: number;
  size: number;
  published: boolean;
  createdAt: string;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const mins = (s: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '—');

export default function PodcastPage() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const base = `/api/stations/${station.id}`;
  const feed = `${location.origin}/api/public/stations/${station.slug}/podcast.xml`;
  const [eps, setEps] = useState<Episode[] | null>(null);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Episode | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rec, setRec] = useState('');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null); // andamento do envio do arquivo (0-100)
  const [error, setError] = useState('');

  const load = async () => {
    setEps(await api<Episode[]>(`${base}/podcast/episodes`));
    setRecs(await api<Recording[]>(`${base}/recordings`).catch(() => []));
  };
  useEffect(() => {
    load();
  }, [station.id]);

  const reset = () => {
    setTitle('');
    setDescription('');
    setFile(null);
    setRec('');
    setError('');
  };

  async function upload(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (file) {
        const form = new FormData();
        form.append('title', title);
        form.append('description', description);
        form.append('file', file);
        setPct(0);
        await uploadForm(`${base}/podcast/episodes`, form, (loaded, total) => setPct(Math.round((loaded / total) * 100))).promise;
      } else if (rec) {
        await api(`${base}/podcast/from-recording`, { method: 'POST', body: { file: rec, title, description } });
      } else {
        throw new Error('Escolha um arquivo de áudio ou uma gravação.');
      }
      setCreating(false);
      reset();
      toast('Episódio publicado');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setPct(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    try {
      await api(`${base}/podcast/episodes/${editing.id}`, { method: 'PUT', body: { title: editing.title, description: editing.description, published: editing.published } });
      setEditing(null);
      toast('Episódio salvo');
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function remove(ep: Episode) {
    if (!(await confirm({ title: 'Excluir episódio?', message: `"${ep.title}" e o arquivo de áudio serão apagados.`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/podcast/episodes/${ep.id}`, { method: 'DELETE' });
    toast('Episódio excluído');
    setEditing(null);
    load();
  }

  return (
    <>
      <div className="card">
        <h3>Feed do podcast</h3>
        <p className="muted">Cole este endereço no Spotify, Apple Podcasts, Pocket Casts ou em qualquer app de podcast. Só os episódios publicados aparecem.</p>
        <div className="copy-row"><code>{feed}</code><CopyButton text={feed} /></div>
      </div>

      <div className="section-title" style={{ marginTop: 24 }}>
        <h3>Episódios <span className="muted">({eps?.length ?? 0})</span></h3>
        <button onClick={() => { reset(); setCreating(true); }}><Icon name="plus" /> Novo episódio</button>
      </div>

      {eps && eps.length === 0 && (
        <div className="card">
          <Empty icon="mic" title="Nenhum episódio ainda" text="Envie um áudio ou publique uma gravação de transmissão ao vivo." action={<button onClick={() => { reset(); setCreating(true); }}><Icon name="plus" /> Publicar episódio</button>} />
        </div>
      )}
      {eps?.map((ep) => (
        <div className="card item-card" key={ep.id}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="item-title">{ep.title} {!ep.published && <span className="badge off">rascunho</span>}</div>
            {ep.description && <p className="muted ellipsis" style={{ maxWidth: 560 }}>{ep.description}</p>}
            <div className="meta">
              <span className="tag"><Icon name="clock" size={12} /> {mins(ep.duration)}</span>
              <span className="tag">{mb(ep.size)}</span>
              <span className="tag">{new Date(ep.createdAt + 'Z').toLocaleDateString()}</span>
            </div>
          </div>
          <div className="row" style={{ margin: 0 }}>
            <button className="ghost" onClick={() => setEditing(ep)}><Icon name="edit" /> Editar</button>
            <button className="icon-btn" title="Excluir" onClick={() => remove(ep)}><Icon name="trash" /></button>
          </div>
        </div>
      ))}

      <Modal
        open={creating}
        title="Novo episódio"
        onClose={() => setCreating(false)}
        footer={<><button className="ghost" type="button" onClick={() => setCreating(false)}>Cancelar</button><button form="new-ep" disabled={busy}>{busy ? 'Enviando…' : 'Publicar'}</button></>}
      >
        <form id="new-ep" className="fields" onSubmit={upload}>
          <label className="field"><span>Título <em className="hint">(opcional: usa o das tags ou o nome do arquivo)</em></span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field"><span>Descrição</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></label>
          <label className="field">
            <span>Arquivo de áudio</span>
            <input type="file" accept=".mp3,.m4a,.aac,.ogg,.opus,.wav,audio/*" onChange={(e) => { setFile(e.target.files?.[0] ?? null); if (e.target.files?.[0]) setRec(''); }} />
          </label>
          {recs.length > 0 && (
            <label className="field">
              <span>…ou uma gravação de transmissão ao vivo</span>
              <select value={rec} onChange={(e) => { setRec(e.target.value); if (e.target.value) setFile(null); }}>
                <option value="">— escolha —</option>
                {recs.map((r) => <option key={r.name} value={r.name}>{r.name} ({mb(r.size)})</option>)}
              </select>
            </label>
          )}
          {pct !== null && (
            <div>
              <div className={`progress ${pct >= 100 ? 'indeterminate' : ''}`}><i style={{ width: `${pct}%` }} /></div>
              <p className="muted small-text" style={{ margin: '6px 0 0' }}>{pct >= 100 ? 'Arquivo enviado; o servidor está processando…' : `Enviando… ${pct}%`}</p>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>

      <Modal
        open={!!editing}
        title="Editar episódio"
        onClose={() => setEditing(null)}
        footer={
          editing && (
            <>
              <button type="button" className="danger" style={{ marginRight: 'auto' }} onClick={() => remove(editing)}><Icon name="trash" /> Excluir</button>
              <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancelar</button>
              <button form="edit-ep">Salvar</button>
            </>
          )
        }
      >
        {editing && (
          <form id="edit-ep" className="fields" onSubmit={save}>
            <label className="field"><span>Título</span><input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} required /></label>
            <label className="field"><span>Descrição</span><textarea rows={4} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></label>
            <label className="check-line"><input type="checkbox" checked={editing.published} onChange={(e) => setEditing({ ...editing, published: e.target.checked })} /> <span>Publicado no feed <small>Desmarque para deixar como rascunho.</small></span></label>
          </form>
        )}
      </Modal>
    </>
  );
}
