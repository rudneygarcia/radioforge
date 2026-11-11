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
  permissions: string[];
}
interface Perm {
  key: string;
  label: string;
  hint: string;
  padrao: boolean;
}
interface Form {
  id: number | null;
  name: string;
  email: string;
  password: string;
  role: string;
  stationIds: number[];
  permissions: string[];
}
const blank: Form = { id: null, name: '', email: '', password: '', role: 'user', stationIds: [], permissions: [] };

export default function Users() {
  const { user } = useAuth();
  const { confirm, toast } = useUi();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [stations, setStations] = useState<Station[]>([]);
  const [perms, setPerms] = useState<Perm[]>([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Form>(blank);
  const [error, setError] = useState('');

  const load = async () => {
    setUsers(await api<UserRow[]>('/api/users'));
    setStations(await api<Station[]>('/api/stations'));
    setPerms(await api<Perm[]>('/api/users/permissions'));
  };
  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user]);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  const editing = f.id !== null;

  function openNew() {
    setError('');
    // Novo operador já vem com o que operadores sempre puderam fazer; o administrador marca ou desmarca o resto.
    setF({ ...blank, permissions: perms.filter((p) => p.padrao).map((p) => p.key) });
    setOpen(true);
  }

  function openEdit(u: UserRow) {
    setError('');
    setF({ id: u.id, name: u.name, email: u.email, password: '', role: u.role, stationIds: u.stationIds, permissions: u.permissions });
    setOpen(true);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (editing) {
        const body: Record<string, unknown> = { name: f.name, role: f.role, stationIds: f.stationIds, permissions: f.permissions };
        if (f.password) body.password = f.password;
        await api(`/api/users/${f.id}`, { method: 'PUT', body });
        toast('Usuário atualizado');
      } else {
        await api('/api/users', { method: 'POST', body: f });
        toast('Usuário criado');
      }
      setOpen(false);
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

  const togglePerm = (key: string, on: boolean) => setF({ ...f, permissions: on ? [...f.permissions, key] : f.permissions.filter((x) => x !== key) });

  return (
    <>
      <PageHeader
        title="Usuários"
        subtitle="Quem pode acessar o painel, quais estações cada operador gerencia e o que ele pode fazer."
        actions={<button onClick={openNew}><Icon name="plus" /> Novo usuário</button>}
      />
      <div className="card tight">
        {users === null ? (
          <div className="skeleton" style={{ height: 100, margin: 20, borderRadius: 12 }} />
        ) : users.length === 0 ? (
          <Empty icon="users" title="Nenhum usuário" />
        ) : (
          <table>
            <thead><tr><th>Usuário</th><th>Perfil</th><th className="hide-sm">Estações</th><th className="hide-sm">Permissões</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="avatar-sm">{(u.name || u.email).charAt(0).toUpperCase()}</span>
                    <strong>{u.name}</strong> <span className="muted">{u.email}</span>
                  </td>
                  <td><span className={`tag ${u.role === 'admin' ? 'accent' : ''}`}>{u.role === 'admin' ? 'Administrador' : 'Operador'}</span></td>
                  <td className="muted hide-sm">{u.role === 'admin' ? 'Todas' : u.stationIds.length}</td>
                  <td className="muted hide-sm">{u.role === 'admin' ? 'Tudo' : `${u.permissions.length} de ${perms.length}`}</td>
                  <td>
                    <div className="table-actions">
                      <button className="icon-btn" title="Editar" onClick={() => openEdit(u)}><Icon name="edit" /></button>
                      {u.id !== user.id && <button className="icon-btn" title="Excluir" onClick={() => remove(u)}><Icon name="trash" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={open}
        title={editing ? 'Editar usuário' : 'Novo usuário'}
        onClose={() => setOpen(false)}
        size="lg"
        footer={<><button className="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button><button form="user-form">{editing ? 'Salvar alterações' : 'Criar usuário'}</button></>}
      >
        <form id="user-form" className="fields" onSubmit={save}>
          <div className="field-row">
            <label className="field"><span>Nome</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label className="field"><span>Perfil</span>
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="user">Operador</option><option value="admin">Administrador</option>
              </select>
            </label>
          </div>
          <label className="field"><span>E-mail</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required disabled={editing} /></label>
          <label className="field">
            <span>{editing ? 'Nova senha' : 'Senha'}</span>
            <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required={!editing} minLength={8} autoComplete="new-password" />
            <small className="hint">{editing ? 'Deixe em branco para manter a senha atual. ' : ''}Mínimo de 8 caracteres.</small>
          </label>
          {f.role === 'admin' && <p className="muted small-text" style={{ margin: 0 }}>Administradores acessam todas as estações e podem fazer tudo no painel.</p>}
          {f.role === 'user' && (
            <>
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
              <div className="field">
                <span className="label">O que este operador pode fazer</span>
                <div className="perm-list">
                  {perms.map((p) => (
                    <label key={p.key} className="check-line perm-item">
                      <input type="checkbox" checked={f.permissions.includes(p.key)} onChange={(e) => togglePerm(p.key, e.target.checked)} />
                      <span><strong>{p.label}</strong><small className="hint" style={{ display: 'block' }}>{p.hint}</small></span>
                    </label>
                  ))}
                </div>
                <div className="row" style={{ margin: '6px 0 0' }}>
                  <button type="button" className="ghost small" onClick={() => setF({ ...f, permissions: perms.map((p) => p.key) })}>Marcar tudo</button>
                  <button type="button" className="ghost small" onClick={() => setF({ ...f, permissions: [] })}>Só visualizar</button>
                </div>
                <small className="hint">Sem a permissão, o item some do menu e a ação é bloqueada no servidor. Criar e excluir estações, usuários, backups e configurações do sistema ficam sempre só com administradores.</small>
              </div>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>
    </>
  );
}
