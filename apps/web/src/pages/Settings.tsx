import { useState, type FormEvent } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api, type MountCfg } from '../api';
import { useAuth } from '../auth';
import type { StationCtx } from './StationLayout';

export default function Settings() {
  const { station, reload } = useOutletContext<StationCtx>();
  const { user } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({
    name: station.name,
    description: station.description,
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
  const [msg, setMsg] = useState('');
  const isAdmin = user?.role === 'admin';
  const setMount = (i: number, change: Partial<MountCfg>) =>
    setF((cur) => ({ ...cur, mounts: cur.mounts.map((m, j) => (j === i ? { ...m, ...change } : m)) }));

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/stations/${station.id}`, { method: 'PUT', body: f });
      await reload();
      setMsg('Salvo.');
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Excluir a estação "${station.name}" e TODA a biblioteca dela? Isso não pode ser desfeito.`)) return;
    await api(`/api/stations/${station.id}`, { method: 'DELETE' });
    nav('/');
  }

  return (
    <form className="card form" onSubmit={save}>
      <label>Nome<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!isAdmin} required /></label>
      <label>Descrição<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} disabled={!isAdmin} /></label>
      <div className="row">
        <label>Formato
          <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as 'mp3' | 'ogg' })} disabled={!isAdmin}>
            <option value="mp3">MP3</option><option value="ogg">OGG Vorbis</option>
          </select>
        </label>
        <label>Bitrate (kbps)
          <select value={f.bitrate} onChange={(e) => setF({ ...f, bitrate: Number(e.target.value) })} disabled={!isAdmin}>
            {[64, 96, 128, 192, 256, 320].map((b) => <option key={b}>{b}</option>)}
          </select>
        </label>
      </div>
      <label>Crossfade entre músicas: {f.crossfadeSeconds === 0 ? 'desligado' : `${f.crossfadeSeconds}s`}
        <input type="range" min={0} max={10} step={0.5} value={f.crossfadeSeconds} onChange={(e) => setF({ ...f, crossfadeSeconds: Number(e.target.value) })} disabled={!isAdmin} />
      </label>
      <label className="check"><input type="checkbox" checked={f.normalize} onChange={(e) => setF({ ...f, normalize: e.target.checked })} disabled={!isAdmin} /> Normalizar volume (ReplayGain; usa as tags dos arquivos)</label>

      <h3>Streams extras</h3>
      <p className="muted">Além de <code>/radio</code>, publique outros mountpoints com qualidade diferente (máx. 4).</p>
      {f.mounts.map((m, i) => (
        <div className="row" key={i}>
          <input value={m.mount} placeholder="/radio-hd" onChange={(e) => setMount(i, { mount: e.target.value })} disabled={!isAdmin} />
          <select value={m.format} onChange={(e) => setMount(i, { format: e.target.value as 'mp3' | 'ogg' })} disabled={!isAdmin}>
            <option value="mp3">MP3</option><option value="ogg">OGG Vorbis</option>
          </select>
          <select value={m.bitrate} onChange={(e) => setMount(i, { bitrate: Number(e.target.value) })} disabled={!isAdmin}>
            {[32, 48, 64, 96, 128, 192, 256, 320].map((b) => <option key={b}>{b}</option>)}
          </select>
          {isAdmin && <button type="button" className="danger small" onClick={() => setF({ ...f, mounts: f.mounts.filter((_, j) => j !== i) })}>Remover</button>}
        </div>
      ))}
      {isAdmin && f.mounts.length < 4 && (
        <button type="button" className="ghost" onClick={() => setF({ ...f, mounts: [...f.mounts, { mount: '/radio-extra', format: 'mp3', bitrate: 64 }] })}>+ Adicionar stream</button>
      )}

      <label className="check"><input type="checkbox" checked={f.liveEnabled} onChange={(e) => setF({ ...f, liveEnabled: e.target.checked })} disabled={!isAdmin} /> Permitir DJ ao vivo</label>
      <label className="check"><input type="checkbox" checked={f.recordLive} onChange={(e) => setF({ ...f, recordLive: e.target.checked })} disabled={!isAdmin || !f.liveEnabled} /> Gravar as transmissões ao vivo dos DJs</label>
      <label className="check"><input type="checkbox" checked={f.requestsEnabled} onChange={(e) => setF({ ...f, requestsEnabled: e.target.checked })} disabled={!isAdmin} /> Permitir pedidos de músicas</label>
      <label className="check"><input type="checkbox" checked={f.autostart} onChange={(e) => setF({ ...f, autostart: e.target.checked })} disabled={!isAdmin} /> Iniciar automaticamente com o servidor</label>
      {isAdmin && (
        <div className="row">
          <button>Salvar (reinicia a estação se estiver no ar)</button>
          <button type="button" className="danger" onClick={remove}>Excluir estação</button>
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
    </form>
  );
}
