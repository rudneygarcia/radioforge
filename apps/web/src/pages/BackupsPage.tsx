import { useEffect, useState } from 'react';
import { api, downloadFile } from '../api';

interface Backup {
  name: string;
  size: number;
  createdAt: string;
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [keep, setKeep] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restarting, setRestarting] = useState(false);

  const load = () =>
    api<{ keep: number; backups: Backup[] }>('/api/backups')
      .then((r) => {
        setBackups(r.backups);
        setKeep(r.keep);
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  async function create() {
    setBusy(true);
    setError('');
    try {
      await api('/api/backups', { method: 'POST' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(b: Backup) {
    if (
      !confirm(
        `Restaurar o backup ${b.name}?\n\nO banco atual será substituído (uma cópia de segurança dele é guardada antes) e a API reinicia em alguns segundos. As estações caem por instantes. Músicas e gravações não mudam.`,
      )
    )
      return;
    setError('');
    try {
      await api('/api/backups/' + b.name + '/restore', { method: 'POST' });
      setRestarting(true);
      // Espera a API voltar e recarrega a página.
      const t = setInterval(async () => {
        try {
          const r = await fetch('/api/health');
          if (r.ok) {
            clearInterval(t);
            location.reload();
          }
        } catch {
          /* ainda reiniciando */
        }
      }, 3000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(b: Backup) {
    if (!confirm(`Apagar o backup ${b.name}?`)) return;
    await api(`/api/backups/${b.name}`, { method: 'DELETE' });
    load();
  }

  return (
    <>
      <div className="row between">
        <h1>Backups</h1>
        <button onClick={create} disabled={busy}>{busy ? 'Criando…' : 'Fazer backup agora'}</button>
      </div>
      <p className="muted">
        Uma cópia do banco é criada automaticamente todo dia; ficam guardadas as {keep} mais recentes. O backup inclui usuários, estações,
        playlists, relatórios, chaves de API e webhooks. <strong>Não inclui músicas nem gravações</strong>: para elas, copie o volume de dados do Docker.
        O arquivo contém dados sensíveis (hashes de senha, senhas de DJ): guarde-o em local seguro.
      </p>
      {error && <p className="error">{error}</p>}
      {restarting && <div className="card notice">Restaurando… a API está reiniciando. Esta página recarrega sozinha quando ela voltar.</div>}
      <div className="card">
        <table>
          <thead><tr><th>Arquivo</th><th>Criado em</th><th>Tamanho</th><th /></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.name}>
                <td><code>{b.name}</code></td>
                <td className="muted">{new Date(b.createdAt).toLocaleString()}</td>
                <td className="muted">{fmtSize(b.size)}</td>
                <td>
                  <button className="ghost small" onClick={() => downloadFile(`/api/backups/${b.name}`, b.name).catch((e) => setError((e as Error).message))}>Baixar</button>{' '}
                  <button className="ghost small" onClick={() => restore(b)} disabled={restarting}>Restaurar</button>{' '}
                  <button className="danger small" onClick={() => remove(b)}>Apagar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {backups.length === 0 && <p className="muted">Nenhum backup ainda. O primeiro é criado automaticamente cerca de 1 minuto após a API iniciar.</p>}
      </div>
    </>
  );
}
