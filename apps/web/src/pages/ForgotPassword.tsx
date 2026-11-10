import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import AuthShell from './AuthShell';

/** Esqueci a senha: manda um link por e-mail para o endereço cadastrado. */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    api<{ emailEnabled: boolean }>('/api/auth/forgot/status').then((r) => setEnabled(r.emailEnabled)).catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ message: string }>('/api/auth/forgot', { method: 'POST', body: { email } });
      setDone(r.message);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Esqueceu a senha?" subtitle="Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha.">
      {done ? (
        <div className="login-form">
          <div className="req-msg ok" role="status"><span>{done}</span></div>
          <Link className="button login-submit" to="/login" style={{ textAlign: 'center' }}>Voltar para o login</Link>
        </div>
      ) : (
        <form className="login-form" onSubmit={submit}>
          {!enabled && <div className="req-msg err" role="alert"><span>O envio de e-mail ainda não foi configurado neste painel. Peça ao administrador para configurar em Sistema → E-mail.</span></div>}
          <label className="field">
            <span>E-mail</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="voce@exemplo.com" required autoFocus />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="login-submit" disabled={busy || !enabled}>{busy ? 'Enviando…' : 'Enviar link por e-mail'}</button>
          <div className="login-links center"><Link to="/login">← Voltar para o login</Link></div>
        </form>
      )}
    </AuthShell>
  );
}
