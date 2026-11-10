import { useCallback, useEffect, useState } from 'react';

import { NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { api, type Station } from '../api';
import { Cover, Icon, PageHeader } from '../ui';

export interface StationCtx {
  station: Station;
  reload: () => Promise<void>;
}

const NAV = [
  { to: '.', label: 'Painel', icon: 'home' },
  { to: 'media', label: 'Biblioteca', icon: 'music' },
  { to: 'playlists', label: 'Playlists', icon: 'list' },
  { to: 'ads', label: 'Comerciais', icon: 'megaphone' },
  { to: 'requests', label: 'Pedidos', icon: 'heart' },
  { to: 'djs', label: 'DJs', icon: 'mic' },
  { to: 'listeners', label: 'Ouvintes', icon: 'users' },
  { to: 'reports', label: 'Relatórios', icon: 'chart' },
  { to: 'widgets', label: 'Widgets', icon: 'code' },
  { to: 'integrations', label: 'Integrações', icon: 'plug' },
  { to: 'edit', label: 'Editar estação', icon: 'edit' },
  { to: 'settings', label: 'Configurações', icon: 'cog' },
];

export default function StationLayout() {
  const { id } = useParams();
  const [station, setStation] = useState<Station | null>(null);
  const [error, setError] = useState('');
  // Em telas pequenas o menu fica escondido e abre ao tocar no botão.
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname]);
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
      <div className={`station-shell${menuOpen ? ' menu-open' : ''}`}>
      <button type="button" className="menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen}>
        <Icon name="menu" size={18} />
        <span>{NAV.find((n) => (n.to === '.' ? pathname.replace(/\/$/, '').split('/').length <= 3 : pathname.split('/')[3] === n.to))?.label ?? 'Menu'}</span>
        <Icon name="chevron" size={16} />
      </button>
      <nav className="tabs">
        <div className="nav-head">
          <Cover url={station.coverUrl} size={42} />
          <div className="nav-head-txt">
            <strong>{station.name}</strong>
            <small>Painel da estação</small>
          </div>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} end={n.to === '.'} to={n.to} title={n.label}>
            <Icon name={n.icon} size={18} />
            <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}

        <a className="nav-foot" href={`/listen/${station.slug}`} target="_blank" rel="noreferrer" title="Abrir o player público">
          <span className="nav-label">Ver player público</span> <Icon name="link" size={14} />
        </a>
      </nav>
      <div className="station-main">
        <Outlet context={{ station, reload } satisfies StationCtx} />
      </div>
      </div>
    </>
  );
}
