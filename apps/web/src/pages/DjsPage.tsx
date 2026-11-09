import { useEffect, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, downloadFile, type Dj, type Recording } from '../api';
import { CopyButton, Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export default function DjsPage() {
  const { station } = useOutletContext<StationCtx>();
  const { confirm, toast } = useUi();
  const [djs, setDjs] = useState<Dj[] | null>(null);
  const [recs, setRecs] = useState<Recording[]>([]);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [sched, setSched] = useState<Dj | null>(null);
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
      setCreating(false);
      toast('DJ criado');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function update(d: Dj, change: Partial<Pick<Dj, 'enabled' | 'scheduleEnabled' | 'startTime' | 'endTime' | 'days'>> & { resetPassword?: boolean }, ok = 'Salvo') {
    try {
      await api(`${base}/djs/${d.id}`, { method: 'PUT', body: change });
      toast(ok);
      load();
      return true;
    } catch (err) {
      toast((err as Error).message, 'error');
      return false;
    }
  }

  async function newPassword(d: Dj) {
    if (!(await confirm({ title: 'Gerar nova senha?', message: `A senha atual de "${d.username}" deixa de funcionar e a transmissão reinicia se ele estiver no ar.`, confirmLabel: 'Gerar nova senha' }))) return;
    update(d, { resetPassword: true }, 'Nova senha gerada');
  }

  async function remove(d: Dj) {
    if (!(await confirm({ title: 'Excluir DJ?', message: `O acesso de "${d.username}" será removido.`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/djs/${d.id}`, { method: 'DELETE' });
    toast('DJ excluído');
    load();
  }

  async function removeRec(r: Recording) {
    if (!(await confirm({ title: 'Excluir gravação?', message: r.name, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/recordings/${encodeURIComponent(r.name)}`, { method: 'DELETE' });
    toast('Gravação excluída');
    load();
  }

  if (!station.liveEnabled)
    return (
      <div className="card">
        <Empty icon="mic" title="Transmissão ao vivo desativada" text="Ative “Permitir DJ ao vivo” nas Configurações para criar DJs." />
      </div>
    );

  return (
    <>
      <div className="section-title">
        <h3>DJs ao vivo <span className="muted">({djs?.length ?? 0})</span></h3>
        <button onClick={() => setCreating(true)}><Icon name="plus" /> Novo DJ</button>
      </div>

      {station.dj && (
        <div className="card notice">
          Conecte no software de transmissão (BUTT, Mixxx, OBS) em <code>{station.dj.host}</code> porta <code>{station.dj.port}</code>, mountpoint <code>{station.dj.mount}</code>, com o usuário e a senha do DJ.
        </div>
      )}

      <div className="card tight">
        {djs === null ? (
          <div className="skeleton" style={{ height: 100, margin: 20, borderRadius: 12 }} />
        ) : djs.length === 0 ? (
          <Empty icon="mic" title="Nenhum DJ ainda" text="Enquanto isso, o usuário source com a senha da estação continua funcionando." action={<button onClick={() => setCreating(true)}><Icon name="plus" /> Criar DJ</button>} />
        ) : (
          <table>
            <thead><tr><th>DJ</th><th className="hide-sm">Senha</th><th>Horário</th><th /></tr></thead>
            <tbody>
              {djs.map((d) => (
                <tr key={d.id}>
                  <td>
                    <span className="avatar-sm">{(d.displayName || d.username).charAt(0).toUpperCase()}</span>
                    <strong>{d.displayName || d.username}</strong>
                    <span className="muted"> @{d.username}</span> {!d.enabled && <span className="badge off">desativado</span>}
                  </td>
                  <td className="hide-sm"><code>{d.password}</code> <CopyButton text={d.password} label="" /></td>
                  <td className="muted">
                    {d.scheduleEnabled ? `${d.startTime}–${d.endTime} · ${d.days.length === 7 ? 'todos os dias' : d.days.map((x) => DAYS[x]).join(', ')}` : 'Sempre liberado'}
                  </td>
                  <td>
                    <div className="table-actions">
                      <button className="ghost small" onClick={() => setSched(d)}><Icon name="clock" size={13} /> Horário</button>
                      <button className="ghost small" onClick={() => update(d, { enabled: !d.enabled }, d.enabled ? 'DJ desativado' : 'DJ ativado')}>{d.enabled ? 'Desativar' : 'Ativar'}</button>
                      <button className="ghost small" onClick={() => newPassword(d)}><Icon name="key" size={13} /> Nova senha</button>
                      <button className="icon-btn" title="Excluir" onClick={() => remove(d)}><Icon name="trash" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section-title" style={{ marginTop: 28 }}><h3>Gravações <span className="muted">({recs.length})</span></h3></div>
      {!station.recordLive && <p className="muted" style={{ marginTop: -4 }}>A gravação está desligada. Ative em Configurações.</p>}
      <div className="card tight">
        {recs.length === 0 ? (
          <Empty icon="mic" title="Sem gravações" text="As transmissões ao vivo gravadas aparecem aqui para baixar ou virar episódio de podcast." />
        ) : (
          <table>
            <tbody>
              {recs.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="muted hide-sm">{mb(r.size)}</td>
                  <td className="muted hide-sm">{new Date(r.modifiedAt).toLocaleString()}</td>
                  <td>
                    <div className="table-actions">
                      <button className="ghost small" onClick={() => downloadFile(`${base}/recordings/${encodeURIComponent(r.name)}`, r.name).catch((e) => toast((e as Error).message, 'error'))}><Icon name="download" size={13} /> Baixar</button>
                      <button className="icon-btn" title="Excluir" onClick={() => removeRec(r)}><Icon name="trash" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={creating}
        size="sm"
        title="Novo DJ"
        onClose={() => setCreating(false)}
        footer={<><button className="ghost" type="button" onClick={() => setCreating(false)}>Cancelar</button><button form="new-dj">Criar DJ</button></>}
      >
        <form id="new-dj" className="fields" onSubmit={create}>
          <label className="field"><span>Usuário de login</span><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="maria" required /><small className="hint">3 a 32 caracteres: letras, números, _ . -</small></label>
          <label className="field"><span>Nome de exibição <em className="hint">(opcional)</em></span><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="DJ Maria" /><small className="hint">É o que os ouvintes veem quando o DJ está ao vivo.</small></label>
          {error && <p className="error">{error}</p>}
        </form>
      </Modal>

      <Modal
        open={!!sched}
        title={sched ? `Horário de ${sched.displayName || sched.username}` : ''}
        onClose={() => setSched(null)}
        footer={
          <>
            <button className="ghost" type="button" onClick={() => setSched(null)}>Cancelar</button>
            <button
              type="button"
              onClick={async () => {
                if (sched && (await update(sched, { scheduleEnabled: sched.scheduleEnabled, startTime: sched.startTime, endTime: sched.endTime, days: sched.days }, 'Horário salvo'))) setSched(null);
              }}
            >
              Salvar horário
            </button>
          </>
        }
      >
        {sched && (
          <div className="fields">
            <label className="check-line">
              <input type="checkbox" checked={sched.scheduleEnabled} onChange={(e) => setSched({ ...sched, scheduleEnabled: e.target.checked })} />
              <span>Limitar a um horário <small>Fora da janela, a conexão do DJ é recusada.</small></span>
            </label>
            {sched.scheduleEnabled && (
              <>
                <div className="field-row">
                  <label className="field"><span>Das</span><input type="time" value={sched.startTime} onChange={(e) => setSched({ ...sched, startTime: e.target.value })} /></label>
                  <label className="field"><span>Às</span><input type="time" value={sched.endTime} onChange={(e) => setSched({ ...sched, endTime: e.target.value })} /></label>
                </div>
                <div className="chips">
                  {DAYS.map((name, i) => (
                    <label className="chip" key={i}>
                      <input type="checkbox" checked={sched.days.includes(i)} onChange={(e) => setSched({ ...sched, days: e.target.checked ? [...sched.days, i] : sched.days.filter((x) => x !== i) })} />
                      {name}
                    </label>
                  ))}
                </div>
              </>
            )}
            <p className="muted small-text">O horário é o do servidor (UTC no Docker). Quem já está no ar não é derrubado quando a janela termina.</p>
          </div>
        )}
      </Modal>
    </>
  );
}
