import { useEffect, useState } from 'react';
import { api } from '../api';

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
  const [info, setInfo] = useState<Info | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Info>('/api/system').then(setInfo).catch((e) => setError((e as Error).message));
  }, []);

  async function verify() {
    setBusy('check');
    setError('');
    setMsg('');
    try {
      setCheck(await api<Check>('/api/system/check', { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function update() {
    if (!confirm('Atualizar agora? O painel e as estações ficam fora do ar por alguns instantes durante o deploy.')) return;
    setBusy('update');
    setError('');
    try {
      const r = await api<{ message: string }>('/api/system/update', { method: 'POST' });
      setMsg(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  if (!info) return error ? <p className="error">{error}</p> : <p className="muted">Carregando…</p>;

  return (
    <>
      <h1>Sistema</h1>
      <div className="card">
        <h3>Versão em uso</h3>
        <table>
          <tbody>
            <tr><td className="muted">Versão</td><td>{info.version}</td></tr>
            <tr><td className="muted">Commit</td><td>{info.commit ? <code>{info.commit.slice(0, 7)}</code> : '— (desconhecido)'}</td></tr>
            <tr><td className="muted">Build em</td><td>{when(info.builtAt)}</td></tr>
            <tr><td className="muted">API iniciada em</td><td>{when(info.startedAt)}</td></tr>
            <tr><td className="muted">Motor de streaming</td><td>{info.engine === 'liquidsoap' ? 'Icecast + Liquidsoap' : 'Simples (Node)'}</td></tr>
            <tr><td className="muted">Node.js</td><td>{info.node}</td></tr>
            <tr><td className="muted">Repositório</td><td>{info.repo} ({info.branch})</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Atualizações</h3>
        <div className="row">
          <button onClick={verify} disabled={!!busy}>{busy === 'check' ? 'Verificando…' : 'Verificar atualização'}</button>
          {check && check.upToDate === false && info.canUpdate && (
            <button onClick={update} disabled={!!busy}>{busy === 'update' ? 'Solicitando…' : 'Atualizar agora'}</button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        {msg && <p>{msg}</p>}
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
          <p className="muted">
            Para atualizar, faça o deploy pelo seu painel (com o deploy automático ligado, cada push no GitHub já atualiza sozinho). Para ter o botão
            "Atualizar agora" aqui, defina a variável <code>UPDATE_WEBHOOK_URL</code> com a URL de redeploy.
          </p>
        )}
      </div>
    </>
  );
}
