import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useUi } from '../ui';

interface Info {
  hosts: string[];
  email: string;
  issued: boolean;
  notAfter: string | null;
  daysLeft: number | null;
  lastError: string;
  lastOkAt: string;
  busy: boolean;
}

/** HTTPS nas portas das rádios (https://dominio:8070/stream): certificado Let's Encrypt emitido e renovado pelo painel. Só administrador. */
export default function TlsCard() {
  const { user } = useAuth();
  const { toast } = useUi();
  const [info, setInfo] = useState<Info | null>(null);
  const [hosts, setHosts] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Info>('/api/system/tls').then((i) => {
      setInfo(i);
      setHosts(i.hosts.join('\n'));
      setEmail(i.email);
    });
  useEffect(() => {
    if (user?.role === 'admin') load().catch(() => {});
  }, [user?.role]);

  if (user?.role !== 'admin' || !info) return null;

  async function issue() {
    setBusy(true);
    try {
      const list = hosts.split(/[\s,;]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
      await api('/api/system/tls', { method: 'PUT', body: { hosts: list, email } });
      const r = await api<Info>('/api/system/tls/issue', { method: 'POST' });
      setInfo(r);
      toast('Certificado emitido: as portas das rádios já aceitam HTTPS');
    } catch (e) {
      toast((e as Error).message, 'error');
      load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  const first = info.hosts[0] ?? 'stm.seudominio.com.br';
  return (
    <div className="card section">
      <div className="section-title">
        <h3>HTTPS nas portas das rádios</h3>
        <span className={`badge ${info.issued ? 'on' : 'off'}`}>{info.issued ? `certificado ok · ${info.daysLeft} dias` : 'sem certificado'}</span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        Faz funcionar <code>https://{first}:PORTA/stream</code> (além do <code>http://</code>) na porta de cada rádio, como no AzuraCast. Vale para todas as rádios, novas e antigas, usando a porta de cada uma. O painel pede e renova o certificado Let’s Encrypt sozinho.
      </p>
      <div className="fields">
        <label className="field">
          <span>Domínio(s) das rádios (um por linha)</span>
          <textarea rows={3} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="stm.seudominio.com.br" />
          <small className="hint">O domínio precisa apontar para o IP deste servidor e estar no Velix (a porta 80 do domínio precisa chegar ao painel). Para as portas (8070…) funcionarem, o registro no Cloudflare deve estar em “somente DNS” (nuvem cinza): o Cloudflare não repassa essas portas.</small>
        </label>
        <label className="field">
          <span>E-mail para avisos do Let’s Encrypt <em className="hint">(opcional)</em></span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" />
        </label>
        <div className="row" style={{ margin: 0 }}>
          <button type="button" onClick={issue} disabled={busy || info.busy || !hosts.trim()}>{busy || info.busy ? 'Emitindo… (até 1 min)' : info.issued ? 'Renovar agora' : 'Salvar e emitir certificado'}</button>
          {info.notAfter && <span className="muted small-text">Válido até {new Date(info.notAfter).toLocaleDateString()} · renova sozinho 30 dias antes</span>}
        </div>
        {info.lastError && <p className="error">Última tentativa: {info.lastError}</p>}
      </div>
    </div>
  );
}
