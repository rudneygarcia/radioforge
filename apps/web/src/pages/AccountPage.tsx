import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiKey } from '../api';
import { CopyButton, Empty, Icon, Modal, PageHeader, useUi } from '../ui';

export default function AccountPage() {
  const { confirm, toast } = useUi();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => api<ApiKey[]>('/api/me/keys').then(setKeys);
  useEffect(() => {
    load();
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ key: string }>('/api/me/keys', { method: 'POST', body: { name, readOnly } });
      setOpen(false);
      setNewKey(r.key);
      setName('');
      setReadOnly(false);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(k: ApiKey) {
    if (!(await confirm({ title: 'Revogar chave?', message: `Quem usa a chave "${k.name}" perde o acesso imediatamente.`, confirmLabel: 'Revogar', danger: true }))) return;
    await api(`/api/me/keys/${k.id}`, { method: 'DELETE' });
    toast('Chave revogada');
    load();
  }

  return (
    <>
      <PageHeader
        title="Chaves de API"
        subtitle="Acesse a API de fora do painel (bots, scripts, outros sistemas) com as mesmas permissões da sua conta."
        actions={<button onClick={() => setOpen(true)}><Icon name="plus" /> Nova chave</button>}
      />

      <div className="card tight">
        {keys === null ? (
          <div className="skeleton" style={{ height: 90, margin: 20, borderRadius: 12 }} />
        ) : keys.length === 0 ? (
          <Empty icon="key" title="Nenhuma chave ainda" text="Crie uma chave para integrar bots e scripts." action={<button onClick={() => setOpen(true)}><Icon name="plus" /> Criar chave</button>} />
        ) : (
          <table>
            <thead><tr><th>Nome</th><th>Acesso</th><th className="hide-sm">Início</th><th className="hide-sm">Último uso</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><strong>{k.name}</strong></td>
                  <td><span className={`tag ${k.readOnly ? '' : 'accent'}`}>{k.readOnly ? 'Somente leitura' : 'Total'}</span></td>
                  <td className="hide-sm"><code>{k.prefix}…</code></td>
                  <td className="muted hide-sm">{k.lastUsedAt ? new Date(k.lastUsedAt + 'Z').toLocaleString() : 'nunca'}</td>
                  <td><div className="table-actions"><button className="danger small" onClick={() => remove(k)}>Revogar</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Exemplo de uso</h3>
        <p className="muted">Listar suas estações:</p>
        <div className="copy-row">
          <code>curl -H "X-API-Key: rfk_suachave" {location.origin}/api/stations</code>
          <CopyButton text={`curl -H "X-API-Key: rfk_suachave" ${location.origin}/api/stations`} />
        </div>
        <p className="muted small-text">A lista completa de endpoints está no README do projeto.</p>
      </div>

      <Modal
        open={open}
        size="sm"
        title="Nova chave de API"
        onClose={() => setOpen(false)}
        footer={<><button className="ghost" type="button" onClick={() => setOpen(false)}>Cancelar</button><button form="new-key">Criar chave</button></>}
      >
        <form id="new-key" className="fields" onSubmit={create}>
          <label className="field"><span>Nome</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Bot do Discord" required /></label>
          <label className="check-line">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            <span>Somente leitura <small>Só consulta dados; qualquer alteração é recusada.</small></span>
          </label>
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>

      <Modal
        open={!!newKey}
        size="sm"
        title="Chave criada"
        onClose={() => setNewKey(null)}
        footer={<button onClick={() => setNewKey(null)}>Já copiei</button>}
      >
        <p className="muted" style={{ marginTop: 0 }}>Copie agora: esta chave <strong>não será mostrada de novo</strong>.</p>
        <p><code>{newKey}</code></p>
        {newKey && <CopyButton text={newKey} label="Copiar chave" />}
      </Modal>
    </>
  );
}
