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
      <h1>Estações</h1>
      {user?.role === 'admin' && (
        <form className="row" onSubmit={create}>
          <input placeholder="Nome da nova estação" value={name} onChange={(e) => setName(e.target.value)} required />
          <button>Criar estação</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      <div className="grid">
        {stations.map((s) => (
          <Link key={s.id} to={`/stations/${s.id}`} className="card station">
            <div className="row between">
              <strong>{s.name}</strong>
              <span className={`badge ${s.running ? 'on' : 'off'}`}>{s.running ? 'no ar' : 'parada'}</span>
            </div>
            <p className="muted">{s.nowPlaying ? `${s.nowPlaying.artist} — ${s.nowPlaying.title}` : 'Sem histórico'}</p>
            <p className="muted">👥 {s.listeners} ouvintes</p>
          </Link>
        ))}
        {stations.length === 0 && <p className="muted">Nenhuma estação ainda.</p>}
      </div>
    </>
  );
}
