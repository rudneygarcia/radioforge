import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api, getToken, uploadForm, type MountCfg, type Station } from '../api';
import { useAuth } from '../auth';
import { Cover, Icon, useUi } from '../ui';
import TimeClips from './TimeClips';
import type { StationCtx } from './StationLayout';

const TIMEZONES = ['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Rio_Branco', 'America/Noronha', 'Europe/Lisbon', 'America/New_York', 'UTC'];

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
    audioPreset: station.audioPreset,
    audioGain: station.audioGain,
    noRepeatMinutes: station.noRepeatMinutes,
    liveTimeout: station.liveTimeout,
    liveContinue: station.liveContinue,
    timeAnnounce: station.timeAnnounce,
    timeAnnounceVoice: station.timeAnnounceVoice,
    timezone: station.timezone,
    historyLimit: station.historyLimit,
    liveEnabled: station.liveEnabled,
    requestsEnabled: station.requestsEnabled,
    autostart: station.autostart,
    crossfadeSeconds: station.crossfadeSeconds,
    normalize: station.normalize,
    recordLive: station.recordLive,
    mounts: station.mounts,
  });
  const [busy, setBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
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

  async function sendCover(file?: File) {
    if (!file) return;
    setCoverBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await uploadForm<Station>(`/api/stations/${station.id}/cover`, form).promise;
      await reload();
      toast('Capa da rádio atualizada');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setCoverBusy(false);
    }
  }

  async function previewTime() {
    try {
      const token = getToken();
      const res = await fetch(`/api/stations/${station.id}/time-announce/preview`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Erro ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function announceNowClick() {
    try {
      const r = await api<{ text: string }>(`/api/stations/${station.id}/time-announce/now`, { method: 'POST' });
      toast(`Na fila: “${r.text}” (toca ao fim da música atual)`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function removeCover() {
    if (!(await confirm({ title: 'Remover a capa da rádio?', message: 'Músicas sem capa voltam a mostrar o ícone padrão.', confirmLabel: 'Remover', danger: true }))) return;
    setCoverBusy(true);
    try {
      await api(`/api/stations/${station.id}/cover`, { method: 'DELETE' });
      await reload();
      toast('Capa removida');
    } finally {
      setCoverBusy(false);
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
        <div className="section-title"><h3>Capa da rádio</h3></div>
        <p className="muted" style={{ marginTop: -4 }}>Logo ou imagem da estação. Aparece no player e nos históricos <strong>no lugar da capa das músicas que não têm</strong>, e também quando nada está tocando.</p>
        <div className="row" style={{ alignItems: 'center', gap: 16 }}>
          <Cover url={station.coverUrl} size={96} />
          {isAdmin ? (
            <div className="row" style={{ margin: 0 }}>
              <label className="button">
                {coverBusy ? 'Enviando…' : station.coverUrl ? 'Trocar capa' : 'Enviar capa'}
                <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" disabled={coverBusy} onChange={(e) => sendCover(e.target.files?.[0])} />
              </label>
              {station.coverUrl && <button type="button" className="ghost" onClick={removeCover} disabled={coverBusy}><Icon name="trash" /> Remover</button>}
            </div>
          ) : null}
        </div>
        <p className="muted small-text" style={{ marginBottom: 0 }}>PNG, JPG, WEBP ou GIF, até 4 MB. Quadrada (ex.: 600×600) fica melhor.</p>
      </div>

      <div className="card section">
        <div className="section-title"><h3>Qualidade do áudio</h3></div>
        <div className="fields">
          <div className="field-row">
            <label className="field">
              <span>Formato</span>
              <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as 'mp3' | 'ogg' | 'aac' })} disabled={!isAdmin}>
                <option value="mp3">MP3</option><option value="aac">AAC</option><option value="ogg">OGG Vorbis</option>
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
        <div className="section-title"><h3>Hora certa</h3></div>
        <p className="muted" style={{ marginTop: -4 }}>O AutoDJ avisa a hora usando os <strong>seus arquivos de áudio</strong> (um por horário, enviados abaixo) ou, se faltar, a voz sintética (ex.: “Hora certa. São catorze horas e meia.”). O aviso entra na fila e toca <strong>ao fim da música atual</strong>; não aparece em “Tocando agora” nem no histórico, e não toca enquanto há DJ ao vivo.</p>
        <div className="fields">
          <div className="field-row">
            <label className="field">
              <span>Avisar a hora</span>
              <select value={f.timeAnnounce} onChange={(e) => setF({ ...f, timeAnnounce: Number(e.target.value) as typeof f.timeAnnounce })} disabled={!isAdmin}>
                <option value={0}>Desligada</option>
                <option value={60}>A cada hora (:00)</option>
                <option value={30}>A cada 30 minutos</option>
                <option value={15}>A cada 15 minutos</option>
              </select>
            </label>
            <label className="field">
              <span>Fuso horário</span>
              <select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} disabled={!isAdmin}>
                {TIMEZONES.includes(f.timezone) ? null : <option value={f.timezone}>{f.timezone}</option>}
                {TIMEZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </label>
          </div>
          <div className="row" style={{ margin: 0 }}>
            <button type="button" className="ghost small" onClick={previewTime} disabled={coverBusy}><Icon name="play" size={13} /> Ouvir exemplo (hora atual)</button>
            {isAdmin && station.running && <button type="button" className="ghost small" onClick={announceNowClick}><Icon name="mic" size={13} /> Tocar agora na rádio</button>}
          </div>
          <Toggle checked={f.timeAnnounceVoice} onChange={(v) => setF({ ...f, timeAnnounceVoice: v })} disabled={!isAdmin} title="Usar a voz sintética quando não houver arquivo para o horário" hint="Desligue se você enviar os seus próprios áudios: nos horários sem arquivo a rádio simplesmente não avisa." />
          <small className="hint">Salve as configurações para valer a mudança. Só funciona no modo completo. A hora usa o fuso escolhido acima (o servidor costuma estar em UTC).</small>
        </div>
        <TimeClips station={{ ...station, timeAnnounce: f.timeAnnounce }} isAdmin={isAdmin} voiceFallback={f.timeAnnounceVoice} />
      </div>

      <div className="card section">
        <div className="section-title"><h3>Processador de áudio</h3></div>
        <p className="muted" style={{ marginTop: -4 }}>Nivela o volume entre músicas e DJ, deixa o som mais alto e cheio e evita estouros (distorção), no estilo de rádio FM.</p>
        {station.audioWarning && <div className="card notice" style={{ whiteSpace: 'pre-wrap' }}><strong>Atenção:</strong> {station.audioWarning}</div>}
        <div className="fields">
          <label className="field">
            <span>Predefinição</span>
            <select value={f.audioPreset} onChange={(e) => setF({ ...f, audioPreset: e.target.value as typeof f.audioPreset })} disabled={!isAdmin}>
              <option value="off">Desligado (áudio original, sem nivelar)</option>
              <option value="balanced">Equilibrado (normaliza + compressão + limitador) — recomendado</option>
              <option value="loud">Forte, estilo FM (normaliza + compressão firme + limitador)</option>
            </select>
            <small className="hint">Só no modo completo (Icecast + Liquidsoap). O limitador no final impede a distorção mesmo com o volume alto.</small>
          </label>
          <label className="field">
            <span>Volume extra: {f.audioGain === 0 ? 'sem ganho' : `+${f.audioGain} dB`}</span>
            <input type="range" min={0} max={12} step={1} value={f.audioGain} onChange={(e) => setF({ ...f, audioGain: Number(e.target.value) })} disabled={!isAdmin} style={{ padding: 0 }} />
            <small className="hint">Se ainda estiver baixo, suba de 2 em 2 dB. Acima de uns +8 dB o som pode ficar “espremido”; o limitador evita o estouro, mas escute antes de deixar fixo.</small>
          </label>
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
            <select value={m.format} onChange={(e) => setMount(i, { format: e.target.value as 'mp3' | 'ogg' | 'aac' })} disabled={!isAdmin}>
              <option value="mp3">MP3</option><option value="aac">AAC</option><option value="ogg">OGG Vorbis</option>
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
          <label className="field" style={{ maxWidth: 340 }}>
            <span>AutoDJ volta após (segundos sem sinal do encoder)</span>
            <input type="number" min={3} max={60} value={f.liveTimeout} onChange={(e) => setF({ ...f, liveTimeout: Math.max(3, Math.min(60, Number(e.target.value) || 8)) })} disabled={!isAdmin || !f.liveEnabled} />
            <small className="hint">Se o encoder cair (ex.: internet cortou), o AutoDJ assume depois desse tempo. Menor = volta mais rápido, mas uma oscilação curta já derruba o ao vivo. Padrão: 8 s.</small>
          </label>
          <Toggle checked={f.liveContinue} onChange={(v) => setF({ ...f, liveContinue: v })} disabled={!isAdmin || !f.liveEnabled} title="AutoDJ continua a música ao voltar do ao vivo" hint="Durante o DJ, o AutoDJ segue tocando mudo; quando o encoder cai, a música que estiver tocando continua (em vez de começar outra). Enquanto o DJ está no ar, pedidos de ouvintes ficam indisponíveis." />
          <Toggle checked={f.recordLive} onChange={(v) => setF({ ...f, recordLive: v })} disabled={!isAdmin || !f.liveEnabled} title="Gravar as transmissões ao vivo" hint="Salva cada transmissão de DJ para baixar depois." />
          <label className="field" style={{ maxWidth: 340 }}>
            <span>Não repetir a mesma música por (minutos)</span>
            <input type="number" min={0} max={1440} value={f.noRepeatMinutes} onChange={(e) => setF({ ...f, noRepeatMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })} disabled={!isAdmin} />
            <small className="hint">Uma música que tocou só volta depois desse tempo (0 = desligado; 60 = 1 hora). Se a biblioteca for pequena e todas já tiverem tocado, a rádio continua tocando (nunca fica sem música). Vinhetas não entram na regra.</small>
          </label>
          <label className="field" style={{ maxWidth: 260 }}>
            <span>Músicas recentes no player público</span>
            <input type="number" min={1} max={50} value={f.historyLimit} onChange={(e) => setF({ ...f, historyLimit: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} disabled={!isAdmin} />
            <small className="hint">Quantas faixas aparecem em “Tocou recentemente” (1 a 50).</small>
          </label>
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
