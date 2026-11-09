import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import Listen from './pages/Listen';
import Stations from './pages/Stations';
import StationLayout from './pages/StationLayout';
import Dashboard from './pages/Dashboard';
import MediaPage from './pages/MediaPage';
import Playlists from './pages/Playlists';
import DjsPage from './pages/DjsPage';
import ReportsPage from './pages/ReportsPage';
import IntegrationsPage from './pages/IntegrationsPage';
import AccountPage from './pages/AccountPage';
import Settings from './pages/Settings';
import Users from './pages/Users';
import BackupsPage from './pages/BackupsPage';
import SystemPage from './pages/SystemPage';
import PodcastPage from './pages/PodcastPage';

function Protected() {
  const { user, loading, logout } = useAuth();
  if (loading) return <p className="center muted">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          📻 RadioForge
        </Link>
        <nav>
          <Link to="/">Estações</Link>
          {user.role === 'admin' && <Link to="/users">Usuários</Link>}
          {user.role === 'admin' && <Link to="/backups">Backups</Link>}
          {user.role === 'admin' && <Link to="/system">Sistema</Link>}
          <Link to="/account">Chaves de API</Link>
        </nav>
        <span className="spacer" />
        <span className="muted">{user.name}</span>
        <button className="ghost" onClick={logout}>
          Sair
        </button>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/listen/:slug" element={<Listen />} />
      <Route element={<Protected />}>
        <Route path="/" element={<Stations />} />
        <Route path="/users" element={<Users />} />
        <Route path="/backups" element={<BackupsPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/stations/:id" element={<StationLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="media" element={<MediaPage />} />
          <Route path="playlists" element={<Playlists />} />
          <Route path="djs" element={<DjsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="podcast" element={<PodcastPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
