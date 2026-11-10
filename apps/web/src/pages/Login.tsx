import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, type User } from '../api';
import { useAuth } from '../auth';
import AuthShell from './AuthShell';

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/setup/status').then((r) => setNeedsSetup(r.needsSetup));
  }, []);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api<{ token: string; user: User }>(needsSetup ? '/api/setup' : '/api/auth/login', {
        method: 'POST',
        body: needsSetup ? { name, email, password } : { email, password },
      });
      login(r.token, r.user);
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={needsSetup ? 'Criar administrador' : 'Bem-vindo de volta'} subtitle={needsSetup ? 'Crie a conta de administrador para começar' : 'Entre para gerenciar suas rádios'}>
      <form className="login-form" onSubmit={submit}>
        {needsSetup && (
          <label className="field">
            <span>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="field">
          <span>E-mail</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="voce@exemplo.com" required />
        </label>
        <label className="field">
          <span>Senha</span>
          <div className="pw-wrap">
            <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={needsSetup ? 'new-password' : 'current-password'} placeholder={needsSetup ? 'Mínimo de 8 caracteres' : 'Sua senha'} required />
            <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)} aria-label={show ? 'Ocultar a senha' : 'Mostrar a senha'}>{show ? 'Ocultar' : 'Mostrar'}</button>
          </div>
        </label>
        {!needsSetup && (
          <div className="login-links">
            <Link to="/forgot">Esqueci minha senha</Link>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <button className="login-submit" disabled={busy}>{busy ? 'Entrando…' : needsSetup ? 'Criar administrador' : 'Entrar'}</button>
      </form>
    </AuthShell>
  );
}
