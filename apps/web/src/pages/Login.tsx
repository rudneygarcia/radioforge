import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, type User } from '../api';
import { useAuth } from '../auth';

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/setup/status').then((r) => setNeedsSetup(r.needsSetup));
  }, []);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ token: string; user: User }>(needsSetup ? '/api/setup' : '/api/auth/login', {
        method: 'POST',
        body: needsSetup ? { name, email, password } : { email, password },
      });
      login(r.token, r.user);
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <h1>📻 RadioForge</h1>
      <p className="muted">{needsSetup ? 'Crie a conta de administrador' : 'Entre no painel'}</p>
      {needsSetup && <input placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} required />}
      <input type="email" placeholder="E-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input type="password" placeholder="Senha (mín. 8 caracteres)" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p className="error">{error}</p>}
      <button>{needsSetup ? 'Criar administrador' : 'Entrar'}</button>
    </form>
  );
}
