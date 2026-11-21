import { Fragment, useCallback, useEffect, useState } from 'react';

import { NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { api, type Station } from '../api';
import { useCan } from '../auth';
import { Cover, Icon, useUi } from '../ui';

export interface StationCtx {
  station: Station;
  reload: () => Promise<void>;
}

const NAV: { to: string; label: string; icon: string; perm?: string[]; autodj?: boolean; sec?: string }[] = [
  { to: '.', label: 'Painel', icon: 'home', sec: 'Visão geral' },
  { to: 'media', label: 'Biblioteca', icon: 'music', autodj: true, sec: 'Programação' },
  { to: 'playlists', label: 'Playlists', icon: 'list', autodj: true },
  { to: 'ads', label: 'Comerciais', icon: 'megaphone', perm: ['ads'], autodj: true },
  { to: 'hora-certa', label: 'Hora certa', icon: 'clock', perm: ['edit_station', 'advanced'], autodj: true },
  { to: 'requests', label: 'Pedidos', icon: 'heart', autodj: true },
  { to: 'djs', label: 'DJs', icon: 'mic', perm: ['djs'], sec: 'Ao vivo e público' },
  { to: 'listeners', label: 'Ouvintes', icon: 'users' },
  { to: 'widgets', label: 'Widgets', icon: 'code' },
  { to: 'integrations', label: 'Integrações', icon: 'plug' },
  { to: 'reports', label: 'Relatórios', icon: 'chart', perm: ['reports'], sec: 'Análises' },
  { to: 'edit', label: 'Editar estação', icon: 'edit', perm: ['edit_station'], sec: 'Configuração' },
  { to: 'autodj', label: 'AutoDJ/Pedidos', icon: 'play', perm: ['edit_station'] },
  { to: 'stereo-tool', label: 'Stereo Tool', icon: 'volume', perm: ['stereo'], autodj: true },
  { to: 'ocultar', label: 'Ocultar nomes', icon: 'mute', perm: ['edit_station'], autodj: true },
  { to: 'settings', label: 'Configurações', icon: 'cog', perm: ['edit_station', 'advanced'] },
];

export default function StationLayout() {
  const can = useCan();
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
    const t = setInterval(() => { if (!document.hidden) reload(); }, 10000);
    return () => clearInterval(t);
  }, [reload]);

  // Mudança salva que só vale depois de reiniciar (ex.: playlist nova ou agendada): o aviso no topo oferece reiniciar quando você quiser.
  const { toast } = useUi();
  const [applying, setApplying] = useState(false);
  const applyRestart = async () => {
    setApplying(true);
    try {
      await api(`/api/stations/${id}/restart`, { method: 'POST' });
      await reload();
      toast('Rádio reiniciada: as mudanças já valem');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setApplying(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!station) return <div className="card skeleton" style={{ height: 120 }} />;

  return (
    <>
      <header className={`hero ${station.running ? 'live' : ''}`}>
        <div className="hero-bg" style={station.coverUrl ? { backgroundImage: `linear-gradient(90deg, rgba(15,23,42,.8), rgba(15,23,42,.45)), url(${station.coverUrl})` } : undefined} />
        <div className="hero-in">
          <div className="hero-logo"><Cover url={station.nowPlaying?.coverUrl ?? station.coverUrl} size={72} /></div>
          <div className="hero-txt">
            <h1 className="ellipsis">{station.name}</h1>
            <div className="hero-tags">
              <span className={`badge ${station.running ? 'on' : 'off'}`}>{station.running ? 'no ar' : 'parada'}</span>
              {station.live && <span className="tag accent"><Icon name="mic" size={12} /> ao vivo</span>}
              <span className="hero-chip"><Icon name="users" size={13} /> {station.listeners} {station.listeners === 1 ? 'ouvinte' : 'ouvintes'}</span>
              {station.streams[0] && <span className="hero-chip">{station.streams[0].format.toUpperCase()} {station.streams[0].bitrate}k</span>}
            </div>
            <p className="hero-np ellipsis">
              <Icon name={station.live ? 'mic' : 'music'} size={14} />{' '}
              {station.live ? `${station.live.name} ao vivo` : station.nowPlaying ? `${station.nowPlaying.artist ? `${station.nowPlaying.artist} — ` : ''}${station.nowPlaying.title}` : station.description || 'Sem histórico ainda'}
            </p>
          </div>
          <a className="button hero-btn" href={`/listen/${station.slug}`} target="_blank" rel="noreferrer">
            <Icon name="link" /> Player público
          </a>
        </div>
      </header>
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
        {(() => {
          let cur = '';
          let shown = '';
          return NAV.map((n) => {
            if (n.sec) cur = n.sec;
            if ((n.perm && !n.perm.some((p) => can(p))) || (n.autodj && !station.autodj)) return null;
            const label = cur !== shown ? cur : '';
            shown = cur;
            return (
              <Fragment key={n.to}>
                {label && <div className="nav-sec"><span>{label}</span></div>}
                <NavLink end={n.to === '.'} to={n.to} title={n.label}>
                  <Icon name={n.icon} size={18} />
                  <span className="nav-label">{n.label}</span>
                </NavLink>
              </Fragment>
            );
          });
        })()}

        <a className="nav-foot" href={`/listen/${station.slug}`} target="_blank" rel="noreferrer" title="Abrir o player público">
          <span className="nav-label">Ver player público</span> <Icon name="link" size={14} />
        </a>
      </nav>
      <div className="station-main">
        {station.pendingRestart && station.running && can('control') && (
          <div className="card notice" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span><strong>Mudança aguardando:</strong> você salvou algo (ex.: playlist nova, horário ou "a cada N músicas") que a rádio no ar ainda não conhece. Só vale depois de reiniciar, e o áudio dá uma pausa curta.</span>
            <button type="button" disabled={applying} onClick={applyRestart}>{applying ? 'Reiniciando…' : 'Reiniciar agora'}</button>
          </div>
        )}
        <Outlet context={{ station, reload } satisfies StationCtx} />
      </div>
      </div>
    </>
  );
}
