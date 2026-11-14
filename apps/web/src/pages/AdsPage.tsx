import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, type Folder } from '../api';
import { Empty, Icon, Modal, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

interface Vinhetas {
  exitPlaylistId: number | null;
  entryPlaylistId: number | null;
  jingles: { id: number; name: string }[];
}

interface Block {
  id: number;
  name: string;
  folderId: number | null;
  folderName: string | null;
  count: number;
  times: string[];
  days: number[];
  mode: 'sequential' | 'shuffle';
  items: number;
  enabled: boolean;
}
interface Play {
  id: number;
  block_name: string;
  title: string;
  status: string;
  note: string;
  pushed_at: string;
  played_at: string | null;
}
type Draft = Omit<Block, 'id' | 'folderName' | 'count'> & { id?: number };

const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const empty = (): Draft => ({ name: '', folderId: null, times: [], days: [0, 1, 2, 3, 4, 5, 6], mode: 'sequential', items: 0, enabled: true });
/** Situação do comercial: Tocou (confirmado pelo Liquidsoap), Na fila (enviado há pouco) ou Enviado (sem confirmação depois de 15 min). */
function playState(p: { status: string; played_at: string | null; pushed_at: string }): { label: string; cls: string; at: string } {
  if (p.status === 'erro') return { label: 'Erro', cls: 'queued', at: p.pushed_at };
  if (p.status === 'pulado') return { label: 'Pulado', cls: 'queued', at: p.pushed_at };
  if (p.played_at) return { label: 'Tocou', cls: 'played', at: p.played_at };
  const old = Date.now() - new Date(p.pushed_at.replace(' ', 'T') + 'Z').getTime() > 15 * 60_000;
  return { label: old ? 'Enviado' : 'Na fila', cls: old ? 'played' : 'queued', at: p.pushed_at };
}

const when = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString();

/** Blocos comerciais: comerciais de uma pasta da Biblioteca que entram nos horários programados. */
export default function AdsPage() {
  const { station } = useOutletContext<StationCtx>();
  const { toast, confirm } = useUi();
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [plays, setPlays] = useState<Play[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [vinhetas, setVinhetas] = useState<Vinhetas | null>(null);
  const [help, setHelp] = useState(false);

  const load = useCallback(() => {
    api<Block[]>(`/api/stations/${station.id}/ad-blocks`).then(setBlocks).catch((e) => toast((e as Error).message, 'error'));
    api<Play[]>(`/api/stations/${station.id}/ad-plays?limit=3`).then(setPlays).catch(() => {});
    api<Vinhetas>(`/api/stations/${station.id}/ad-vinhetas`).then(setVinhetas).catch(() => {});
  }, [station.id, toast]);
  useEffect(() => {
    load();
    api<Folder[]>(`/api/stations/${station.id}/folders`).then(setFolders).catch(() => {});
    const t = setInterval(() => { if (!document.hidden) load(); }, 15000);
    return () => clearInterval(t);
  }, [load, station.id]);

  async function saveVinhetas(next: Vinhetas) {
    setVinhetas(next);
    try {
      await api(`/api/stations/${station.id}/ad-vinhetas`, { method: 'PUT', body: { exitPlaylistId: next.exitPlaylistId, entryPlaylistId: next.entryPlaylistId } });
      toast('Vinhetas de bloco salvas');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const addTime = () => {
    if (!draft || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || draft.times.includes(time)) return;
    setDraft({ ...draft, times: [...draft.times, time].sort() });
    setTime('');
  };

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const payload = { name: draft.name, folderId: draft.folderId, times: draft.times, days: draft.days, mode: draft.mode, items: draft.items, enabled: draft.enabled };
      if (draft.id) await api(`/api/stations/${station.id}/ad-blocks/${draft.id}`, { method: 'PUT', body: payload });
      else await api(`/api/stations/${station.id}/ad-blocks`, { method: 'POST', body: payload });
      toast('Bloco salvo');
      setDraft(null);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: Block) {
    if (!(await confirm({ title: `Excluir o bloco “${b.name}”?`, message: 'Os arquivos da pasta continuam na Biblioteca; só o agendamento é removido.', confirmLabel: 'Excluir', danger: true }))) return;
    await api(`/api/stations/${station.id}/ad-blocks/${b.id}`, { method: 'DELETE' });
    load();
  }

  async function fire(b: Block) {
    try {
      const r = await api<{ queued: number }>(`/api/stations/${station.id}/ad-blocks/${b.id}/fire`, { method: 'POST' });
      toast(`${r.queued} comercial(is) na fila: tocam ao fim da música atual`);
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function toggle(b: Block) {
    await api(`/api/stations/${station.id}/ad-blocks/${b.id}`, { method: 'PUT', body: { name: b.name, folderId: b.folderId, times: b.times, days: b.days, mode: b.mode, items: b.items, enabled: !b.enabled } });
    load();
  }

  return (
    <>
      {!station.autodj && <div className="card notice">Esta estação está sem AutoDJ (só ao vivo): os blocos comerciais não tocam. Ligue o AutoDJ em Editar estação.</div>}

      <div className="section-title">
        <h3>Comerciais</h3>
        <button type="button" className="ghost small" onClick={() => setHelp(true)}><Icon name="info" size={14} /> Ajuda: vinhetas de bloco</button>
      </div>

      {vinhetas && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h4 style={{ marginTop: 0 }}>Vinhetas de bloco</h4>
          <p className="muted" style={{ marginTop: -4 }}>Tocam em TODO comercial disparado, não importa o bloco. Com mais de uma música na playlist, cada disparo toca a próxima (não a mesma sempre).</p>
          <div className="field-row">
            <label className="field">
              <span>Vinheta de saída de bloco <em className="hint">(antes do comercial)</em></span>
              <select value={vinhetas.exitPlaylistId ?? ''} onChange={(e) => saveVinhetas({ ...vinhetas, exitPlaylistId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— nenhuma —</option>
                {vinhetas.jingles.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Vinheta de entrada de bloco <em className="hint">(depois do comercial)</em></span>
              <select value={vinhetas.entryPlaylistId ?? ''} onChange={(e) => saveVinhetas({ ...vinhetas, entryPlaylistId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— nenhuma —</option>
                {vinhetas.jingles.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
              </select>
            </label>
          </div>
          {vinhetas.jingles.length === 0 && (
            <p className="muted small-text" style={{ marginBottom: 0 }}>Nenhuma playlist marcada como "Jingle (vinheta)" ainda. Crie uma em Playlists e adicione os arquivos da vinheta nela.</p>
          )}
        </div>
      )}

      <Modal open={help} title="Vinhetas de bloco, passo a passo" onClose={() => setHelp(false)} size="lg" footer={<button type="button" onClick={() => setHelp(false)}>Entendi</button>}>
        <div className="fields">
          <div className="card" style={{ margin: 0 }}>
            <h4 style={{ marginTop: 0 }}>Como funciona</h4>
            <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li>Quando QUALQUER bloco comercial dispara, a <strong>vinheta de saída</strong> toca primeiro (a música atual termina, ela entra, depois vêm os comerciais).</li>
              <li>Depois do último comercial, a <strong>vinheta de entrada</strong> toca, e só então a programação normal volta.</li>
              <li>Nenhuma das duas aparece em "Tocando agora" nem no histórico (como qualquer vinheta).</li>
            </ol>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <h4 style={{ marginTop: 0 }}>Para configurar</h4>
            <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              <li>Em <strong>Playlists</strong>, crie uma playlist, marque <strong>Jingle (vinheta)</strong> e adicione o(s) arquivo(s) de áudio da vinheta de saída. Repita para a de entrada (pode ser a mesma playlist nas duas, se quiser).</li>
              <li>Volte aqui e escolha cada playlist nos campos <strong>Vinheta de saída</strong> e <strong>Vinheta de entrada</strong> acima.</li>
              <li>Se a playlist escolhida tiver só um arquivo, ele toca sempre. Com dois ou mais, cada vez que um comercial disparar, toca o próximo da lista (não ao acaso).</li>
            </ol>
          </div>
        </div>
      </Modal>

      <div className="dash">
        <div className="dash-col">
          <section className="pcard">
            <header className="pcard-hd">
              <h3>Blocos comerciais</h3>
              <button type="button" className="ghost small" style={{ color: '#fff', borderColor: 'rgba(255,255,255,.5)' }} onClick={() => setDraft(empty())}><Icon name="plus" size={14} /> Novo bloco</button>
            </header>
            <div className="pcard-bd">
              <p className="muted" style={{ marginTop: 0 }}>
                Coloque os comerciais numa <strong>pasta da Biblioteca</strong> e programe aqui os horários em que eles entram. No horário, o bloco vai para a fila do AutoDJ e toca <strong>ao fim da música atual</strong>, sem aparecer em “Tocando agora” nem no histórico.
              </p>
              {blocks === null ? (
                <div className="skeleton" style={{ height: 80 }} />
              ) : blocks.length === 0 ? (
                <Empty icon="clock" title="Nenhum bloco ainda" text="Crie um bloco com os horários e a pasta dos comerciais." action={<button type="button" onClick={() => setDraft(empty())}><Icon name="plus" /> Novo bloco</button>} />
              ) : (
                blocks.map((b) => (
                  <div key={b.id} className="ad-block">
                    <div className="ad-head">
                      <strong>{b.name}</strong>
                      <span className={`req-state ${b.enabled ? 'played' : 'queued'}`}>{b.enabled ? 'Ativo' : 'Pausado'}</span>
                    </div>
                    <div className="chips" style={{ margin: '8px 0' }}>
                      {b.times.map((t) => <span className="tag accent" key={t}><Icon name="clock" size={12} /> {t}</span>)}
                    </div>
                    <p className="muted small-text" style={{ margin: 0 }}>
                      {b.days.length === 7 ? 'Todos os dias' : b.days.map((d) => DAYS[d]).join(', ')} · Pasta: {b.folderName ?? '— (escolha uma pasta)'} ({b.count} arquivo{b.count === 1 ? '' : 's'}) · {b.items === 0 ? 'todos os comerciais' : `${b.items} por bloco`} · {b.mode === 'sequential' ? 'em ordem' : 'aleatório'}
                    </p>
                    <div className="row" style={{ margin: '10px 0 0' }}>
                      <button type="button" className="ghost small" onClick={() => fire(b)} disabled={!station.running || !station.autodj}><Icon name="play" size={13} /> Disparar agora</button>
                      <button type="button" className="ghost small" onClick={() => toggle(b)}>{b.enabled ? 'Pausar' : 'Ativar'}</button>
                      <button type="button" className="ghost small" onClick={() => setDraft({ id: b.id, name: b.name, folderId: b.folderId, times: b.times, days: b.days, mode: b.mode, items: b.items, enabled: b.enabled })}><Icon name="edit" size={13} /> Editar</button>
                      <button type="button" className="icon-btn" title="Excluir" onClick={() => remove(b)}><Icon name="trash" /></button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="dash-col">
          <section className="pcard">
            <header className="pcard-hd"><h3>Últimas veiculações</h3></header>
            <div className="pcard-bd" style={{ padding: 0 }}>
              {plays.length === 0 ? (
                <p className="muted" style={{ margin: 16 }}>Nada foi ao ar ainda. Cada comercial colocado na fila fica registrado aqui, com data e hora.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {plays.map((p) => (
                        <tr key={p.id}>
                          <td><strong>{p.title || p.block_name}</strong><br /><span className="muted small-text">{p.block_name}{p.note ? ` · ${p.note}` : ''}</span></td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <span className={`req-state ${playState(p).cls}`}>{playState(p).label}</span><br />
                            <span className="muted small-text">{when(playState(p).at)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted small-text" style={{ margin: 16 }}>“Na fila” = enviado ao AutoDJ (toca ao fim da música que estiver no ar). Vira “Tocou”, com o horário real, assim que o comercial começa a tocar.</p>
            </div>
          </section>
        </div>
      </div>

      <Modal
        open={!!draft}
        title={draft?.id ? 'Editar bloco' : 'Novo bloco comercial'}
        onClose={() => setDraft(null)}
        size="lg"
        footer={
          <>
            <button type="button" className="ghost" onClick={() => setDraft(null)}>Cancelar</button>
            <button type="button" onClick={save} disabled={busy || !draft?.name.trim()}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </>
        }
      >
        {draft && (
          <div className="fields">
            <label className="field">
              <span>Nome do bloco</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ex.: Comerciais da manhã" maxLength={80} />
            </label>
            <label className="field">
              <span>Pasta com os comerciais</span>
              <select value={draft.folderId ?? ''} onChange={(e) => setDraft({ ...draft, folderId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— escolha uma pasta —</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.count})</option>)}
              </select>
              <small className="hint">Crie uma pasta (ex.: “Comerciais”) na Biblioteca e envie os arquivos para ela. Não deixe essa pasta numa playlist, senão os comerciais também tocam na programação normal.</small>
            </label>
            <div className="field">
              <span>Horários</span>
              <div className="row" style={{ margin: 0 }}>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTime(); } }} style={{ width: 150 }} />
                <button type="button" className="ghost small" onClick={addTime} disabled={!time}><Icon name="plus" size={13} /> Adicionar horário</button>
              </div>
              <div className="chips" style={{ marginTop: 8 }}>
                {draft.times.length === 0 && <span className="muted small-text">Nenhum horário ainda.</span>}
                {draft.times.map((t) => (
                  <span className="tag accent" key={t}>{t} <button type="button" className="icon-btn" style={{ width: 20, height: 20 }} title="Remover" onClick={() => setDraft({ ...draft, times: draft.times.filter((x) => x !== t) })}><Icon name="x" size={11} /></button></span>
                ))}
              </div>
              <small className="hint">No fuso da estação ({station.timezone}). Ex.: 08:00, 12:30, 18:00.</small>
            </div>
            <div className="field">
              <span>Dias da semana</span>
              <div className="chips">
                {DAYS.map((d, i) => (
                  <button type="button" key={d} className={`fchip${draft.days.includes(i) ? ' active' : ''}`} onClick={() => setDraft({ ...draft, days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}>{d}</button>
                ))}
              </div>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Quantos comerciais por bloco</span>
                <input type="number" min={0} max={50} value={draft.items} onChange={(e) => setDraft({ ...draft, items: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} />
                <small className="hint">0 = todos os da pasta.</small>
              </label>
              <label className="field">
                <span>Ordem</span>
                <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })}>
                  <option value="sequential">Em ordem (continua de onde parou)</option>
                  <option value="shuffle">Aleatória</option>
                </select>
              </label>
            </div>
            <label className="check-line">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              <span>Bloco ativo</span>
            </label>
          </div>
        )}
      </Modal>
    </>
  );
}
