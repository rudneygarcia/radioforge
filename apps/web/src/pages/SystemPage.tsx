import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon, PageHeader, useUi } from '../ui';
import SmtpCard from './SmtpCard';
import StorageCard from './StorageCard';
import TlsCard from './TlsCard';

interface Info {
  version: string;
  commit: string | null;
  builtAt: string | null;
  startedAt: string;
  node: string;
  engine: 'liquidsoap' | 'native';
  repo: string;
  branch: string;
  canUpdate: boolean;
  serverName: string;
}
interface Check {
  latest: { sha: string; message: string; date: string; author: string };
  upToDate: boolean | null;
}

interface UpStatus {
  state: 'idle' | 'queued' | 'running' | 'done' | 'error';
  at: number;
  log: string;
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

export default function SystemPage() {
  const { confirm, toast } = useUi();
  const [info, setInfo] = useState<Info | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // Andamento da atualização pedida pelo painel (instalação pelo install.sh).
  const [up, setUp] = useState<UpStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const since = useRef(0);

  useEffect(() => {
    api<Info>('/api/system').then(setInfo).catch((e) => setError((e as Error).message));
    // Se já havia uma atualização em andamento (página aberta de novo), volta a acompanhar.
    api<UpStatus>('/api/system/update-status').then((st) => {
      if ((st.state === 'queued' || st.state === 'running') && Date.now() / 1000 - st.at < 1800) {
        since.current = st.at * 1000;
        setUp(st);
        setWaiting(true);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(async () => {
      try {
        const st = await api<UpStatus>('/api/system/update-status');
        setUp(st);
        // Só vale o resultado deste pedido (e não o de uma atualização antiga).
        if (st.at * 1000 >= since.current - 2000 && (st.state === 'done' || st.state === 'error')) {
          setWaiting(false);
          if (st.state === 'done') {
            toast('Atualizado! Recarregando…');
            setTimeout(() => location.reload(), 1500);
          }
        }
      } catch {
        // o painel reinicia no final da atualização: continua tentando
        setUp((u) => (u ? { ...u, state: 'running' } : u));
      }
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, toast]);

  const [srvName, setSrvName] = useState<string | null>(null);
  async function saveName() {
    setBusy('name');
    try {
      const r = await api<{ serverName: string }>('/api/system/name', { method: 'PUT', body: { name: srvName ?? '' } });
      setInfo((i) => (i ? { ...i, serverName: r.serverName } : i));
      setSrvName(null);
      toast('Nome do painel salvo');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  async function verify() {
    setBusy('check');
    setError('');
    try {
      setCheck(await api<Check>('/api/system/check', { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function update() {
    if (!(await confirm({ title: 'Atualizar agora?', message: 'O painel e as estações ficam fora do ar por alguns instantes durante o deploy.', confirmLabel: 'Atualizar' }))) return;
    setBusy('update');
    try {
      const r = await api<{ message: string; tracked?: boolean }>('/api/system/update', { method: 'POST' });
      toast(r.message);
      if (r.tracked) {
        since.current = Date.now();
        setUp({ state: 'queued', at: Math.floor(Date.now() / 1000), log: '' });
        setWaiting(true);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  if (!info) return error ? <p className="error">{error}</p> : <div className="card skeleton" style={{ height: 160 }} />;

  return (
    <>
      <PageHeader title="Sistema" subtitle="Versão em uso e atualizações." />

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Nome do painel</h3>
        <p className="muted small-text" style={{ marginTop: 0 }}>Aparece na tela de login, logo abaixo de “Bem-vindo de volta”, para você saber em qual servidor está entrando (útil quando se tem vários painéis).</p>
        <form className="row" style={{ margin: 0 }} onSubmit={(e) => { e.preventDefault(); saveName(); }}>
          <input value={srvName ?? info.serverName} onChange={(e) => setSrvName(e.target.value)} placeholder="Ex.: Servidor SP 01" maxLength={60} style={{ flex: 1, minWidth: 220 }} />
          <button disabled={busy === 'name' || srvName === null || srvName === info.serverName}>{busy === 'name' ? 'Salvando…' : 'Salvar'}</button>
        </form>
      </div>

      <div className="grid">
        <div className="card">
          <h3>Versão em uso</h3>
          <dl className="kv">
            <dt>Versão</dt><dd>{info.version}</dd>
            <dt>Commit</dt><dd>{info.commit ? <code>{info.commit.slice(0, 7)}</code> : '—'}</dd>
            <dt>Build em</dt><dd>{when(info.builtAt)}</dd>
            <dt>API iniciada</dt><dd>{when(info.startedAt)}</dd>
            <dt>Streaming</dt><dd>{info.engine === 'liquidsoap' ? 'Icecast + Liquidsoap' : 'Simples (Node)'}</dd>
            <dt>Node.js</dt><dd>{info.node}</dd>
            <dt>Repositório</dt><dd>{info.repo} <span className="muted">({info.branch})</span></dd>
          </dl>
        </div>

        <div className="card">
          <h3>Atualizações</h3>
          <div className="row">
            <button onClick={verify} disabled={!!busy}><Icon name="refresh" /> {busy === 'check' ? 'Verificando…' : 'Verificar atualização'}</button>
            {check && check.upToDate === false && info.canUpdate && (
              <button onClick={update} disabled={!!busy || waiting}>{busy === 'update' ? 'Solicitando…' : 'Atualizar agora'}</button>
            )}
          </div>
          {error && <p className="error">{error}</p>}
          {up && up.state !== 'idle' && (waiting || up.state === 'error') && (
            <div className="card notice" style={{ marginTop: 12 }}>
              {up.state === 'queued' && <p style={{ margin: 0 }}><strong>Atualização pedida.</strong> Aguardando o servidor começar… {Date.now() / 1000 - up.at > 120 && <>Está demorando: confira se o serviço <code>radioforge-update.path</code> está ativo ou rode <code>radioforge update</code> no servidor.</>}</p>}
              {up.state === 'running' && <p style={{ margin: 0 }}><strong>Atualizando…</strong> O painel continua no ar durante a compilação (alguns minutos) e reinicia no final. Esta página recarrega sozinha.</p>}
              {up.state === 'error' && <p style={{ margin: 0 }}><strong>A atualização falhou.</strong> Veja o final do registro abaixo; o painel anterior continua em uso.</p>}
              {up.log && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, maxHeight: 220, overflow: 'auto', margin: '10px 0 0' }}>{up.log}</pre>}
            </div>
          )}
          {check && (
            <>
              <p>
                {check.upToDate === true && <span className="badge on">em dia</span>}
                {check.upToDate === false && <span className="badge off">há versão nova</span>}
                {check.upToDate === null && <span className="badge off">não foi possível comparar</span>}
              </p>
              <p className="muted">
                Último commit em <code>{info.branch}</code>: <code>{check.latest.sha.slice(0, 7)}</code> — {check.latest.message}
                {check.latest.author ? ` (${check.latest.author}, ${when(check.latest.date)})` : ''}
              </p>
            </>
          )}
          {check?.upToDate === false && !info.canUpdate && (
            <p className="muted small-text">
              Faça o deploy pelo seu painel (com o deploy automático ligado, cada push no GitHub já atualiza sozinho). Para ter o botão “Atualizar agora” aqui, defina <code>UPDATE_WEBHOOK_URL</code>.
            </p>
          )}
        </div>
      </div>
      <StorageCard />
      <TlsCard />
      <SmtpCard />
    </>
  );
}
