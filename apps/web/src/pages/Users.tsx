import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { api, type Station } from '../api';
import { useAuth } from '../auth';
import { Empty, Icon, Modal, PageHeader, useUi } from '../ui';

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'user';
  stationIds: number[];
}
const blank = { name: '', email: '', password: '', role: 'user', stationIds: [] as number[] };

export default function Users() {
  const { user } = useAuth();
  const { confirm, toast } = useUi();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(blank);
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
      setF(blank);
      setOpen(false);
      toast('Usuário criado');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(u: UserRow) {
    if (!(await confirm({ title: 'Excluir usuário?', message: `${u.email} perde o acesso ao painel.`, confirmLabel: 'Excluir', danger: true }))) return;
    try {
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      toast('Usuário excluído');
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <>
      <PageHeader
        title="Usuários"
        subtitle="Quem pode acessar o painel e quais estações cada operador gerencia."
        actions={<button onClick={() => setOpen(true)}><Icon name="plus" /> Novo usuário</button>}
      />
      <div className="card tight">
        {users === null ? (
          <div className="skeleton" style={{ height: 100, margin: 20, borderRadius: 12 }} />
        ) : users.length === 0 ? (
          <Empty icon="users" title="Nenhum usuário" />
        ) : (
          <table>
            <thead><tr><th>Usuário</th><th>Perfil</th><th className="hide-sm">Estações</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="avatar-sm">{(u.name || u.email).charAt(0).toUpperCase()}</span>
                    <strong>{u.name}</strong> <span className="muted">{u.email}</span>
                  </td>
                  <td><span className={`tag ${u.role === 'admin' ? 'accent' : ''}`}>{u.role === 'admin' ? 'Administrador' : 'Operador'}</span></td>
                  <td className="muted hide-sm">{u.role === 'admin' ? 'Todas' : u.stationIds.length}</td>
                  <td><div className="table-actions">{u.id !== user.id && <button className="icon-btn" title="Excluir" onClick={() => remove(u)}><Icon name="trash" /></button>}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={open}
        title="Novo usuário"
        onClose={() => setOpen(false)}
        footer={<><button className="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button><button form="new-user">Criar usuário</button></>}
      >
        <form id="new-user" className="fields" onSubmit={create}>
          <div className="field-row">
            <label className="field"><span>Nome</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label className="field"><span>Perfil</span>
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="user">Operador</option><option value="admin">Administrador</option>
              </select>
            </label>
          </div>
          <label className="field"><span>E-mail</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
          <label className="field"><span>Senha</span><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={8} /><small className="hint">Mínimo de 8 caracteres.</small></label>
          {f.role === 'user' && (
            <div className="field">
              <span className="label">Estações que pode gerenciar</span>
              <div className="chips">
                {stations.map((s) => (
                  <label key={s.id} className="chip">
                    <input type="checkbox" checked={f.stationIds.includes(s.id)} onChange={(e) => setF({ ...f, stationIds: e.target.checked ? [...f.stationIds, s.id] : f.stationIds.filter((x) => x !== s.id) })} />
                    {s.name}
                  </label>
                ))}
                {stations.length === 0 && <span className="muted small-text">Nenhuma estação criada ainda.</span>}
              </div>
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>
    </>
  );
}
