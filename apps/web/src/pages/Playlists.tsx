import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Media, type Playlist } from '../api';
import type { StationCtx } from './StationLayout';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export default function Playlists() {
  const { station } = useOutletContext<StationCtx>();
  const [lists, setLists] = useState<Playlist[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [name, setName] = useState('');
  const base = `/api/stations/${station.id}`;

  const load = async () => {
    setLists(await api<Playlist[]>(`${base}/playlists`));
    setMedia(await api<Media[]>(`${base}/media`));
  };
  useEffect(() => {
    load();
  }, [station.id]);

  async function create() {
    if (!name.trim()) return;
    const p = await api<Playlist>(`${base}/playlists`, { method: 'POST', body: { name } });
    setName('');
    await load();
    setOpen(p.id);
  }

  async function save(p: Playlist) {
    await api(`${base}/playlists/${p.id}`, { method: 'PUT', body: p });
    load();
  }

  async function remove(p: Playlist) {
    if (!confirm(`Excluir a playlist "${p.name}"?`)) return;
    await api(`${base}/playlists/${p.id}`, { method: 'DELETE' });
    load();
  }

  const patch = (id: number, change: Partial<Playlist>) =>
    setLists((ls) => ls.map((l) => (l.id === id ? { ...l, ...change } : l)));

  return (
    <>
      <div className="row">
        <input placeholder="Nome da nova playlist" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={create}>Criar playlist</button>
      </div>
      {lists.map((p) => (
        <div className="card" key={p.id}>
          <div className="row between">
            <strong>{p.name} <span className="muted">({p.mediaIds.length} faixas)</span></strong>
            <div className="row">
              <button className="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Fechar' : 'Editar'}</button>
              <button className="danger" onClick={() => remove(p)}>Excluir</button>
            </div>
          </div>
          {open === p.id && (
            <>
              <div className="row" style={{ margin: '12px 0' }}>
                <label><input type="checkbox" checked={p.enabled} onChange={(e) => patch(p.id, { enabled: e.target.checked })} /> Ativa</label>
                <select value={p.mode} onChange={(e) => patch(p.id, { mode: e.target.value as Playlist['mode'] })}>
                  <option value="shuffle">Aleatória</option>
                  <option value="sequential">Sequencial</option>
                </select>
                <label>Peso <input type="number" min={1} max={100} value={p.weight} onChange={(e) => patch(p.id, { weight: Number(e.target.value) || 1 })} style={{ width: 70 }} /></label>
              </div>
              <div className="row">
                <label>
                  <input type="checkbox" checked={p.scheduleEnabled} onChange={(e) => patch(p.id, { scheduleEnabled: e.target.checked })} /> Agendar (toca só neste horário e tem prioridade sobre a rotação)
                </label>
              </div>
              {p.scheduleEnabled && (
                <div className="row">
                  <label>Das <input type="time" value={p.startTime} onChange={(e) => patch(p.id, { startTime: e.target.value })} /></label>
                  <label>às <input type="time" value={p.endTime} onChange={(e) => patch(p.id, { endTime: e.target.value })} /></label>
                  {DAYS.map((d, i) => (
                    <label key={i}>
                      <input
                        type="checkbox"
                        checked={p.days.includes(i)}
                        onChange={(e) => patch(p.id, { days: e.target.checked ? [...p.days, i] : p.days.filter((x) => x !== i) })}
                      />{' '}
                      {d}
                    </label>
                  ))}
                </div>
              )}
              <div className="picker">
                {media.map((m) => (
                  <label key={m.id}>
                    <input
                      type="checkbox"
                      checked={p.mediaIds.includes(m.id)}
                      onChange={(e) =>
                        patch(p.id, { mediaIds: e.target.checked ? [...p.mediaIds, m.id] : p.mediaIds.filter((x) => x !== m.id) })
                      }
                    />{' '}
                    {m.artist ? `${m.artist} — ` : ''}{m.title}
                  </label>
                ))}
                {media.length === 0 && <p className="muted">Envie músicas na Biblioteca primeiro.</p>}
              </div>
              <button onClick={() => save(p)}>Salvar</button>
            </>
          )}
        </div>
      ))}
    </>
  );
}
