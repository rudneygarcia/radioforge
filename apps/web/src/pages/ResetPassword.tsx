import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import AuthShell from './AuthShell';

/** Nova senha, aberta pelo link recebido por e-mail (/reset?token=…). */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('As senhas não são iguais.');
    setBusy(true);
    try {
      await api('/api/auth/reset', { method: 'POST', body: { token, password } });
      setDone(true);
      setTimeout(() => nav('/login'), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Link inválido" subtitle="Este endereço não tem o código de recuperação.">
        <Link className="button login-submit" to="/forgot" style={{ textAlign: 'center' }}>Pedir um novo link</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Criar nova senha" subtitle="Escolha uma senha nova para a sua conta.">
      {done ? (
        <div className="login-form">
          <div className="req-msg ok" role="status"><span>Senha alterada! Levando você para o login…</span></div>
          <Link className="button login-submit" to="/login" style={{ textAlign: 'center' }}>Ir para o login</Link>
        </div>
      ) : (
        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span>Nova senha</span>
            <div className="pw-wrap">
              <input type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="Mínimo de 8 caracteres" minLength={8} required autoFocus />
              <button type="button" className="pw-toggle" onClick={() => setShow((v) => !v)}>{show ? 'Ocultar' : 'Mostrar'}</button>
            </div>
          </label>
          <label className="field">
            <span>Repita a nova senha</span>
            <input type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="login-submit" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
          <div className="login-links center"><Link to="/forgot">Pedir um novo link</Link></div>
        </form>
      )}
    </AuthShell>
  );
}
