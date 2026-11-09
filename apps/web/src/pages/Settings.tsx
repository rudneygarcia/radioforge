import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api, type MountCfg } from '../api';
import { useAuth } from '../auth';
import { Icon, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

function Toggle({ checked, onChange, disabled, title, hint }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title: string; hint?: ReactNode }) {
  return (
    <label className="check-line" style={{ opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{title}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

export default function Settings() {
  const { station, reload } = useOutletContext<StationCtx>();
  const { user } = useAuth();
  const { confirm, toast } = useUi();
  const nav = useNavigate();
  const [f, setF] = useState({
    name: station.name,
    description: station.description,
    mount: station.mount,
    format: station.format,
    bitrate: station.bitrate,
    liveEnabled: station.liveEnabled,
    requestsEnabled: station.requestsEnabled,
    autostart: station.autostart,
    crossfadeSeconds: station.crossfadeSeconds,
    normalize: station.normalize,
    recordLive: station.recordLive,
    mounts: station.mounts,
  });
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';
  const setMount = (i: number, change: Partial<MountCfg>) =>
    setF((cur) => ({ ...cur, mounts: cur.mounts.map((m, j) => (j === i ? { ...m, ...change } : m)) }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/stations/${station.id}`, { method: 'PUT', body: f });
      await reload();
      toast('Configurações salvas');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirm({ title: 'Excluir estação?', message: `"${station.name}" e TODA a biblioteca dela serão apagadas. Isso não pode ser desfeito.`, confirmLabel: 'Excluir estação', danger: true }))) return;
    await api(`/api/stations/${station.id}`, { method: 'DELETE' });
    toast('Estação excluída');
    nav('/');
  }

  return (
    <form onSubmit={save}>
      {!isAdmin && <div className="card notice">Só administradores podem alterar as configurações.</div>}

      <div className="card section">
        <div className="section-title"><h3>Geral</h3></div>
        <div className="fields">
          <label className="field"><span>Nome</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!isAdmin} required /></label>
          <label className="field"><span>Descrição</span><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} disabled={!isAdmin} /></label>
          <label className="field">
            <span>Nome do stream <em className="hint">(endereço de escuta)</em></span>
            <div className="input-prefix">
              <span>{station.streams[0] ? new URL(station.streams[0].url).host : location.host}/</span>
              <input
                value={f.mount.replace(/^\//, '')}
                onChange={(e) => setF({ ...f, mount: e.target.value.replace(/[^a-zA-Z0-9._-]/g, '') })}
                disabled={!isAdmin}
                placeholder="radio.mp3"
                maxLength={40}
                required
              />
            </div>
            <small className="hint">Letras, números, ponto, hífen e sublinhado. Ex.: radio.mp3. Quem já usa o endereço antigo precisa trocar para o novo.</small>
          </label>
          <Toggle checked={f.autostart} onChange={(v) => setF({ ...f, autostart: v })} disabled={!isAdmin} title="Iniciar automaticamente com o servidor" />
        </div>
      </div>

      <div className="card section">
        <div className="section-title"><h3>Qualidade do áudio</h3></div>
        <div className="fields">
          <div className="field-row">
            <label className="field">
              <span>Formato</span>
              <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as 'mp3' | 'ogg' })} disabled={!isAdmin}>
                <option value="mp3">MP3</option><option value="ogg">OGG Vorbis</option>
              </select>
            </label>
            <label className="field">
              <span>Bitrate (kbps)</span>
              <select value={f.bitrate} onChange={(e) => setF({ ...f, bitrate: Number(e.target.value) })} disabled={!isAdmin}>
                {[64, 96, 128, 192, 256, 320].map((b) => <option key={b}>{b}</option>)}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Crossfade entre músicas: {f.crossfadeSeconds === 0 ? 'desligado' : `${f.crossfadeSeconds}s`}</span>
            <input type="range" min={0} max={10} step={0.5} value={f.crossfadeSeconds} onChange={(e) => setF({ ...f, crossfadeSeconds: Number(e.target.value) })} disabled={!isAdmin} style={{ padding: 0 }} />
          </label>
          <Toggle checked={f.normalize} onChange={(v) => setF({ ...f, normalize: v })} disabled={!isAdmin} title="Normalizar volume" hint="ReplayGain: usa as tags dos arquivos." />
        </div>
      </div>

      <div className="card section">
        <div className="section-title">
          <h3>Streams extras</h3>
          {isAdmin && f.mounts.length < 4 && (
            <button type="button" className="ghost small" onClick={() => setF({ ...f, mounts: [...f.mounts, { mount: '/radio-extra', format: 'mp3', bitrate: 64 }] })}><Icon name="plus" size={13} /> Adicionar</button>
          )}
        </div>
        <p className="muted" style={{ marginTop: -4 }}>Além de <code>/radio</code>, publique outros mountpoints com qualidade diferente (máx. 4).</p>
        {f.mounts.length === 0 && <p className="muted small-text">Nenhum stream extra.</p>}
        {f.mounts.map((m, i) => (
          <div className="row" key={i}>
            <input value={m.mount} placeholder="/radio-hd" onChange={(e) => setMount(i, { mount: e.target.value })} disabled={!isAdmin} style={{ flex: 1, minWidth: 140 }} />
            <select value={m.format} onChange={(e) => setMount(i, { format: e.target.value as 'mp3' | 'ogg' })} disabled={!isAdmin}>
              <option value="mp3">MP3</option><option value="ogg">OGG Vorbis</option>
            </select>
            <select value={m.bitrate} onChange={(e) => setMount(i, { bitrate: Number(e.target.value) })} disabled={!isAdmin}>
              {[32, 48, 64, 96, 128, 192, 256, 320].map((b) => <option key={b}>{b}</option>)}
            </select>
            {isAdmin && <button type="button" className="icon-btn" title="Remover" onClick={() => setF({ ...f, mounts: f.mounts.filter((_, j) => j !== i) })}><Icon name="trash" /></button>}
          </div>
        ))}
      </div>

      <div className="card section">
        <div className="section-title"><h3>Recursos</h3></div>
        <div className="fields">
          <Toggle checked={f.liveEnabled} onChange={(v) => setF({ ...f, liveEnabled: v })} disabled={!isAdmin} title="Permitir DJ ao vivo" />
          <Toggle checked={f.recordLive} onChange={(v) => setF({ ...f, recordLive: v })} disabled={!isAdmin || !f.liveEnabled} title="Gravar as transmissões ao vivo" hint="Salva cada transmissão de DJ para baixar depois." />
          <Toggle checked={f.requestsEnabled} onChange={(v) => setF({ ...f, requestsEnabled: v })} disabled={!isAdmin} title="Permitir pedidos de músicas" hint="Ouvintes podem pedir faixas pelo player público." />
        </div>
      </div>

      {isAdmin && (
        <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 22px' }}>
          <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar alterações'}</button>
          <span className="muted small-text">Reinicia a estação se estiver no ar.</span>
        </div>
      )}

      {isAdmin && (
        <div className="card danger-zone">
          <h3>Zona de perigo</h3>
          <p className="muted">Excluir a estação apaga a biblioteca, as playlists e o histórico dela.</p>
          <button type="button" className="danger" onClick={remove}><Icon name="trash" /> Excluir estação</button>
        </div>
      )}
    </form>
  );
}
