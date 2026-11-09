import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, getToken, type Dj, type Recording } from '../api';
import type { StationCtx } from './StationLayout';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const mb =(n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function DjsPage() {
  const { station } = useOutletContext<StationCtx>();
  const [djs, setDjs] = useState<Dj[]>([]);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const base = `/api/stations/${station.id}`;

  const load = async () => {
    setDjs(await api<Dj[]>(`${base}/djs`));
    setRecs(await api<Recording[]>(`${base}/recordings`));
  };
  useEffect(() => {
    load();
  }, [station.id]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(`${base}/djs`, { method: 'POST', body: { username, displayName } });
      setUsername('');
      setDisplayName('');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function update(d: Dj, change: Partial<Pick<Dj, 'enabled' | 'scheduleEnabled' | 'startTime' | 'endTime' | 'days'>> & { resetPassword?: boolean }) {
    setError('');
    try {
      await api(`${base}/djs/${d.id}`, { method: 'PUT', body: change });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const [editing, setEditing] = useState<number | null>(null);
  const patchDj = (id: number, change: Partial<Dj>) => setDjs((l) => l.map((x) => (x.id === id ? { ...x, ...change } : x)));

  async function remove(d: Dj) {
    if (!confirm(`Excluir o DJ "${d.username}"?`)) return;
    await api(`${base}/djs/${d.id}`, { method: 'DELETE' });
    load();
  }

  // O download precisa do token no cabeçalho, então baixamos como blob.
  async function download(r: Recording) {
    const res = await fetch(`${base}/recordings/${encodeURIComponent(r.name)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return setError('Não foi possível baixar a gravação.');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = r.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function removeRec(r: Recording) {
    if (!confirm(`Excluir a gravação ${r.name}?`)) return;
    await api(`${base}/recordings/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
    load();
  }

  if (!station.liveEnabled) return <p className="muted">A transmissão ao vivo está desativada nas Configurações.</p>;

  return (
    <>
      <div className="card">
        <h3>DJs ao vivo</h3>
        {station.dj && (
          <p className="muted">
            Conecte no software de transmissão (BUTT, Mixxx, OBS) em <code>{station.dj.host}</code> porta <code>{station.dj.port}</code>, mountpoint <code>{station.dj.mount}</code>, com o usuário e a senha do DJ.
          </p>
        )}
        <form className="row" onSubmit={create}>
          <input placeholder="Usuário do DJ" value={username} onChange={(e) => setUsername(e.target.value)} required />
          <input placeholder="Nome de exibição" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <button>Criar DJ</button>
        </form>
        {error && <p className="error">{error}</p>}
        <table>
          <thead><tr><th>Usuário</th><th>Nome</th><th>Senha</th><th>Horário</th><th /></tr></thead>
          <tbody>
            {djs.map((d) => (
              <Fragment key={d.id}>
                <tr>
                  <td>{d.username} {!d.enabled && <span className="badge off">desativado</span>}</td>
                  <td>{d.displayName}</td>
                  <td><code>{d.password}</code></td>
                  <td className="muted">
                    {d.scheduleEnabled ? `${d.startTime}–${d.endTime} · ${d.days.length === 7 ? 'todos os dias' : d.days.map((x) => DAYS[x]).join(', ')}` : 'sempre'}
                  </td>
                  <td className="row">
                    <button className="ghost small" onClick={() => setEditing(editing === d.id ? null : d.id)}>Horário</button>
                    <button className="ghost small" onClick={() => update(d, { enabled: !d.enabled })}>{d.enabled ? 'Desativar' : 'Ativar'}</button>
                    <button className="ghost small" onClick={() => update(d, { resetPassword: true })}>Nova senha</button>
                    <button className="danger small" onClick={() => remove(d)}>Excluir</button>
                  </td>
                </tr>
                {editing === d.id && (
                  <tr key={`${d.id}-sched`}>
                    <td colSpan={5}>
                      <div className="row">
                        <label><input type="checkbox" checked={d.scheduleEnabled} onChange={(e) => patchDj(d.id, { scheduleEnabled: e.target.checked })} /> Só pode transmitir neste horário (fora dele a conexão é recusada)</label>
                      </div>
                      {d.scheduleEnabled && (
                        <div className="row">
                          <label>Das <input type="time" value={d.startTime} onChange={(e) => patchDj(d.id, { startTime: e.target.value })} /></label>
                          <label>às <input type="time" value={d.endTime} onChange={(e) => patchDj(d.id, { endTime: e.target.value })} /></label>
                          {DAYS.map((name, i) => (
                            <label key={i}>
                              <input type="checkbox" checked={d.days.includes(i)} onChange={(e) => patchDj(d.id, { days: e.target.checked ? [...d.days, i] : d.days.filter((x) => x !== i) })} /> {name}
                            </label>
                          ))}
                        </div>
                      )}
                      <button className="small" onClick={() => update(d, { scheduleEnabled: d.scheduleEnabled, startTime: d.startTime, endTime: d.endTime, days: d.days }).then(() => setEditing(null))}>Salvar horário</button>
                      <p className="muted">O horário é o do servidor (UTC no Docker). Quem já está no ar não é derrubado quando a janela termina.</p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {djs.length === 0 && <p className="muted">Nenhum DJ ainda. Enquanto isso, o usuário <code>source</code> com a senha da estação continua funcionando.</p>}
      </div>

      <div className="card">
        <h3>Gravações ({recs.length})</h3>
        {!station.recordLive && <p className="muted">A gravação está desligada. Ative em Configurações.</p>}
        <table>
          <tbody>
            {recs.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="muted">{mb(r.size)}</td>
                <td className="muted">{new Date(r.modifiedAt).toLocaleString()}</td>
                <td className="row">
                  <button className="small" onClick={() => download(r)}>Baixar</button>
                  <button className="danger small" onClick={() => removeRec(r)}>Excluir</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
