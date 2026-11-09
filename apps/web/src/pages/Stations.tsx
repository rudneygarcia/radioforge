import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Station } from '../api';
import { useAuth } from '../auth';
import { Empty, Icon, Modal, PageHeader, useUi } from '../ui';

export default function Stations() {
  const { user } = useAuth();
  const { toast } = useUi();
  const [stations, setStations] = useState<Station[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api<Station[]>('/api/stations').then(setStations);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/stations', { method: 'POST', body: { name, description } });
      setOpen(false);
      setName('');
      setDescription('');
      toast('Estação criada');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = user?.role === 'admin';
  const newButton = (
    <button onClick={() => setOpen(true)}>
      <Icon name="plus" /> Nova estação
    </button>
  );

  return (
    <>
      <PageHeader title="Estações" subtitle="Suas rádios no ar e o que está tocando agora." actions={isAdmin ? newButton : undefined} />

      {stations === null && (
        <div className="grid">
          {[0, 1, 2].map((i) => <div key={i} className="card skeleton" style={{ height: 116 }} />)}
        </div>
      )}

      {stations && stations.length === 0 && (
        <div className="card">
          <Empty
            icon="radio"
            title="Nenhuma estação ainda"
            text={isAdmin ? 'Crie sua primeira rádio para enviar músicas, montar playlists e ir ao ar.' : 'Peça a um administrador para dar acesso a uma estação.'}
            action={isAdmin ? newButton : undefined}
          />
        </div>
      )}

      {stations && stations.length > 0 && (
        <div className="grid">
          {stations.map((s) => (
            <Link key={s.id} to={`/stations/${s.id}`} className={`card station ${s.running ? 'live' : ''}`}>
              <div className="row between" style={{ marginBottom: 4 }}>
                <span className="station-name">{s.name}</span>
                <span className={`badge ${s.running ? 'on' : 'off'}`}>{s.running ? 'no ar' : 'parada'}</span>
              </div>
              <p className="muted ellipsis">
                {s.live ? `🎙 ${s.live.name} ao vivo` : s.nowPlaying ? `♪ ${s.nowPlaying.artist ? `${s.nowPlaying.artist} — ` : ''}${s.nowPlaying.title}` : 'Sem histórico ainda'}
              </p>
              <div className="station-meta">
                <span><Icon name="users" size={14} /> {s.listeners} {s.listeners === 1 ? 'ouvinte' : 'ouvintes'}</span>
                <span>{s.streams[0]?.format.toUpperCase()} {s.streams[0]?.bitrate}k</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={open}
        title="Nova estação"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button>
            <button form="new-station" disabled={busy}>{busy ? 'Criando…' : 'Criar estação'}</button>
          </>
        }
      >
        <form id="new-station" className="fields" onSubmit={create}>
          <label className="field">
            <span>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Rádio Garcia" required />
          </label>
          <label className="field">
            <span>Descrição <em className="hint">(opcional)</em></span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Uma frase sobre a programação" />
          </label>
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>
    </>
  );
}
