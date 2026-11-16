import { useEffect, useRef, useState } from 'react';
import { api, downloadFile, uploadForm } from '../api';
import { Empty, Icon, PageHeader, useUi } from '../ui';

interface Backup {
  name: string;
  size: number;
  createdAt: string;
}

const fmtSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function BackupsPage() {
  const { confirm, toast } = useUi();
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [keep, setKeep] = useState(7);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [sending, setSending] = useState<number | null>(null); // % do envio em andamento
  const fileInput = useRef<HTMLInputElement>(null);

  /** Envia um backup baixado de outro servidor; ele entra na lista e aí é só clicar em Restaurar. */
  async function upload(file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setSending(0);
    try {
      await uploadForm('/api/backups/upload', form, (loaded, total) => setSending(Math.round((loaded / total) * 100))).promise;
      toast('Backup enviado: clique em Restaurar para usá-lo');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const load = () =>
    api<{ keep: number; backups: Backup[] }>('/api/backups')
      .then((r) => {
        setBackups(r.backups);
        setKeep(r.keep);
      })
      .catch((e) => toast((e as Error).message, 'error'));
  useEffect(() => {
    load();
  }, []);

  async function create() {
    setBusy(true);
    try {
      await api('/api/backups', { method: 'POST' });
      toast('Backup criado');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function restore(b: Backup) {
    if (
      !(await confirm({
        title: 'Restaurar este backup?',
        message: (
          <>
            O banco atual será substituído por <strong>{b.name}</strong> (uma cópia de segurança dele é guardada antes) e a API reinicia em alguns segundos. As estações caem por instantes. Músicas e gravações não mudam.
          </>
        ),
        confirmLabel: 'Restaurar',
        danger: true,
      }))
    )
      return;
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
      toast((e as Error).message, 'error');
    }
  }

  async function remove(b: Backup) {
    if (!(await confirm({ title: 'Apagar backup?', message: b.name, confirmLabel: 'Apagar', danger: true }))) return;
    await api(`/api/backups/${b.name}`, { method: 'DELETE' });
    toast('Backup apagado');
    load();
  }

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle={`Uma cópia do banco é criada todo dia; ficam as ${keep} mais recentes.`}
        actions={
          <div className="row" style={{ margin: 0 }}>
            <input ref={fileInput} type="file" accept=".db,application/octet-stream" hidden onChange={(e) => void upload(e.target.files?.[0])} />
            <button type="button" className="ghost" onClick={() => fileInput.current?.click()} disabled={sending !== null || restarting}><Icon name="upload" /> {sending !== null ? `Enviando… ${sending}%` : 'Enviar backup'}</button>
            <button onClick={create} disabled={busy}><Icon name="plus" /> {busy ? 'Criando…' : 'Fazer backup agora'}</button>
          </div>
        }
      />
      <div className="card notice">
        Inclui usuários, estações, playlists, relatórios, chaves de API e webhooks. <strong>Não inclui músicas nem gravações</strong>: para elas, copie o volume de dados do Docker.
        O arquivo contém dados sensíveis (hashes de senha, senhas de DJ): guarde-o em local seguro.
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h4 style={{ marginTop: 0 }}>Levar as configurações para outro servidor</h4>
        <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>Neste painel, clique em <strong>Baixar</strong> no backup mais recente (ou em <strong>Fazer backup agora</strong> e depois Baixar).</li>
          <li>No servidor novo, crie um administrador qualquer na primeira tela e entre. Vá em <strong>Backups → Enviar backup</strong> e escolha o arquivo baixado.</li>
          <li>Clique em <strong>Restaurar</strong> no arquivo enviado. A API reinicia em alguns segundos.</li>
          <li>Depois de restaurar, entre com o <strong>usuário e a senha do servidor antigo</strong> (o administrador temporário deixa de existir).</li>
        </ol>
        <p className="muted small-text" style={{ marginBottom: 0 }}>Vão junto: usuários, estações (portas, senhas de DJ, configurações), playlists, comerciais, relatórios e chaves de API. Não vão: as músicas e o certificado HTTPS (emita de novo em Sistema → HTTPS). Depois, copie as músicas para o servidor novo (SFTP ou volume do Docker) e reenvie o preset/biblioteca do Stereo Tool, se usar.</p>
      </div>
      {restarting && <div className="card notice">Restaurando… a API está reiniciando. Esta página recarrega sozinha quando ela voltar.</div>}
      <div className="card tight">
        {backups === null ? (
          <div className="skeleton" style={{ height: 90, margin: 20, borderRadius: 12 }} />
        ) : backups.length === 0 ? (
          <Empty icon="download" title="Nenhum backup ainda" text="O primeiro é criado automaticamente cerca de 1 minuto após a API iniciar." />
        ) : (
          <table>
            <thead><tr><th>Arquivo</th><th>Criado em</th><th className="hide-sm">Tamanho</th><th /></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.name}>
                  <td><code>{b.name}</code></td>
                  <td className="muted">{new Date(b.createdAt).toLocaleString()}</td>
                  <td className="muted hide-sm">{fmtSize(b.size)}</td>
                  <td>
                    <div className="table-actions">
                      <button className="ghost small" onClick={() => downloadFile(`/api/backups/${b.name}`, b.name).catch((e) => toast((e as Error).message, 'error'))}><Icon name="download" size={13} /> Baixar</button>
                      <button className="ghost small" onClick={() => restore(b)} disabled={restarting}><Icon name="refresh" size={13} /> Restaurar</button>
                      <button className="icon-btn" title="Apagar" onClick={() => remove(b)}><Icon name="trash" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
