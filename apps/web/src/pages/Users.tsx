import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, type Station } from '../api';
import { useAuth } from '../auth';

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'user';
  stationIds: number[];
}

export default function Users() {
  const { user } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'user', stationIds: [] as number[] });
  const [error, setError] = useState('');

  const load = async () => {
    setUsers(await api<UserRow[]>('/api/users'));
    setStations(await api<Station[]>('/api/stations'));
  };
  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user]);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/api/users', { method: 'POST', body: f });
      setF({ name: '', email: '', password: '', role: 'user', stationIds: [] });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(u: UserRow) {
    if (!confirm(`Excluir ${u.email}?`)) return;
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <h1>Usuários</h1>
      <form className="card form" onSubmit={create}>
        <div className="row">
          <input placeholder="Nome" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <input type="email" placeholder="E-mail" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <input type="password" placeholder="Senha" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} />
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="user">Operador</option><option value="admin">Administrador</option>
          </select>
        </div>
        {f.role === 'user' && (
          <div className="row">
            {stations.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={f.stationIds.includes(s.id)} onChange={(e) =>
                  setF({ ...f, stationIds: e.target.checked ? [...f.stationIds, s.id] : f.stationIds.filter((x) => x !== s.id) })} /> {s.name}
              </label>
            ))}
          </div>
        )}
        <button>Criar usuário</button>
        {error && <p className="error">{error}</p>}
      </form>
      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Estações</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td><td>{u.email}</td><td>{u.role === 'admin' ? 'Administrador' : 'Operador'}</td>
                <td>{u.role === 'admin' ? 'todas' : u.stationIds.length}</td>
                <td>{u.id !== user.id && <button className="danger small" onClick={() => remove(u)}>Excluir</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
