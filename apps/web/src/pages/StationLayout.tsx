import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { api, type Station } from '../api';
import { Icon, PageHeader } from '../ui';

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
  if (!station) return <div className="card skeleton" style={{ height: 120 }} />;

  return (
    <>
      <PageHeader
        title={
          <>
            {station.name}{' '}
            <span className={`badge ${station.running ? 'on' : 'off'}`} style={{ verticalAlign: 'middle', marginLeft: 6 }}>
              {station.running ? 'no ar' : 'parada'}
            </span>
          </>
        }
        subtitle={station.description || undefined}
        actions={
          <a className="button ghost" href={`/listen/${station.slug}`} target="_blank" rel="noreferrer">
            <Icon name="link" /> Player público
          </a>
        }
      />
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
