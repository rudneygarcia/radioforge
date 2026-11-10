import LogoMark from './Logo';
import { Link, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Listen from './pages/Listen';
import Stations from './pages/Stations';
import StationLayout from './pages/StationLayout';
import Dashboard from './pages/Dashboard';
import MediaPage from './pages/MediaPage';
import Playlists from './pages/Playlists';
import DjsPage from './pages/DjsPage';
import ReportsPage from './pages/ReportsPage';
import ListenersPage from './pages/ListenersPage';
import Widget from './pages/Widget';
import WidgetsPage from './pages/WidgetsPage';
import AdsPage from './pages/AdsPage';
import RequestsPage from './pages/RequestsPage';
import IntegrationsPage from './pages/IntegrationsPage';
import AccountPage from './pages/AccountPage';
import Settings, { EditStation } from './pages/Settings';
import Users from './pages/Users';
import BackupsPage from './pages/BackupsPage';
import SystemPage from './pages/SystemPage';

function Protected() {
  const { user, loading, logout } = useAuth();
  if (loading) return <p className="center muted">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <LogoMark size={32} />
          RadioForge
        </Link>
        <nav>
          <NavLink end to="/">Estações</NavLink>
          {user.role === 'admin' && <NavLink to="/users">Usuários</NavLink>}
          {user.role === 'admin' && <NavLink to="/backups">Backups</NavLink>}
          {user.role === 'admin' && <NavLink to="/system">Sistema</NavLink>}
          <NavLink to="/account">Chaves de API</NavLink>
        </nav>
        <span className="spacer" />
        <span className="user-chip">
          <span className="avatar">{(user.name || user.email || '?').trim().charAt(0).toUpperCase()}</span>
          <span className="name">{user.name}</span>
        </span>
        <button className="ghost small" onClick={logout}>
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
      <Route path="/forgot" element={<ForgotPassword />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/listen/:slug" element={<Listen />} />
      <Route path="/widget/:slug/:type" element={<Widget />} />
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
          <Route path="listeners" element={<ListenersPage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="widgets" element={<WidgetsPage />} />
          <Route path="ads" element={<AdsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="edit" element={<EditStation />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
