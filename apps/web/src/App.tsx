import { Link, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import Listen from './pages/Listen';
import Stations from './pages/Stations';
import StationLayout from './pages/StationLayout';
import Dashboard from './pages/Dashboard';
import MediaPage from './pages/MediaPage';
import Playlists from './pages/Playlists';
import Settings from './pages/Settings';
import Users from './pages/Users';

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
        <Route path="/stations/:id" element={<StationLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="media" element={<MediaPage />} />
          <Route path="playlists" element={<Playlists />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
