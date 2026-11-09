import { useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { CopyButton, Cover, Empty, Icon, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

interface Hist {
  title: string;
  artist: string;
  played_at: string;
  coverUrl?: string | null;
}

export default function Dashboard() {
  const { station, reload } = useOutletContext<StationCtx>();
  const { toast, confirm } = useUi();
  const [history, setHistory] = useState<Hist[]>([]);
  const [busy, setBusy] = useState(false);
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

  return (
    <>
      {station.engine === 'native' && (
        <div className="card notice">
          <strong>Modo simples (sem Icecast/Liquidsoap).</strong> Toca só arquivos MP3. Sem playlists, toca a biblioteca inteira em ordem aleatória.
          Não há DJ ao vivo, crossfade, normalização nem gravação, e os streams extras repetem o principal. Instale o Icecast e o Liquidsoap (ou use a imagem Docker) para o modo completo.
        </div>
      )}

      {station.audioWarning && (
        <div className="card notice" style={{ whiteSpace: 'pre-wrap' }}>
          <strong>Processador de áudio:</strong> {station.audioWarning}
        </div>
      )}

      <div className="stat-grid">
        <div className="card">
          <div className="stat-label"><Icon name="radio" /> Status</div>
          <div style={{ margin: '10px 0 14px' }}>
            <span className={`badge ${station.running ? 'on' : 'off'}`}>{station.running ? 'no ar' : 'parada'}</span>
            {station.running && station.live && (
              <span className="tag accent" style={{ marginLeft: 8 }}>
                <Icon name="mic" size={13} /> {station.live.name} ao vivo
              </span>
            )}
            {station.running && station.live && (
              <button className="ghost small" style={{ marginLeft: 8 }} onClick={kick} disabled={busy}>Voltar ao AutoDJ</button>
            )}
          </div>
          <div className="row" style={{ marginBottom: 0 }}>
            <button disabled={busy || station.running} onClick={() => action('start')}><Icon name="play" /> Iniciar</button>
            <button disabled={busy || !station.running} onClick={() => action('restart')} className="ghost"><Icon name="refresh" /> Reiniciar</button>
            <button disabled={busy || !station.running} onClick={() => action('stop')} className="danger"><Icon name="stop" /> Parar</button>
          </div>
        </div>
        <div className="card">
          <div className="stat-label"><Icon name="users" /> Ouvintes agora</div>
          <p className="big">{station.listeners}</p>
          <Link to="../listeners" className="small-text">Ver quem está ouvindo →</Link>
        </div>
        <div className="card">
          <div className="stat-label"><Icon name="music" /> Tocando agora</div>
          {station.nowPlaying ? (
            <div className="np">
              <Cover url={station.nowPlaying.coverUrl} size={64} />
              <div style={{ minWidth: 0 }}>
                <p className="big small">{station.nowPlaying.title}</p>
                <p className="muted">{station.nowPlaying.artist || '—'}</p>
              </div>
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 10 }}>Nada tocando.</p>
          )}
        </div>
      </div>

      <div className="card section">
        <div className="section-title"><h3>Links de transmissão</h3></div>
        {station.streams.map((s) => (
          <div key={s.mount} style={{ marginBottom: 10 }}>
            <div className="copy-row" style={{ marginBottom: 2 }}>
              <span className="lbl">{s.format.toUpperCase()} {s.bitrate}k</span>
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
        <p className="muted small-text">O primeiro link de cada stream passa pelo painel (HTTPS, mesma porta do site): funciona com domínio atrás do Cloudflare ou outro proxy, sem abrir portas. O link direto usa a porta do stream e só funciona se ela estiver aberta e o endereço não passar pelo proxy (no Cloudflare, use um subdomínio “somente DNS”, nuvem cinza).</p>
        {station.dj && (
          <>
            <div className="copy-row">
              <span className="lbl">DJ ao vivo (direto)</span>
              <code>{station.dj.host}:{station.dj.port}{station.dj.mount}</code>
              <CopyButton text={`${station.dj.host}:${station.dj.port}${station.dj.mount}`} />
            </div>
            <div className="copy-row">
              <span className="lbl">Usuário / senha</span>
              <code>{station.dj.username}</code>
              <code>{station.dj.password}</code>
              <CopyButton text={station.dj.password} label="Copiar senha" />
            </div>
            <p className="muted small-text">A conexão do DJ vai direto na porta do Liquidsoap (não passa pelo proxy). Com Cloudflare, o DJ deve usar o IP do servidor ou um subdomínio “somente DNS”; ou defina <code>PUBLIC_HOST</code> no servidor para mostrar esse endereço aqui.</p>
          </>
        )}
      </div>

      <div className="card tight">
        <div className="section-title" style={{ padding: '18px 20px 6px', margin: 0 }}>
          <h3>Últimas músicas</h3>
          <label className="row" style={{ margin: 0, gap: 8 }}>
            <span className="muted small-text">Mostrar</span>
            <select value={shown} onChange={(e) => changeShown(Number(e.target.value))}>
              {[5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
        {history.length === 0 ? (
          <Empty icon="music" title="Nada tocou ainda" text="Quando a estação entrar no ar, o histórico aparece aqui." />
        ) : (
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
        )}
      </div>
    </>
  );
}
