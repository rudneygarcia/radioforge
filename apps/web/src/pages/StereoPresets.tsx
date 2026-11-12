import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, uploadForm } from '../api';
import { useCan } from '../auth';
import { Icon, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

interface PresetInfo {
  presets: string[];
  active: string;
  enabled: boolean;
}
interface Lib {
  library: { present: boolean };
  keySet: boolean;
}

/** Preset do Stereo Tool desta estação. A licença, a biblioteca e ligar/desligar o Stereo Tool ficam com o administrador (Configurações). */
export default function StereoPresets() {
  const { station } = useOutletContext<StationCtx>();
  const can = useCan();
  const canEdit = can('stereo');
  const { toast, confirm } = useUi();
  const [info, setInfo] = useState<PresetInfo | null>(null);
  const [lib, setLib] = useState<Lib | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const base = `/api/stations/${station.id}/stereotool`;

  const load = useCallback(() => {
    api<PresetInfo>(`${base}/presets`).then(setInfo).catch((e) => toast((e as Error).message, 'error'));
    api<Lib>('/api/stereotool').then(setLib).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(load, [load]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setPct(0);
    try {
      const form = new FormData();
      form.append('file', file);
      await uploadForm(`${base}/presets`, form, (loaded, total) => setPct(Math.round((loaded / total) * 100))).promise;
      toast('Preset enviado');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      setPct(null);
    }
  }

  async function choose(name: string) {
    try {
      const r = await api<{ needsRestart: boolean }>(`${base}/active`, { method: 'PUT', body: { preset: name } });
      setPendingRestart(r.needsRestart);
      toast(name ? 'Preset escolhido' : 'Nenhum preset em uso');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function remove(name: string) {
    if (!(await confirm({ title: `Excluir o preset “${name}”?`, confirmLabel: 'Excluir', danger: true }))) return;
    try {
      await api(`${base}/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast('Preset excluído');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  if (!info) return <div className="card skeleton" style={{ height: 160 }} />;

  const ready = info.enabled && !!lib?.library.present && lib.keySet;
  return (
    <div className="card section">
      <div className="section-title">
        <h3>Stereo Tool</h3>
        <span className={`badge ${info.enabled ? 'on' : 'off'}`}>{info.enabled ? 'ligado' : 'desligado'}</span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        O preset (arquivo <code>.sts</code>) é o “som” da sua rádio no Stereo Tool. Envie o seu e escolha qual usar. A licença, a biblioteca e ligar ou desligar o Stereo Tool nesta estação são feitos pelo administrador.
      </p>
      {!info.enabled && <div className="card notice">O Stereo Tool está <strong>desligado</strong> nesta estação. Você já pode enviar e escolher o preset; ele passa a valer quando o administrador ligar.</div>}
      {info.enabled && !ready && <div className="card notice">O administrador ligou o Stereo Tool, mas ainda falta a biblioteca ou a licença no servidor. Enquanto isso a rádio usa o processador interno.</div>}
      {pendingRestart && <div className="card notice">Preset salvo. Ele passa a valer quando a rádio for reiniciada (peça ao administrador ou use “Reiniciar” no Painel, se tiver permissão).</div>}
      {!canEdit && <div className="card notice">Você não tem permissão para trocar o preset.</div>}

      <div className="fields">
        {info.presets.length === 0 && <p className="muted small-text" style={{ margin: 0 }}>Nenhum preset enviado ainda.</p>}
        {info.presets.map((p) => (
          <div key={p} className="req-item" style={{ margin: 0 }}>
            <label className="check-line" style={{ flex: 1, minWidth: 0 }}>
              <input type="radio" name="stereo-preset" checked={info.active === p} disabled={!canEdit} onChange={() => choose(p)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p}{info.active === p && <small>Em uso nesta estação</small>}</span>
            </label>
            {canEdit && <button type="button" className="icon-btn" title="Excluir preset" onClick={() => remove(p)}><Icon name="trash" /></button>}
          </div>
        ))}
        {canEdit && (
          <div className="row" style={{ margin: 0 }}>
            <label className="button">
              <Icon name="upload" /> {busy ? (pct !== null ? `Enviando… ${pct}%` : 'Enviando…') : 'Enviar preset (.sts)'}
              <input type="file" hidden accept=".sts,.ini" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }} />
            </label>
            {info.active && <button type="button" className="ghost" onClick={() => choose('')}>Não usar preset</button>}
          </div>
        )}
      </div>
    </div>
  );
}
