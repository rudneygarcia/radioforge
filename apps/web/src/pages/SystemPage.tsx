import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon, PageHeader, useUi } from '../ui';
import SmtpCard from './SmtpCard';
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
}
interface Check {
  latest: { sha: string; message: string; date: string; author: string };
  upToDate: boolean | null;
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

export default function SystemPage() {
  const { confirm, toast } = useUi();
  const [info, setInfo] = useState<Info | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Info>('/api/system').then(setInfo).catch((e) => setError((e as Error).message));
  }, []);

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
      const r = await api<{ message: string }>('/api/system/update', { method: 'POST' });
      toast(r.message);
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
              <button onClick={update} disabled={!!busy}>{busy === 'update' ? 'Solicitando…' : 'Atualizar agora'}</button>
            )}
          </div>
          {error && <p className="error">{error}</p>}
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
      <TlsCard />
      <SmtpCard />
    </>
  );
}
