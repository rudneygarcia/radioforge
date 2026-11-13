import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api, getToken, uploadForm, type MountCfg, type Station } from '../api';
import { useCan } from '../auth';
import { Cover, Icon, Modal, useUi } from '../ui';
import TimeClips from './TimeClips';
import StereoTool from './StereoTool';
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

/** Editar estação: dados da rádio. Configurações: áudio e parte técnica. */
const CARDS = {
  edit: [],
  hora: [],
  dj: [],
  hide: [],
  tech: ['qual', 'autocue', 'proc', 'stereo', 'extra'],
} as const;

type View = 'edit' | 'tech' | 'hora' | 'dj' | 'hide';

function SettingsForm({ view }: { view: View }) {
  const show = (id: string) => (CARDS[view] as readonly string[]).includes(id);
  const { station, reload } = useOutletContext<StationCtx>();
  const can = useCan();
  const { confirm, toast } = useUi();
  const nav = useNavigate();
  const [f, setF] = useState({
    name: station.name,
    slug: station.slug,
    port: station.streamPort,
    autodj: station.autodj,
    description: station.description,
    mount: station.mount,
    format: station.format,
    bitrate: station.bitrate,
    audioPreset: station.audioPreset,
    audioGain: station.audioGain,
    audioMasterTarget: station.audioMasterTarget,
    noRepeatMinutes: station.noRepeatMinutes,
    liveTimeout: station.liveTimeout,
    liveContinue: station.liveContinue,
    timeAnnounce: station.timeAnnounce,
    timeAnnounceVoice: station.timeAnnounceVoice,
    timeVoice: station.timeVoice,
    autocue: station.autocue,
    autocueCustom: station.autocueCustom,
    autocueDuration: station.autocueDuration,
    autocueFadeIn: station.autocueFadeIn,
    autocueFadeOut: station.autocueFadeOut,
    jingleOverlap: station.jingleOverlap,
    jingleGain: station.jingleGain,
    autocueLevel: station.autocueLevel,
    hiddenWords: station.hiddenWords,
    jingleHideName: station.jingleHideName,
    requestInterval: station.requestInterval,
    requestDelay: station.requestDelay,
    stereoEnabled: station.stereoEnabled,
    stereoPreset: station.stereoPreset,
    noRepeatArtistMinutes: station.noRepeatArtistMinutes,
    timezone: station.timezone,
    historyLimit: station.historyLimit,
    liveEnabled: station.liveEnabled,
    requestsEnabled: station.requestsEnabled,
    autostart: station.autostart,
    crossfadeSeconds: station.crossfadeSeconds,
    normalize: station.normalize,
    mounts: station.mounts,
  });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Nova senha da transmissão ao vivo (a atual não volta do servidor aqui): só vai se for digitada.
  const [secret, setSecret] = useState('');
  const close = () => setOpen(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const isAdmin = can('edit_station');
  const canAdvanced = can('advanced');
  const setMount = (i: number, change: Partial<MountCfg>) =>
    setF((cur) => ({ ...cur, mounts: cur.mounts.map((m, j) => (j === i ? { ...m, ...change } : m)) }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/stations/${station.id}`, { method: 'PUT', body: { ...f, ...(secret.trim() ? { sourcePassword: secret.trim() } : {}) } });
      setSecret('');
      await reload();
      toast('Alterações salvas');
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

  const onOff = (v: boolean) => (v ? 'ligado' : 'desligado');
  return (
    <form onSubmit={save}>
      {!isAdmin && <div className="card notice">Você não tem permissão para alterar as configurações desta estação.</div>}

      {view === 'edit' && (
      <div className="card section">
        <div className="section-title"><h3>Geral</h3></div>
        <div className="fields">
          <label className="field"><span>Nome</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!isAdmin} required /></label>
          <label className="field">
            <span>Endereço curto <em className="hint">(URL do player e do stream)</em></span>
            <div className="input-prefix">
              <span>{location.host}/listen/</span>
              <input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) })} disabled={!isAdmin} maxLength={40} required />
            </div>
            <small className="hint">Mudar o endereço muda os links: quem já usa o antigo (players, apps, o site) precisa trocar.</small>
          </label>
          <Toggle checked={f.autodj} onChange={(v) => setF({ ...f, autodj: v })} disabled={!isAdmin} title="AutoDJ (músicas automáticas)" hint="Desligado = só transmissão ao vivo: roda apenas o Icecast (o DJ conecta direto nele, na porta e no mount mostrados no Painel) e o Liquidsoap e todo o processamento de áudio ficam desligados, economizando CPU. Sem AutoDJ não há playlists, pedidos, hora certa, AutoCue, processadores nem streams extras. Ao salvar, a estação reinicia." />
          {can('system') && (
            <label className="field" style={{ maxWidth: 340 }}>
              <span>Porta da estação</span>
              <input type="number" min={1024} max={65000} value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) || 0 })} disabled={!isAdmin} />
              <small className="hint">Usada pelo link direto do stream. A estação ocupa 10 portas seguidas a partir dela (DJ ao vivo = porta +5). Trocar a porta reinicia a estação e muda o link direto e o endereço do DJ: ela precisa estar liberada no servidor.</small>
            </label>
          )}
          {can('system') && (
            <label className="field">
              <span>Nova senha da transmissão ao vivo <em className="hint">(usuário source)</em></span>
              <div className="row" style={{ margin: 0 }}>
                <input value={secret} onChange={(e) => setSecret(e.target.value.replace(/\s/g, ''))} placeholder="Deixe em branco para manter a atual" maxLength={64} autoComplete="off" disabled={!isAdmin} style={{ flex: 1, minWidth: 160 }} />
                {isAdmin && <button type="button" className="ghost small" onClick={() => setSecret(Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join(''))}>Gerar</button>}
              </div>
              <small className="hint">A senha atual aparece no Painel (cartão Serviço de transmissão). Mínimo 6 caracteres, sem espaços. Ao salvar, a estação reinicia e o DJ precisa usar a nova senha.</small>
            </label>
          )}
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
      )}

      <div className="settings-grid" style={view === 'tech' ? undefined : { display: 'none' }}>
        {show('capa') && (
          <button type="button" className="setting-card" onClick={() => setOpen('capa')}>
            <strong>Capa da rádio</strong>
            <span>{station.coverUrl ? 'Imagem enviada' : 'Sem capa — usa o ícone padrão'}</span>
          </button>
        )}
        {show('qual') && (
          <button type="button" className="setting-card" onClick={() => setOpen('qual')}>
            <strong>Qualidade do áudio</strong>
            <span>{`${f.format.toUpperCase()} ${f.bitrate} kbps · normalizar ${onOff(f.normalize)}`}</span>
          </button>
        )}
        {show('autocue') && (
          <button type="button" className="setting-card" onClick={() => setOpen('autocue')}>
            <strong>AutoCue e passagens</strong>
            <span>{f.autocue ? `Ligado${f.autocueCustom ? ' · personalizado' : ''} · vinhetas ${f.jingleOverlap === 0 ? 'inteiras' : `${f.jingleOverlap.toFixed(1)}s de sobreposição`}` : 'Desligado'}</span>
          </button>
        )}
        {show('proc') && (
          <button type="button" className="setting-card" onClick={() => setOpen('proc')}>
            <strong>Processador de áudio</strong>
            <span>
              {f.stereoEnabled
                ? 'Desativado: o Stereo Tool está em uso'
                : f.audioPreset === 'off'
                  ? 'Desligado'
                  : `${f.audioPreset === 'master_me' ? 'master_me (como no AzuraCast)' : f.audioPreset === 'loud' ? 'Forte (FM)' : 'Equilibrado'}${f.audioGain ? ` · +${f.audioGain} dB` : ''}`}
            </span>
          </button>
        )}
        {show('stereo') && can('system') && (
          <button type="button" className="setting-card" onClick={() => setOpen('stereo')}>
            <strong>Stereo Tool</strong>
            <span>{f.stereoEnabled ? `Ligado${f.stereoPreset ? ` · ${f.stereoPreset}` : ''}` : 'Desligado'}</span>
          </button>
        )}
        {show('hora') && (
          <button type="button" className="setting-card" onClick={() => setOpen('hora')}>
            <strong>Hora certa</strong>
            <span>{f.timeAnnounce === 0 ? 'Desligada' : `A cada ${f.timeAnnounce === 60 ? 'hora' : `${f.timeAnnounce} min`} · ${f.timezone}`}</span>
          </button>
        )}
        {show('dj') && (
          <button type="button" className="setting-card" onClick={() => setOpen('dj')}>
            <strong>AutoDJ, ao vivo e pedidos</strong>
            <span>{`DJ ao vivo ${onOff(f.liveEnabled)} · pedidos ${onOff(f.requestsEnabled)} · sem repetir ${f.noRepeatMinutes ? f.noRepeatMinutes + ' min' : 'desligado'}`}</span>
          </button>
        )}
        {show('hide') && (
          <button type="button" className="setting-card" onClick={() => setOpen('hide')}>
            <strong>Ocultar nomes (metadados)</strong>
            <span>{f.hiddenWords.trim() ? `${f.hiddenWords.split(/[\n,;]+/).filter((w) => w.trim()).length} palavra(s) ocultas` : 'Nenhuma palavra'}{f.jingleHideName ? ' · vinhetas sem nome' : ''}</span>
          </button>
        )}
        {show('extra') && (
          <button type="button" className="setting-card" onClick={() => setOpen('extra')}>
            <strong>Streams extras</strong>
            <span>{f.mounts.length ? `${f.mounts.length} extra(s)` : 'Nenhum'}</span>
          </button>
        )}
      </div>

      {view === 'edit' && (
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
      )}

      <Modal open={open === 'qual'} title="Qualidade do áudio" onClose={close} size="md" footer={<button type="button" onClick={close}>Concluído</button>}>
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
          <Toggle checked={f.normalize} onChange={(v) => setF({ ...f, normalize: v })} disabled={!isAdmin} title="Normalizar volume" hint="ReplayGain: usa as tags dos arquivos." />
        </div>
      </Modal>

      <Modal open={open === 'autocue'} title="AutoCue e passagens" onClose={close} size="lg" footer={<button type="button" onClick={close}>Concluído</button>}>
        <p className="muted" style={{ marginTop: -4 }}>O AutoCue analisa cada faixa (começo e fim reais, silêncio, volume) e faz as passagens entre músicas, vinhetas e hora certa. Vale para <strong>tudo</strong> que vai ao ar. Só no modo completo.</p>
          <div className="fields">
            <Toggle checked={f.autocue} onChange={(v) => setF({ ...f, autocue: v })} disabled={!isAdmin} title="Ligar o AutoCue" hint="Substitui o crossfade fixo. Na primeira vez que cada arquivo toca ele é analisado (usa um pouco de CPU)." />
            <Toggle checked={f.autocueLevel} onChange={(v) => setF({ ...f, autocueLevel: v })} disabled={!isAdmin || !f.autocue} title="Nivelar o volume de músicas, vinhetas e hora certa" hint="Usa o volume medido de cada arquivo para tudo ficar no mesmo nível, além do processador de áudio." />
            <Toggle checked={f.autocueCustom} onChange={(v) => setF({ ...f, autocueCustom: v })} disabled={!isAdmin || !f.autocue} title="Personalizar a passagem entre músicas" hint="Desligado = padrão do Liquidsoap. Ligado = usa os valores abaixo." />
            <div style={{ opacity: f.autocue && f.autocueCustom ? 1 : 0.5, display: 'grid', gap: 12 }}>
              <label className="field">
                <span>Duração da passagem entre músicas: {f.autocueDuration}s</span>
                <input type="range" min={0.5} max={15} step={0.5} value={f.autocueDuration} onChange={(e) => setF({ ...f, autocueDuration: Number(e.target.value) })} disabled={!isAdmin || !f.autocue || !f.autocueCustom} style={{ padding: 0 }} />
              </label>
              <label className="field">
                <span>Fade de entrada: {f.autocueFadeIn}s</span>
                <input type="range" min={0} max={10} step={0.5} value={f.autocueFadeIn} onChange={(e) => setF({ ...f, autocueFadeIn: Number(e.target.value) })} disabled={!isAdmin || !f.autocue || !f.autocueCustom} style={{ padding: 0 }} />
              </label>
              <label className="field">
                <span>Fade de saída: {f.autocueFadeOut}s</span>
                <input type="range" min={0} max={10} step={0.5} value={f.autocueFadeOut} onChange={(e) => setF({ ...f, autocueFadeOut: Number(e.target.value) })} disabled={!isAdmin || !f.autocue || !f.autocueCustom} style={{ padding: 0 }} />
              </label>
            </div>
            <label className="field" style={{ opacity: f.autocue ? 1 : 0.5 }}>
              <span>Sobreposição entre vinhetas e avisos: {f.jingleOverlap === 0 ? 'nenhuma (cada uma toca inteira)' : `${f.jingleOverlap.toFixed(1)}s`}</span>
              <input type="range" min={0} max={3} step={0.1} value={f.jingleOverlap} onChange={(e) => setF({ ...f, jingleOverlap: Number(e.target.value) })} disabled={!isAdmin || !f.autocue} style={{ padding: 0 }} />
              <small className="hint">Com 0, uma vinheta termina inteira antes da próxima começar (sem cortar no meio). Suba um pouco para emendar mais rápido.</small>
            </label>
            <label className="field" style={{ opacity: f.autocue ? 1 : 0.5 }}>
              <span>Volume extra das vinhetas e da hora certa: {f.jingleGain > 0 ? `+${f.jingleGain}` : f.jingleGain} dB</span>
              <input type="range" min={-12} max={12} step={1} value={f.jingleGain} onChange={(e) => setF({ ...f, jingleGain: Number(e.target.value) })} disabled={!isAdmin || !f.autocue} style={{ padding: 0 }} />
              <small className="hint">Ajuste fino só para vinhetas e avisos de hora, em relação às músicas.</small>
            </label>
            <label className="field" style={{ opacity: f.autocue ? 0.5 : 1 }}>
              <span>Crossfade fixo (usado só com o AutoCue desligado): {f.crossfadeSeconds === 0 ? 'desligado' : `${f.crossfadeSeconds}s`}</span>
              <input type="range" min={0} max={10} step={0.5} value={f.crossfadeSeconds} onChange={(e) => setF({ ...f, crossfadeSeconds: Number(e.target.value) })} disabled={!isAdmin || f.autocue} style={{ padding: 0 }} />
            </label>
          </div>
      </Modal>

      <Modal open={open === 'proc'} title="Processador de áudio" onClose={close} size="md" footer={<button type="button" onClick={close}>Concluído</button>}>
        <p className="muted" style={{ marginTop: -4 }}>Nivela o volume entre músicas e DJ, deixa o som mais alto e cheio e evita estouros (distorção), no estilo de rádio FM.</p>
        {f.stereoEnabled && <div className="card notice"><strong>Stereo Tool ligado:</strong> o processador interno fica desativado e só o Stereo Tool processa o áudio. Para voltar a usar este, desligue o Stereo Tool.</div>}
        {station.audioWarning && <div className="card notice" style={{ whiteSpace: 'pre-wrap' }}><strong>Atenção:</strong> {station.audioWarning}</div>}
        <div className="fields">
          <label className="field">
            <span>Predefinição</span>
            <select value={f.audioPreset} onChange={(e) => setF({ ...f, audioPreset: e.target.value as typeof f.audioPreset })} disabled={!isAdmin || f.stereoEnabled}>
              <option value="off">Desligado (áudio original, sem nivelar)</option>
              <option value="balanced">Equilibrado (normaliza + compressão + limitador) — recomendado</option>
              <option value="loud">Forte, estilo FM (normaliza + compressão firme + limitador)</option>
              <option value="master_me">master_me (o mesmo processador do AzuraCast)</option>
            </select>
            <small className="hint">
              {f.audioPreset === 'master_me'
                ? 'Plugin externo (master_me/AzuraCast): leveler + compressor multibanda + limitador num só processo. Só funciona se o arquivo tiver sido instalado na imagem do servidor; se não, o painel avisa e a rádio sobe sem processamento.'
                : 'Só no modo completo (Icecast + Liquidsoap). O limitador no final impede a distorção mesmo com o volume alto.'}
            </small>
          </label>
          {f.audioPreset === 'master_me' && (
            <label className="field">
              <span>Volume alvo do master_me: {f.audioMasterTarget} LUFS</span>
              <select
                value={[-14, -16, -18, -23].includes(f.audioMasterTarget) ? String(f.audioMasterTarget) : 'custom'}
                onChange={(e) => e.target.value !== 'custom' && setF({ ...f, audioMasterTarget: Number(e.target.value) })}
                disabled={!isAdmin || f.stereoEnabled}
              >
                <option value="-14">-14 LUFS — streaming/YouTube (mais alto)</option>
                <option value="-16">-16 LUFS — música geral, podcasts Apple (recomendado)</option>
                <option value="-18">-18 LUFS — mais dinâmico</option>
                <option value="-23">-23 LUFS — padrão EBU R128 de TV/rádio europeu</option>
                <option value="custom">Personalizado…</option>
              </select>
              <input
                type="number"
                min={-30}
                max={-6}
                step={1}
                value={f.audioMasterTarget}
                onChange={(e) => setF({ ...f, audioMasterTarget: Number(e.target.value) })}
                disabled={!isAdmin || f.stereoEnabled}
              />
              <small className="hint">Quanto mais perto de 0, mais alto (e menos dinâmico) fica o som. Valores entre -14 e -18 LUFS são comuns para rádio pela internet.</small>
            </label>
          )}
          <label className="field">
            <span>Volume extra: {f.audioGain === 0 ? 'sem ganho' : `+${f.audioGain} dB`}</span>
            <input type="range" min={0} max={12} step={1} value={f.audioGain} onChange={(e) => setF({ ...f, audioGain: Number(e.target.value) })} disabled={!isAdmin || f.stereoEnabled} style={{ padding: 0 }} />
            <small className="hint">
              {f.audioPreset === 'master_me'
                ? 'Aqui vira o ganho de entrada do próprio master_me, antes dele processar.'
                : 'Se ainda estiver baixo, suba de 2 em 2 dB. Acima de uns +8 dB o som pode ficar “espremido”; o limitador evita o estouro, mas escute antes de deixar fixo.'}
            </small>
          </label>
        </div>
      </Modal>

      <Modal open={open === 'stereo'} title="Stereo Tool" onClose={close} size="lg" footer={<button type="button" onClick={close}>Concluído</button>}>
        <StereoTool stationId={station.id} isAdmin={can('system')} isSystem={can('system')} enabled={f.stereoEnabled} onEnabled={(v) => setF({ ...f, stereoEnabled: v })} />
      </Modal>

      {view === 'hora' && (
        <div className="card section">
          <div className="section-title"><h3>Hora certa</h3></div>
        <p className="muted" style={{ marginTop: -4 }}>O AutoDJ avisa a hora usando os <strong>seus áudios</strong> (um por minuto, enviados num ZIP abaixo) ou, se faltar, a voz sintética (ex.: “Hora certa. São catorze horas e meia.”). O aviso entra na fila e toca <strong>ao fim da música atual</strong> (o servidor estima esse instante e fala o minuto certo); não aparece em “Tocando agora” nem no histórico, e não toca enquanto há DJ ao vivo.</p>
        <div className="fields">
          <div className="field-row">
            <label className="field">
              <span>Avisar a hora</span>
              <select value={f.timeAnnounce} onChange={(e) => setF({ ...f, timeAnnounce: Number(e.target.value) as typeof f.timeAnnounce })} disabled={!isAdmin}>
                <option value={0}>Desligada</option>
                <option value={60}>A cada hora (:00)</option>
                <option value={30}>A cada 30 minutos</option>
                <option value={20}>A cada 20 minutos</option>
                <option value={15}>A cada 15 minutos</option>
                <option value={10}>A cada 10 minutos</option>
                <option value={5}>A cada 5 minutos</option>
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
            {can('control') && station.running && <button type="button" className="ghost small" onClick={announceNowClick}><Icon name="mic" size={13} /> Tocar agora na rádio</button>}
          </div>
          <Toggle checked={f.timeAnnounceVoice} onChange={(v) => setF({ ...f, timeAnnounceVoice: v })} disabled={!isAdmin} title="Usar a voz sintética quando não houver arquivo para o horário" hint="Desligue se você enviar os seus próprios áudios: nos horários sem arquivo a rádio simplesmente não avisa." />
          <small className="hint">Salve as configurações para valer a mudança. Só funciona no modo completo. A hora usa o fuso escolhido acima (o servidor costuma estar em UTC).</small>
        </div>
        <TimeClips station={station} isAdmin={canAdvanced} voiceFallback={f.timeAnnounceVoice} voice={f.timeVoice} onVoice={(v) => setF({ ...f, timeVoice: v })} />
      </div>
      )}

      {view === 'dj' && (
        <div className="card section">
          <div className="section-title"><h3>AutoDJ, ao vivo e pedidos</h3></div>
        <div className="fields form-grid">
          <Toggle checked={f.liveEnabled} onChange={(v) => setF({ ...f, liveEnabled: v })} disabled={!isAdmin} title="Permitir DJ ao vivo" />
          <label className="field">
            <span>AutoDJ volta após (segundos sem sinal do encoder)</span>
            <input type="number" min={3} max={60} value={f.liveTimeout} onChange={(e) => setF({ ...f, liveTimeout: Math.max(3, Math.min(60, Number(e.target.value) || 8)) })} disabled={!isAdmin || !f.liveEnabled} />
            <small className="hint">Se o encoder cair (ex.: internet cortou), o AutoDJ assume depois desse tempo. Menor = volta mais rápido, mas uma oscilação curta já derruba o ao vivo. Padrão: 8 s.</small>
          </label>
          <Toggle checked={f.liveContinue} onChange={(v) => setF({ ...f, liveContinue: v })} disabled={!isAdmin || !f.liveEnabled} title="AutoDJ continua a música ao voltar do ao vivo" hint="Durante o DJ, o AutoDJ segue tocando mudo; quando o encoder cai, a música que estiver tocando continua (em vez de começar outra). Enquanto o DJ está no ar, pedidos de ouvintes ficam indisponíveis." />
          <label className="field">
            <span>Não repetir a mesma música por (minutos)</span>
            <input type="number" min={0} max={1440} value={f.noRepeatMinutes} onChange={(e) => setF({ ...f, noRepeatMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })} disabled={!isAdmin} />
            <small className="hint">Uma música que tocou só volta depois desse tempo (0 = desligado; 60 = 1 hora). Se a biblioteca for pequena e todas já tiverem tocado, a rádio continua tocando (nunca fica sem música). Vinhetas não entram na regra.</small>
          </label>
          <label className="field">
            <span>Não repetir o mesmo artista por (minutos)</span>
            <input type="number" min={0} max={1440} value={f.noRepeatArtistMinutes} onChange={(e) => setF({ ...f, noRepeatArtistMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })} disabled={!isAdmin} />
            <small className="hint">Depois que um artista toca, outra música dele só entra depois desse tempo (0 = desligado; 30 = meia hora). Feats e participações contam como o artista principal. Se não houver outra opção, a rádio relaxa a regra em vez de ficar muda.</small>
          </label>
          <label className="field">
            <span>Músicas recentes no player público</span>
            <input type="number" min={1} max={50} value={f.historyLimit} onChange={(e) => setF({ ...f, historyLimit: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} disabled={!isAdmin} />
            <small className="hint">Quantas faixas aparecem em “Tocou recentemente” (1 a 50).</small>
          </label>
          <Toggle checked={f.requestsEnabled} onChange={(v) => setF({ ...f, requestsEnabled: v })} disabled={!isAdmin} title="Permitir pedidos de músicas" hint="Ouvintes podem pedir faixas pelo player público." />
          <div className="field-row">
            <label className="field">
              <span>Intervalo entre pedidos de cada ouvinte (min)</span>
              <input type="number" min={0} max={1440} value={f.requestInterval} onChange={(e) => setF({ ...f, requestInterval: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })} disabled={!isAdmin || !f.requestsEnabled} />
              <small className="hint">Quanto cada ouvinte espera para pedir outra música (0 = sem limite). Padrão: 5.</small>
            </label>
            <label className="field">
              <span>Tempo para o pedido entrar no AutoDJ (min)</span>
              <input type="number" min={0} max={240} value={f.requestDelay} onChange={(e) => setF({ ...f, requestDelay: Math.max(0, Math.min(240, Number(e.target.value) || 0)) })} disabled={!isAdmin || !f.requestsEnabled} />
              <small className="hint">0 = entra na fila na hora (toca ao fim da música atual). Com 10, o pedido só entra na fila depois de 10 minutos.</small>
            </label>
          </div>
        </div>
      </div>
      )}

      {view === 'hide' && (
        <div className="card section">
          <div className="section-title"><h3>Ocultar nomes (metadados)</h3></div>
        <p className="muted" style={{ marginTop: -4 }}>Músicas cujo título, artista, álbum ou nome do arquivo contenham alguma destas palavras <strong>tocam normalmente, mas sem enviar metadados</strong>: não aparecem em “Tocando agora”, no histórico, nos webhooks nem no stream (também não vai o nome da estação).</p>
        <div className="fields">
          <label className="field">
            <span>Palavras ou trechos (uma por linha)</span>
            <textarea rows={6} value={f.hiddenWords} onChange={(e) => setF({ ...f, hiddenWords: e.target.value })} disabled={!isAdmin} placeholder={'vinheta\npropaganda\nnome de uma música'} />
            <small className="hint">Não diferencia maiúsculas/minúsculas nem acentos. Use pelo menos 2 letras. Vale ao salvar (a estação reinicia).</small>
          </label>
          <Toggle checked={f.jingleHideName} onChange={(v) => setF({ ...f, jingleHideName: v })} disabled={!isAdmin} title="Vinhetas também sem nome" hint="Hoje as vinhetas enviam o nome da estação como título. Ligado, elas não enviam nada." />
        </div>
      </div>
      )}

      <Modal open={open === 'extra'} title="Streams extras" onClose={close} size="md" footer={<button type="button" onClick={close}>Concluído</button>}>
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
        {isAdmin && f.mounts.length < 4 && (
          <button type="button" className="ghost small" onClick={() => setF({ ...f, mounts: [...f.mounts, { mount: '/radio-extra', format: 'mp3', bitrate: 64 }] })}><Icon name="plus" size={13} /> Adicionar stream</button>
        )}
      </Modal>

      {isAdmin && (
        <div className="save-bar">
          <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar alterações'}</button>
          <span className="muted small-text">Reinicia a estação se estiver no ar.</span>
        </div>
      )}

      {can('system') && view === 'edit' && (
        <div className="card danger-zone">
          <h3>Zona de perigo</h3>
          <p className="muted">Excluir a estação apaga a biblioteca, as playlists e o histórico dela.</p>
          <button type="button" className="danger" onClick={remove}><Icon name="trash" /> Excluir estação</button>
        </div>
      )}
    </form>
  );
}

/** Editar estação: nome, endereço, porta, senha e excluir. */
export function EditStation() {
  return <SettingsForm view="edit" />;
}

/** Páginas próprias no menu da estação (antes eram cartões dentro de Editar estação). */
export const TimeSettings = () => <SettingsForm view="hora" />;
export const AutoDjSettings = () => <SettingsForm view="dj" />;
export const HideSettings = () => <SettingsForm view="hide" />;

/** Configurações: áudio (qualidade, AutoCue, processador, Stereo Tool) e streams extras. */
export default function Settings() {
  return <SettingsForm view="tech" />;
}
