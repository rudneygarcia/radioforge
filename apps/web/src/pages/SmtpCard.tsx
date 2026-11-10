import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useUi } from '../ui';

interface Cfg {
  configured: boolean;
  source: 'env' | 'painel' | null;
  host: string;
  port: number;
  user: string;
  from: string;
  secure: boolean;
  passSet: boolean;
}

/** E-mail (SMTP): usado para enviar o link de "Esqueci minha senha". Só administrador. */
export default function SmtpCard() {
  const { user } = useAuth();
  const { toast } = useUi();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [form, setForm] = useState({ host: '', port: 587, user: '', pass: '', from: '', secure: false });
  const [to, setTo] = useState(user?.email ?? '');
  const [busy, setBusy] = useState('');

  const load = () =>
    api<Cfg>('/api/system/smtp').then((c) => {
      setCfg(c);
      setForm({ host: c.host, port: c.port, user: c.user, pass: '', from: c.from, secure: c.secure });
    });
  useEffect(() => {
    if (user?.role === 'admin') load().catch(() => {});
  }, [user?.role]);

  if (user?.role !== 'admin' || !cfg) return null;
  const locked = cfg.source === 'env';

  async function save() {
    setBusy('save');
    try {
      await api('/api/system/smtp', { method: 'PUT', body: form });
      toast(form.host.trim() ? 'E-mail configurado' : 'Envio de e-mail desligado');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function test() {
    setBusy('test');
    try {
      await api('/api/system/smtp/test', { method: 'POST', body: { to } });
      toast(`E-mail de teste enviado para ${to}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card section">
      <div className="section-title">
        <h3>E-mail (recuperação de senha)</h3>
        <span className={`badge ${cfg.configured ? 'on' : 'off'}`}>{cfg.configured ? 'configurado' : 'não configurado'}</span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        Usado para enviar o link de <strong>“Esqueci minha senha”</strong> ao e-mail cadastrado do usuário. Informe os dados do seu servidor de e-mail (SMTP): Gmail, Zoho, Brevo, Amazon SES, o e-mail da hospedagem etc.
        {locked && ' As variáveis de ambiente SMTP_HOST… estão em uso e têm prioridade: altere-as no servidor.'}
      </p>
      <div className="fields">
        <div className="field-row">
          <label className="field"><span>Servidor SMTP</span><input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.seudominio.com" disabled={locked} /></label>
          <label className="field"><span>Porta</span><input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 587 })} disabled={locked} /></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Usuário</span><input value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} autoComplete="off" disabled={locked} /></label>
          <label className="field"><span>Senha {cfg.passSet && <em className="hint">(já salva)</em>}</span><input type="password" value={form.pass} onChange={(e) => setForm({ ...form, pass: e.target.value })} placeholder={cfg.passSet ? '•••••••• (deixe vazio para manter)' : ''} autoComplete="new-password" disabled={locked} /></label>
        </div>
        <label className="field"><span>Remetente (De)</span><input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="RadioForge <nao-responder@seudominio.com>" disabled={locked} /></label>
        <label className="check-line">
          <input type="checkbox" checked={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.checked })} disabled={locked} />
          <span>Conexão segura direta (SSL/TLS)<small>Marque para a porta 465. Para a porta 587 deixe desmarcado (usa STARTTLS sozinho).</small></span>
        </label>
        {!locked && (
          <div className="row" style={{ margin: 0 }}>
            <button type="button" onClick={save} disabled={!!busy}>{busy === 'save' ? 'Salvando…' : 'Salvar'}</button>
            <small className="hint">Deixe o servidor em branco e salve para desligar o envio de e-mail.</small>
          </div>
        )}
        {cfg.configured && (
          <div className="row" style={{ margin: '4px 0 0' }}>
            <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="enviar teste para…" style={{ flex: 1, minWidth: 200 }} />
            <button type="button" className="ghost" onClick={test} disabled={!!busy || !to}>{busy === 'test' ? 'Enviando…' : 'Enviar e-mail de teste'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
