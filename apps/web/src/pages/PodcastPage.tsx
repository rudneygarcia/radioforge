import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Recording } from '../api';
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
  const base = `/api/stations/${station.id}`;
  const feed = `${location.origin}/api/public/stations/${station.slug}/podcast.xml`;
  const [eps, setEps] = useState<Episode[]>([]);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rec, setRec] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setEps(await api<Episode[]>(`${base}/podcast/episodes`));
    setRecs(await api<Recording[]>(`${base}/recordings`).catch(() => []));
  };
  useEffect(() => {
    load();
  }, [station.id]);

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('title', title);
      form.append('description', description);
      form.append('file', file);
      await api(`${base}/podcast/episodes`, { method: 'POST', form });
      setTitle('');
      setDescription('');
      setFile(null);
      (e.target as HTMLFormElement).reset();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fromRecording() {
    if (!rec) return;
    setBusy(true);
    setError('');
    try {
      await api(`${base}/podcast/from-recording`, { method: 'POST', body: { file: rec, title } });
      setRec('');
      setTitle('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(ep: Episode) {
    setError('');
    try {
      await api(`${base}/podcast/episodes/${ep.id}`, { method: 'PUT', body: { title: ep.title, description: ep.description, published: ep.published } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(ep: Episode) {
    if (!confirm(`Excluir o episódio "${ep.title}"? O arquivo também é apagado.`)) return;
    await api(`${base}/podcast/episodes/${ep.id}`, { method: 'DELETE' });
    load();
  }

  const patch = (id: number, change: Partial<Episode>) => setEps((l) => l.map((x) => (x.id === id ? { ...x, ...change } : x)));

  return (
    <>
      <div className="card">
        <h3>Feed do podcast</h3>
        <p className="muted">Cole este endereço no Spotify, Apple Podcasts, Pocket Casts ou em qualquer app de podcast. Só os episódios publicados aparecem.</p>
        <p><code>{feed}</code></p>
        <button className="ghost small" onClick={() => navigator.clipboard.writeText(feed)}>Copiar</button>
      </div>

      <form className="card" onSubmit={upload}>
        <h3>Novo episódio</h3>
        <div className="row">
          <input placeholder="Título (opcional: usa o das tags ou o nome do arquivo)" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 280 }} />
          <input type="file" accept=".mp3,.m4a,.aac,.ogg,.opus,.wav,audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </div>
        <textarea placeholder="Descrição" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ width: '100%', marginTop: 8 }} />
        <button disabled={busy || !file}>{busy ? 'Enviando…' : 'Publicar episódio'}</button>
        {recs.length > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="muted">ou a partir de uma gravação ao vivo:</span>
            <select value={rec} onChange={(e) => setRec(e.target.value)}>
              <option value="">— escolha —</option>
              {recs.map((r) => (
                <option key={r.name} value={r.name}>{r.name} ({mb(r.size)})</option>
              ))}
            </select>
            <button type="button" className="ghost" disabled={busy || !rec} onClick={fromRecording}>Publicar gravação</button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </form>

      {eps.map((ep) => (
        <div className="card" key={ep.id}>
          <div className="row between">
            <strong>{ep.title} {!ep.published && <span className="badge off">rascunho</span>}</strong>
            <span className="muted">{mins(ep.duration)} · {mb(ep.size)} · {new Date(ep.createdAt + 'Z').toLocaleDateString()}</span>
          </div>
          <input value={ep.title} onChange={(e) => patch(ep.id, { title: e.target.value })} style={{ width: '100%', marginTop: 8 }} />
          <textarea value={ep.description} onChange={(e) => patch(ep.id, { description: e.target.value })} rows={2} style={{ width: '100%', marginTop: 8 }} />
          <div className="row">
            <label><input type="checkbox" checked={ep.published} onChange={(e) => patch(ep.id, { published: e.target.checked })} /> Publicado no feed</label>
            <button className="small" onClick={() => save(ep)}>Salvar</button>
            <button className="danger small" onClick={() => remove(ep)}>Excluir</button>
          </div>
        </div>
      ))}
      {eps.length === 0 && <p className="muted">Nenhum episódio ainda.</p>}
    </>
  );
}
