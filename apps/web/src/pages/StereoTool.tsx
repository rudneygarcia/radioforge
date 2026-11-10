import { useCallback, useEffect, useState } from 'react';
import { api, uploadForm } from '../api';
import { Icon, useUi } from '../ui';

interface Lib {
  present: boolean;
  size: number;
  updatedAt: string | null;
}

/** Stereo Tool: biblioteca do servidor (.so), preset (.sts) por estação e chave de licença. */
export default function StereoTool({
  stationId,
  isAdmin,
  enabled,
  preset,
  onEnabled,
  onPreset,
}: {
  stationId: number;
  isAdmin: boolean;
  enabled: boolean;
  preset: string;
  onEnabled: (v: boolean) => void;
  onPreset: (v: string) => void;
}) {
  const { toast, confirm } = useUi();
  const [lib, setLib] = useState<Lib | null>(null);
  const [presets, setPresets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState('');
  const [keySet, setKeySet] = useState(false);

  const load = useCallback(() => {
    api<{ library: Lib; keySet: boolean }>('/api/stereotool').then((r) => { setLib(r.library); setKeySet(r.keySet); }).catch(() => {});
    api<{ presets: string[] }>(`/api/stations/${stationId}/stereotool/presets`).then((r) => setPresets(r.presets)).catch(() => {});
  }, [stationId]);
  useEffect(load, [load]);

  async function send(path: string, file: File | undefined, done: string) {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await uploadForm(path, form).promise;
      toast(done);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(k: string) {
    setBusy(true);
    try {
      await api('/api/stereotool/license', { method: 'PUT', body: { key: k } });
      setKey('');
      toast(k ? 'Chave salva' : 'Chave removida');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeLib() {
    if (!(await confirm({ title: 'Remover a biblioteca do Stereo Tool?', message: 'As estações que usam o Stereo Tool voltam para o processador interno ao reiniciar.', confirmLabel: 'Remover', danger: true }))) return;
    await api('/api/stereotool/library', { method: 'DELETE' });
    load();
  }

  async function removePreset(name: string) {
    if (!(await confirm({ title: `Excluir o preset “${name}”?`, confirmLabel: 'Excluir', danger: true }))) return;
    await api(`/api/stations/${stationId}/stereotool/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (preset === name) onPreset('');
    load();
  }

  return (
    <div className="fields">
      <p className="muted" style={{ marginTop: -4 }}>
        O <strong>Stereo Tool</strong> é um processador de áudio profissional <strong>pago</strong>: você usa a sua própria licença, uma só para todas as estações. Envie o <strong>ZIP do plugin para Liquidsoap</strong> baixado do site do Stereo Tool (“x86/64 Linux libStereoTool plugin”) uma vez para o servidor: o painel acha a biblioteca Linux 64 bits dentro dele (um <code>.so</code> solto também serve), e o preset (<code>.sts</code>) de cada estação. Ligado, ele substitui o
        processador interno. Ele usa bastante CPU: ligue só nas estações que precisam.
      </p>

      <div className="card" style={{ padding: 14 }}>
        <strong>1. Biblioteca e licença (do servidor, valem para todas as estações)</strong>
        <p className="muted small-text" style={{ margin: '4px 0 8px' }}>
          {lib === null ? 'Verificando…' : lib.present ? `Enviada (${(lib.size / 1024 / 1024).toFixed(1)} MB).` : 'Ainda não enviada.'}
        </p>
        {isAdmin && (
          <div className="row" style={{ margin: 0 }}>
            <label className="button ghost small">
              {busy ? 'Enviando…' : lib?.present ? 'Trocar biblioteca' : 'Enviar o ZIP do plugin'}
              <input type="file" hidden accept=".zip,.so" disabled={busy} onChange={(e) => send('/api/stereotool/library', e.target.files?.[0], 'Biblioteca enviada')} />
            </label>
            {lib?.present && <button type="button" className="ghost small" onClick={removeLib}><Icon name="trash" size={13} /> Remover</button>}
          </div>
        )}
        <label className="field" style={{ marginTop: 12 }}>
          <span>Chave de licença {keySet && <em className="hint">(já salva)</em>}</span>
          <div className="row" style={{ margin: 0 }}>
            <input type="password" autoComplete="off" value={key} placeholder={keySet ? '•••••••• (digite para trocar)' : 'Cole a chave da sua licença'} onChange={(e) => setKey(e.target.value)} disabled={!isAdmin} style={{ flex: 1, minWidth: 180 }} />
            {isAdmin && <button type="button" className="small" disabled={busy || !key.trim()} onClick={() => saveKey(key)}>Salvar chave</button>}
            {isAdmin && keySet && <button type="button" className="ghost small" onClick={() => saveKey('')}>Remover</button>}
          </div>
          <small className="hint">Uma só chave para o servidor inteiro (vale para todas as estações); fica só no servidor e nunca é exibida de volta. Sem licença válida o Stereo Tool roda limitado. Vale ao reiniciar as estações.</small>
        </label>
      </div>

      <label className="check-line" style={{ opacity: isAdmin ? 1 : 0.55 }}>
        <input type="checkbox" checked={enabled} disabled={!isAdmin} onChange={(e) => onEnabled(e.target.checked)} />
        <span>Usar o Stereo Tool nesta estação<small>Vale ao salvar (a estação reinicia). Se o Liquidsoap não carregar a biblioteca, a rádio sobe com o processador interno e o painel avisa.</small></span>
      </label>

      <div className="card" style={{ padding: 14 }}>
        <strong>2. Preset desta estação (cada rádio tem o seu som)</strong>
        {presets.length === 0 && <p className="muted small-text" style={{ margin: '4px 0 8px' }}>Nenhum preset enviado.</p>}
        {presets.map((p) => (
          <div key={p} className="req-item" style={{ margin: '8px 0 0' }}>
            <label className="check-line" style={{ flex: 1, minWidth: 0 }}>
              <input type="radio" name="stereo-preset" checked={preset === p} disabled={!isAdmin} onChange={() => onPreset(p)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{p}</span>
            </label>
            {isAdmin && <button type="button" className="icon-btn" title="Excluir preset" onClick={() => removePreset(p)}><Icon name="trash" /></button>}
          </div>
        ))}
        {isAdmin && (
          <div className="row" style={{ margin: '10px 0 0' }}>
            <label className="button ghost small">
              {busy ? 'Enviando…' : 'Enviar preset (.sts)'}
              <input type="file" hidden accept=".sts,.ini" disabled={busy} onChange={(e) => send(`/api/stations/${stationId}/stereotool/presets`, e.target.files?.[0], 'Preset enviado')} />
            </label>
            {preset && <button type="button" className="ghost small" onClick={() => onPreset('')}>Sem preset</button>}
          </div>
        )}
        <small className="hint" style={{ display: 'block', marginTop: 8 }}>Escolha qual preset usar e salve as configurações.</small>
      </div>
    </div>
  );
}
