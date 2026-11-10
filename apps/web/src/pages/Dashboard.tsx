import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { CopyButton, Cover, Empty, Icon, Modal, useUi } from '../ui';
import { useAuth } from '../auth';
import type { StationCtx } from './StationLayout';

interface Req {
  id: number;
  title: string;
  artist: string;
  ip: string;
  createdAt: string;
  status: 'waiting' | 'queued' | 'played' | 'expired';
}

interface Hist {
  title: string;
  artist: string;
  played_at: string;
  coverUrl?: string | null;
}

/** Mini player só com ícones: ouvir a própria estação sem sair do painel. */
function MiniPlayer({ slug, online }: { slug: string; online: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(() => {
    try { const v = localStorage.getItem('rf_volume'); return v === null ? 1 : Math.min(1, Math.max(0, Number(v) || 0)); } catch { return 1; }
  });
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (audio.current) { audio.current.volume = volume; audio.current.muted = muted; }
    try { localStorage.setItem('rf_volume', String(volume)); } catch { /* sem armazenamento */ }
  }, [volume, muted]);
  // Ao sair do painel, para o áudio (e a conexão com o stream).
  useEffect(() => () => { const a = audio.current; if (a) { a.pause(); a.removeAttribute('src'); a.load(); } }, []);
  useEffect(() => {
    if (!online && playing) { const a = audio.current; if (a) { a.pause(); a.removeAttribute('src'); a.load(); } setPlaying(false); }
  }, [online, playing]);

  function toggle() {
    const a = audio.current;
    if (!a) return;
    if (playing) {
      a.pause(); a.removeAttribute('src'); a.load(); setPlaying(false);
    } else {
      a.volume = volume;
      a.muted = muted;
      a.src = `/api/public/stations/${slug}/stream/0?t=${Date.now()}`;
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }
  return (
    <div className="mini-player">
      <button type="button" className="mp-play" onClick={toggle} disabled={!online} title={playing ? 'Parar de ouvir' : 'Ouvir a estação'} aria-label={playing ? 'Parar de ouvir' : 'Ouvir a estação'}>
        <Icon name={playing ? 'stop' : 'play'} size={18} />
      </button>
      {playing && <span className="eq" aria-hidden="true"><i /><i /><i /><i /></span>}
      <button type="button" className="mp-vol" onClick={() => setMuted((m) => !m)} title={muted || volume === 0 ? 'Ativar o som' : 'Silenciar'} aria-label="Silenciar">
        <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={18} />
      </button>
      <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} aria-label="Volume" onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }} />
      <audio ref={audio} />
    </div>
  );
}

/** Cartão do painel no estilo "visão geral": cabeçalho colorido, corpo e rodapé de ações. */
function PCard({ title, badge, tone, children, footer }: { title: string; badge?: string; tone?: 'on' | 'off'; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section className="pcard">
      <header className="pcard-hd">
        <h3>{title}</h3>
        {badge && <span className={`pcard-badge ${tone ?? ''}`}>{badge}</span>}
      </header>
      <div className="pcard-bd">{children}</div>
      {footer && <footer className="pcard-ft">{footer}</footer>}
    </section>
  );
}

export default function Dashboard() {
  const { station, reload } = useOutletContext<StationCtx>();
  const { toast, confirm } = useUi();
  const [history, setHistory] = useState<Hist[]>([]);
  const [busy, setBusy] = useState(false);
  const [reqs, setReqs] = useState<Req[]>([]);
  const { user } = useAuth();
  const [logOpen, setLogOpen] = useState(false);
  const [showCreds, setShowCreds] = useState(false);
  const [log, setLog] = useState('');
  const [queue, setQueue] = useState('');
  const showLog = async () => {
    setLogOpen(true);
    setLog('Carregando…');
    try {
      const r = await api<{ log: string; queue: string }>(`/api/stations/${station.id}/engine-log`);
      setLog(r.log);
      setQueue(r.queue);
    } catch (e) {
      setLog((e as Error).message);
    }
  };
  // Quantas músicas mostrar no histórico (lembra a escolha neste navegador).
  const [shown, setShown] = useState(() => {
    try {
      return Number(localStorage.getItem('rf_hist_n')) || 10;
    } catch {
      return 10;
    }
  });
  const changeShown = (n: number) => {
    setShown(n);
    try {
      localStorage.setItem('rf_hist_n', String(n));
    } catch {
      /* sem armazenamento */
    }
  };

  useEffect(() => {
    api<Hist[]>(`/api/stations/${station.id}/history`).then(setHistory);
  }, [station.id, station.nowPlaying?.playedAt]);

  useEffect(() => {
    if (!station.requestsEnabled) return;
    api<Req[]>(`/api/stations/${station.id}/requests`).then(setReqs).catch(() => {});
  }, [station.id, station.requestsEnabled, station.nowPlaying?.playedAt]);

  async function kick() {
    if (!(await confirm({ title: 'Derrubar a transmissão ao vivo?', message: 'O encoder atual é desconectado e o AutoDJ assume na hora. O DJ pode reconectar se o programa dele tentar de novo.', confirmLabel: 'Voltar ao AutoDJ', danger: true }))) return;
    setBusy(true);
    try {
      await api(`/api/stations/${station.id}/live/kick`, { method: 'POST' });
      await reload();
      toast('AutoDJ no ar');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function action(a: 'start' | 'stop' | 'restart') {
    if (a === 'stop' && !(await confirm({ title: 'Parar a estação?', message: 'Os ouvintes conectados serão desconectados.', confirmLabel: 'Parar', danger: true }))) return;
    setBusy(true);
    try {
      await api(`/api/stations/${station.id}/${a}`, { method: 'POST' });
      await reload();
      toast(a === 'start' ? 'Estação iniciada' : a === 'stop' ? 'Estação parada' : 'Estação reiniciada');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const pending = reqs.filter((r) => r.status === 'waiting' || r.status === 'queued');
  const publicUrl = `${location.origin}/listen/${station.slug}`;

  return (
    <>
      {station.engine === 'native' && (
        <div className="card notice">
          <strong>Modo simples (sem Icecast/Liquidsoap).</strong> Toca só arquivos MP3. Sem playlists, toca a biblioteca inteira em ordem aleatória.
          Não há DJ ao vivo, crossfade, normalização nem gravação, e os streams extras repetem o principal. Instale o Icecast e o Liquidsoap (ou use a imagem Docker) para o modo completo.
        </div>
      )}

      {!station.autodj && (
        <div className="card notice">
          <strong>AutoDJ desligado.</strong> Esta estação só transmite ao vivo: roda apenas o Icecast e o Liquidsoap está desligado (sem consumo de processamento de áudio). O DJ conecta direto no Icecast com o endereço, usuário e senha do cartão “Serviço de transmissão”. Para tocar músicas automáticas, ligue o AutoDJ em <Link to="edit">Editar estação</Link>.
        </div>
      )}

      {station.audioWarning && (
        <div className="card notice" style={{ whiteSpace: 'pre-wrap' }}>
          <strong>Processador de áudio:</strong> {station.audioWarning}
        </div>
      )}

      <div className="dash">
        <div className="dash-col">
          <PCard
            title={station.running ? 'No ar' : 'Parada'}
            badge={`${station.listeners} ouvinte${station.listeners === 1 ? '' : 's'}`}
            footer={
              <>
                <button type="button" className="ghost small" disabled={busy || station.running} onClick={() => action('start')}><Icon name="play" size={14} /> Iniciar</button>
                <button type="button" className="ghost small" disabled={busy || !station.running} onClick={() => action('restart')}><Icon name="refresh" size={14} /> Reiniciar</button>
                <button type="button" className="ghost small danger-text" disabled={busy || !station.running} onClick={() => action('stop')}><Icon name="stop" size={14} /> Parar</button>
                <Link to="listeners" className="button ghost small"><Icon name="users" size={14} /> Ouvintes</Link>
                {user?.role === 'admin' && <button type="button" className="ghost small" onClick={showLog} title="Log do Liquidsoap"><Icon name="info" size={14} /> Log</button>}
              </>
            }
          >
            <div className="np-label"><Icon name="music" size={15} /> Tocando agora</div>
            {station.nowPlaying ? (
              <div className="np np-big">
                <Cover url={station.nowPlaying.coverUrl} size={84} />
                <div style={{ minWidth: 0 }}>
                  <p className="big small">{station.nowPlaying.title}</p>
                  <p className="muted">{station.nowPlaying.artist || '—'}</p>
                  <MiniPlayer slug={station.slug} online={station.running} />
                </div>
              </div>
            ) : (
              <>
                <p className="muted" style={{ margin: '8px 0 0' }}>Nada tocando.</p>
                <MiniPlayer slug={station.slug} online={station.running} />
              </>
            )}
            {station.running && station.live && (
              <p style={{ margin: '14px 0 0' }}>
                <span className="tag accent"><Icon name="mic" size={13} /> {station.live.name} ao vivo</span>{' '}
                <button type="button" className="ghost small" onClick={kick} disabled={busy}>Voltar ao AutoDJ</button>
              </p>
            )}
          </PCard>

          <PCard title="Transmissões" footer={<Link to="settings" className="button ghost small"><Icon name="cog" size={14} /> Configurar streams</Link>}>
            {station.streams.map((s) => (
              <div key={s.mount} className="stream-row">
                <div className="stream-meta">
                  <strong>{s.format.toUpperCase()} {s.bitrate}k</strong>
                  <span className="muted small-text">{s.mount}</span>
                </div>
                <div className="copy-row" style={{ margin: 0 }}>
                  <code>{s.proxyUrl}</code>
                  <CopyButton text={s.proxyUrl} />
                </div>
                <div className="copy-row" style={{ margin: 0 }}>
                  <span className="lbl small-text">link direto</span>
                  <code className="muted" style={{ fontSize: 12 }}>{s.url}</code>
                  <CopyButton text={s.url} label="" />
                </div>
              </div>
            ))}
            <p className="muted small-text" style={{ margin: '10px 0 0' }}>O primeiro link de cada stream passa pelo painel (HTTPS, mesma porta do site): funciona atrás do Cloudflare ou de outro proxy, sem abrir portas. O link direto usa a porta do stream e só funciona se ela estiver aberta e o endereço não passar pelo proxy.</p>
          </PCard>

          <PCard title="Páginas públicas" badge="Habilitado" tone="on">
            <div className="copy-row" style={{ margin: 0 }}>
              <span className="lbl">Player público</span>
              <code>{publicUrl}</code>
              <CopyButton text={publicUrl} />
              <a className="button ghost small" href={publicUrl} target="_blank" rel="noreferrer"><Icon name="link" size={14} /> Abrir</a>
            </div>
          </PCard>

          <section className="pcard">
            <header className="pcard-hd">
              <h3>Últimas músicas</h3>
              <label className="row" style={{ margin: 0, gap: 8 }}>
                <span className="small-text" style={{ opacity: 0.85 }}>Mostrar</span>
                <select value={shown} onChange={(e) => changeShown(Number(e.target.value))}>
                  {[5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </header>
            {history.length === 0 ? (
              <Empty icon="music" title="Nada tocou ainda" text="Quando a estação entrar no ar, o histórico aparece aqui." />
            ) : (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {history.slice(0, shown).map((h, i) => (
                      <tr key={i}>
                        <td><span className="row" style={{ margin: 0, flexWrap: 'nowrap' }}><Cover url={h.coverUrl} size={36} />{h.artist ? <span className="muted">{h.artist} — </span> : null}{h.title}</span></td>
                        <td className="muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{new Date(h.played_at + 'Z').toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="dash-col">
          <PCard
            title="Pedidos de músicas"
            badge={station.requestsEnabled ? 'Habilitado' : 'Desabilitado'}
            tone={station.requestsEnabled ? 'on' : 'off'}
            footer={
              <>
                <Link to="requests" className="button ghost small"><Icon name="heart" size={14} /> Ver pedidos</Link>
                <Link to="edit" className="button ghost small"><Icon name="edit" size={14} /> {station.requestsEnabled ? 'Configurar' : 'Habilitar'}</Link>
              </>
            }
          >
            {!station.requestsEnabled ? (
              <p className="muted" style={{ margin: 0 }}>Os ouvintes não podem pedir músicas. Habilite em Editar estação.</p>
            ) : pending.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>Nenhum pedido pendente.</p>
            ) : (
              pending.slice(0, 5).map((r) => (
                <div key={r.id} className="req-item" style={{ marginBottom: 6 }}>
                  <span className="req-ico"><Icon name="music" size={16} /></span>
                  <span className="req-txt">
                    <strong>{r.title}</strong>
                    <small>{r.artist || '—'} · {new Date(r.createdAt.replace(' ', 'T') + 'Z').toLocaleTimeString()}</small>
                  </span>
                  <span className="req-state queued">{r.status === 'waiting' ? 'Agendado' : 'Na fila'}</span>
                </div>
              ))
            )}
          </PCard>

          <PCard
            title="Streamers/DJs"
            badge={station.liveEnabled ? 'Habilitado' : 'Desabilitado'}
            tone={station.liveEnabled ? 'on' : 'off'}
            footer={
              <>
                <Link to="djs" className="button ghost small"><Icon name="mic" size={14} /> Gerenciar</Link>
                {station.live && <button type="button" className="ghost small" onClick={kick} disabled={busy}>Voltar ao AutoDJ</button>}
              </>
            }
          >
            <p style={{ margin: 0 }}>
              {station.live ? <><span className="tag accent"><Icon name="mic" size={13} /> {station.live.name} ao vivo</span></> : <span className="muted">AutoDJ no ar. Nenhum DJ transmitindo agora.</span>}
            </p>
          </PCard>

          <PCard
            title="Serviço de transmissão"
            badge={station.running ? 'Executando' : 'Parado'}
            tone={station.running ? 'on' : 'off'}
            footer={
              <>
                <button type="button" className="ghost small" onClick={() => setShowCreds((v) => !v)}>{showCreds ? 'Ocultar credenciais' : 'Mostrar credenciais'}</button>
                <button type="button" className="ghost small" disabled={busy || !station.running} onClick={() => action('restart')}><Icon name="refresh" size={14} /> Reiniciar</button>
                <button type="button" className="ghost small danger-text" disabled={busy || !station.running} onClick={() => action('stop')}><Icon name="stop" size={14} /> Parar</button>
              </>
            }
          >
            {station.dj ? (
              <div className="kv">
                <div><span>DJ ao vivo (direto)</span><span><code>{station.dj.host}:{station.dj.port}{station.dj.mount}</code> <CopyButton text={`${station.dj.host}:${station.dj.port}${station.dj.mount}`} label="" /></span></div>
                <div><span>Usuário</span><span><code>{station.dj.username}</code></span></div>
                <div><span>Senha</span><span><code>{showCreds ? station.dj.password : '••••••••'}</code> <CopyButton text={station.dj.password} label="" /></span></div>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Sem DJ ao vivo configurado.</p>
            )}
            <p className="muted small-text" style={{ margin: '10px 0 0' }}>A conexão do DJ vai direto na porta do Liquidsoap (não passa pelo proxy). Com Cloudflare, use o IP do servidor ou um subdomínio “somente DNS”, ou defina <code>PUBLIC_HOST</code> no servidor.</p>
          </PCard>
        </div>
      </div>

      <Modal open={logOpen} title="Log do Liquidsoap" onClose={() => setLogOpen(false)} size="lg" footer={<button type="button" onClick={showLog}>Atualizar</button>}>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, maxHeight: '60vh', overflow: 'auto', margin: 0 }}>{`Fila de pedidos do Liquidsoap (requests.queue): ${queue.trim() || '(vazia)'}\n\n${log}`}</pre>
      </Modal>
    </>
  );
}
