import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Media } from '../api';
import type { StationCtx } from './StationLayout';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function MediaPage() {
  const { station } = useOutletContext<StationCtx>();
  const [items, setItems] = useState<Media[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = () => api<Media[]>(`/api/stations/${station.id}/media`).then(setItems);
  useEffect(() => {
    load();
  }, [station.id]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      for (const f of files) form.append('file', f);
      await api(`/api/stations/${station.id}/media`, { method: 'POST', form });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(m: Media) {
    if (!confirm(`Excluir "${m.title}"?`)) return;
    await api(`/api/stations/${station.id}/media/${m.id}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="card">
      <div className="row between">
        <h3>Biblioteca ({items.length})</h3>
        <label className="button">
          {uploading ? 'Enviando…' : 'Enviar músicas'}
          <input ref={input} type="file" multiple hidden accept=".mp3,.ogg,.opus,.flac,.wav,.m4a,.aac" onChange={(e) => upload(e.target.files)} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead><tr><th>Título</th><th>Artista</th><th>Álbum</th><th>Duração</th><th /></tr></thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id}>
              <td>{m.title}</td><td>{m.artist}</td><td>{m.album}</td><td>{fmt(m.duration)}</td>
              <td><button className="danger small" onClick={() => remove(m)}>Excluir</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <p className="muted">Envie arquivos MP3, OGG, FLAC, WAV, M4A ou AAC.</p>}
    </div>
  );
}
