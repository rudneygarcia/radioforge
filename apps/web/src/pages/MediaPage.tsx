import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Media } from '../api';
import { Empty, Icon, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function MediaPage() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const [items, setItems] = useState<Media[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = () => api<Media[]>(`/api/stations/${station.id}/media`).then(setItems);
  useEffect(() => {
    load();
  }, [station.id]);

  async function upload(files: FileList | File[] | null) {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of files) form.append('file', f);
      await api(`/api/stations/${station.id}/media`, { method: 'POST', form });
      await load();
      toast(`${files.length} arquivo(s) enviado(s)`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(m: Media) {
    if (!(await confirm({ title: 'Excluir música?', message: `"${m.title}" será removida da biblioteca e de todas as playlists.`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`/api/stations/${station.id}/media/${m.id}`, { method: 'DELETE' });
    toast('Música excluída');
    load();
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    upload(e.dataTransfer.files);
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items ?? []).filter((m) => !t || `${m.title} ${m.artist} ${m.album}`.toLowerCase().includes(t));
  }, [items, q]);

  return (
    <>
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
        <p style={{ margin: '6px 0 2px' }}><strong>{uploading ? 'Enviando…' : 'Arraste músicas aqui ou clique para escolher'}</strong></p>
        <span className="small-text">MP3, OGG, FLAC, WAV, M4A ou AAC (até 300 MB por arquivo)</span>
        <input ref={input} type="file" multiple hidden accept=".mp3,.ogg,.opus,.flac,.wav,.m4a,.aac" onChange={(e) => upload(e.target.files)} />
      </div>

      <div className="card tight">
        <div className="toolbar" style={{ padding: '16px 20px 0' }}>
          <h3 style={{ margin: 0 }}>Biblioteca <span className="muted">({items?.length ?? 0})</span></h3>
          <span className="spacer" />
          <div className="search">
            <Icon name="search" />
            <input placeholder="Buscar por título, artista ou álbum" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {items === null ? (
          <div className="skeleton" style={{ height: 120, margin: 20, borderRadius: 12 }} />
        ) : items.length === 0 ? (
          <Empty icon="music" title="Biblioteca vazia" text="Envie suas músicas para montar playlists e colocar a rádio no ar." />
        ) : shown.length === 0 ? (
          <Empty icon="search" title="Nada encontrado" text={`Nenhuma música combina com "${q}".`} />
        ) : (
          <table>
            <thead><tr><th>Título</th><th>Artista</th><th className="hide-sm">Álbum</th><th>Duração</th><th /></tr></thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td className="muted">{m.artist || '—'}</td>
                  <td className="muted hide-sm">{m.album || '—'}</td>
                  <td className="muted">{fmt(m.duration)}</td>
                  <td><div className="table-actions"><button className="icon-btn" title="Excluir" onClick={() => remove(m)}><Icon name="trash" /></button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
