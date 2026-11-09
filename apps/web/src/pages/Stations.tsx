import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Station } from '../api';
import { useAuth } from '../auth';

export default function Stations() {
  const { user } = useAuth();
  const [stations, setStations] = useState<Station[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const load = () => api<Station[]>('/api/stations').then(setStations);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/stations', { method: 'POST', body: { name } });
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Estações</h1>
        {user?.role === 'admin' && (
          <form className="row" onSubmit={create} style={{ margin: 0 }}>
            <input placeholder="Nome da nova estação" value={name} onChange={(e) => setName(e.target.value)} required />
            <button>+ Criar estação</button>
          </form>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="grid" style={{ marginTop: 16 }}>
        {stations.map((s) => (
          <Link key={s.id} to={`/stations/${s.id}`} className={`card station ${s.running ? 'live' : ''}`}>
            <div className="row between" style={{ marginBottom: 4 }}>
              <span className="station-name">{s.name}</span>
              <span className={`badge ${s.running ? 'on' : 'off'}`}>{s.running ? 'no ar' : 'parada'}</span>
            </div>
            <p className="muted">{s.live ? `🎙 ${s.live.name} ao vivo` : s.nowPlaying ? `♪ ${s.nowPlaying.artist ? `${s.nowPlaying.artist} — ` : ''}${s.nowPlaying.title}` : 'Sem histórico ainda'}</p>
            <div className="station-meta">
              <span>👥 {s.listeners} {s.listeners === 1 ? 'ouvinte' : 'ouvintes'}</span>
              <span>{s.streams[0]?.format.toUpperCase()} {s.streams[0]?.bitrate}k</span>
            </div>
          </Link>
        ))}
        {stations.length === 0 && <div className="empty">Nenhuma estação ainda.{user?.role === 'admin' ? ' Crie a primeira acima.' : ''}</div>}
      </div>
    </>
  );
}
