import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiKey } from '../api';

export default function AccountPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
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
      const r = await api<{ key: string }>('/api/me/keys', { method: 'POST', body: { name } });
      setNewKey(r.key);
      setName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(k: ApiKey) {
    if (!confirm(`Revogar a chave "${k.name}"? Quem a usa perde o acesso.`)) return;
    await api(`/api/me/keys/${k.id}`, { method: 'DELETE' });
    load();
  }

  return (
    <>
      <h1>Chaves de API</h1>
      <p className="muted">Use uma chave para acessar a API de fora do painel (bots, scripts, outros sistemas). Ela tem as mesmas permissões da sua conta.</p>

      <form className="card row" onSubmit={create}>
        <input placeholder="Nome da chave (ex.: Bot do Discord)" value={name} onChange={(e) => setName(e.target.value)} required />
        <button>Criar chave</button>
        {error && <p className="error">{error}</p>}
      </form>

      {newKey && (
        <div className="card">
          <h3>Copie agora: esta chave não será mostrada de novo</h3>
          <p><code>{newKey}</code></p>
          <button className="ghost small" onClick={() => navigator.clipboard.writeText(newKey)}>Copiar</button>{' '}
          <button className="ghost small" onClick={() => setNewKey(null)}>Já copiei</button>
        </div>
      )}

      <div className="card">
        <table>
          <thead><tr><th>Nome</th><th>Início da chave</th><th>Criada</th><th>Último uso</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td><code>{k.prefix}…</code></td>
                <td className="muted">{new Date(k.createdAt + 'Z').toLocaleString()}</td>
                <td className="muted">{k.lastUsedAt ? new Date(k.lastUsedAt + 'Z').toLocaleString() : 'nunca'}</td>
                <td><button className="danger small" onClick={() => remove(k)}>Revogar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {keys.length === 0 && <p className="muted">Nenhuma chave ainda.</p>}
      </div>

      <div className="card">
        <h3>Exemplo de uso</h3>
        <p className="muted">Listar suas estações:</p>
        <p><code>curl -H "X-API-Key: rfk_suachave" {location.origin}/api/stations</code></p>
        <p className="muted">Veja a lista completa de endpoints no README do projeto.</p>
      </div>
    </>
  );
}
