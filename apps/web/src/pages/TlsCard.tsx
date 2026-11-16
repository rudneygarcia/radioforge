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
  source: string;
  traefikFile: string;
}

/** HTTPS nas portas das rádios (https://dominio:8070/stream): certificado Let's Encrypt emitido e renovado pelo painel. Só administrador. */
export default function TlsCard() {
  const { user } = useAuth();
  const { toast } = useUi();
  const [info, setInfo] = useState<Info | null>(null);
  const [hosts, setHosts] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [pem, setPem] = useState({ cert: '', key: '' });

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

  async function usePem() {
    setBusy(true);
    try {
      const list = hosts.split(/[\s,;]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
      await api('/api/system/tls', { method: 'PUT', body: { hosts: list, email } });
      setInfo(await api<Info>('/api/system/tls/pem', { method: 'POST', body: pem }));
      setPem({ cert: '', key: '' });
      toast('Certificado em uso: as portas das rádios já aceitam HTTPS');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function useTraefik() {
    setBusy(true);
    try {
      setInfo(await api<Info>('/api/system/tls/traefik', { method: 'POST' }));
      toast('Certificado do Traefik em uso');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const first = info.hosts[0] ?? 'stm.seudominio.com.br';
  return (
    <div className="card section">
      <div className="section-title">
        <h3>HTTPS do painel e das portas das rádios</h3>
        <span className={`badge ${info.issued ? 'on' : 'off'}`}>{info.issued ? `certificado ok · ${info.daysLeft} dias` : 'sem certificado'}</span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        Faz funcionar <code>https://{first}:PORTA/stream</code> (além do <code>http://</code>) na porta de cada rádio, como no AzuraCast. Vale para todas as rádios, novas e antigas, usando a porta de cada uma. O painel pede e renova o certificado Let’s Encrypt sozinho.
      </p>
      <p className="muted small-text" style={{ marginTop: -4 }}>
        Em servidor instalado com o <code>install.sh</code> (portas 80 e 443 direto no painel, como no AzuraCast), o mesmo certificado também liga o <strong>HTTPS do painel</strong> em <code>https://{first}</code>, para todos os domínios da lista, sem reiniciar. No Velix, o HTTPS da tela continua vindo do Traefik.
      </p>
      <div className="fields">
        <label className="field">
          <span>Domínio(s) das rádios (um por linha)</span>
          <textarea rows={5} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder={'stm.seudominio.com.br\nradio.outrodominio.com'} />
          <small className="hint">Pode colocar vários domínios (até 50), todos num só certificado. Cada um precisa apontar para o IP deste servidor, com a porta 80 chegando ao painel. Se algum não chegar, ele fica de fora e os outros são emitidos mesmo assim (o painel avisa quais ficaram de fora). Para as portas (8070…) funcionarem, o registro no Cloudflare deve estar em “somente DNS” (nuvem cinza): o Cloudflare não repassa essas portas.</small>
        </label>
        <label className="field">
          <span>E-mail para avisos do Let’s Encrypt <em className="hint">(opcional)</em></span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" />
        </label>
        <div className="row" style={{ margin: 0 }}>
          <button type="button" onClick={issue} disabled={busy || info.busy || !hosts.trim()}>{busy || info.busy ? 'Emitindo… (até 1 min)' : info.issued ? 'Renovar agora' : 'Salvar e emitir certificado'}</button>
          {info.notAfter && <span className="muted small-text">Válido até {new Date(info.notAfter).toLocaleDateString()} · renova sozinho 30 dias antes</span>}
        </div>
        {info.lastError && <p className="error">{info.lastError.startsWith('Certificado emitido') ? 'Atenção: ' : 'Última tentativa: '}{info.lastError}</p>}
        {info.issued && <p className="muted small-text" style={{ margin: 0 }}>Origem do certificado: {info.source === 'traefik' ? 'Traefik (acme.json)' : info.source === 'manual' ? 'colado manualmente' : 'Let’s Encrypt (emitido pelo painel)'}</p>}
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Já tenho o certificado (Traefik do Velix ou outro)</summary>
          <div className="fields" style={{ marginTop: 10 }}>
            <p className="muted small-text" style={{ margin: 0 }}>O Traefik guarda os certificados no arquivo <code>acme.json</code> do servidor, que este painel não enxerga sozinho. Duas formas de reaproveitar o certificado que ele já emitiu: (1) se o Velix permitir montar o <code>acme.json</code> neste contêiner, defina a variável <code>TRAEFIK_ACME_JSON</code> com o caminho dele (ex.: <code>/traefik/acme.json</code>) e use o botão abaixo; ou (2) cole aqui o certificado completo e a chave privada em PEM.</p>
            {info.traefikFile && <div className="row" style={{ margin: 0 }}><button type="button" className="ghost" onClick={useTraefik} disabled={busy || !hosts.trim()}>Ler do acme.json do Traefik</button><small className="hint">{info.traefikFile}</small></div>}
            <label className="field"><span>Certificado completo (PEM)</span><textarea rows={4} value={pem.cert} onChange={(e) => setPem({ ...pem, cert: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }} /></label>
            <label className="field"><span>Chave privada (PEM)</span><textarea rows={4} value={pem.key} onChange={(e) => setPem({ ...pem, key: e.target.value })} placeholder="-----BEGIN PRIVATE KEY-----" style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }} autoComplete="off" /></label>
            <div className="row" style={{ margin: 0 }}><button type="button" onClick={usePem} disabled={busy || !hosts.trim() || !pem.cert.trim() || !pem.key.trim()}>Usar este certificado</button><small className="hint">A chave fica só no servidor. Quando faltarem 3 dias para vencer, o painel avisa aqui.</small></div>
          </div>
        </details>
      </div>
    </div>
  );
}
