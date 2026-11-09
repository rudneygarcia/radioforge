import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { api, type Station } from '../api';

export interface StationCtx {
  station: Station;
  reload: () => Promise<void>;
}

export default function StationLayout() {
  const { id } = useParams();
  const [station, setStation] = useState<Station | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setStation(await api<Station>(`/api/stations/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <p className="error">{error}</p>;
  if (!station) return <p className="muted">Carregando…</p>;

  return (
    <>
      <div className="row between">
        <h1>{station.name}</h1>
        <a href={`/listen/${station.slug}`} target="_blank" rel="noreferrer">
          Player público ↗
        </a>
      </div>
      <nav className="tabs">
        <NavLink end to=".">Painel</NavLink>
        <NavLink to="media">Biblioteca</NavLink>
        <NavLink to="playlists">Playlists</NavLink>
        <NavLink to="djs">DJs</NavLink>
        <NavLink to="reports">Relatórios</NavLink>
        <NavLink to="podcast">Podcast</NavLink>
        <NavLink to="integrations">Integrações</NavLink>
        <NavLink to="settings">Configurações</NavLink>
      </nav>
      <Outlet context={{ station, reload } satisfies StationCtx} />
    </>
  );
}
