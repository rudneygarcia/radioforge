import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { CopyButton, Empty, Icon, useUi } from '../ui';
import type { StationCtx } from './StationLayout';

interface Hist {
  title: string;
  artist: string;
  played_at: string;
}

export default function Dashboard() {
  const { station, reload } = useOutletContext<StationCtx>();
  const { toast, confirm } = useUi();
  const [history, setHistory] = useState<Hist[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Hist[]>(`/api/stations/${station.id}/history`).then(setHistory);
  }, [station.id, station.nowPlaying?.playedAt]);

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
        </div>
        <div className="card">
          <div className="stat-label"><Icon name="music" /> Tocando agora</div>
          {station.nowPlaying ? (
            <>
              <p className="big small">{station.nowPlaying.title}</p>
              <p className="muted">{station.nowPlaying.artist || '—'}</p>
            </>
          ) : (
            <p className="muted" style={{ marginTop: 10 }}>Nada tocando.</p>
          )}
        </div>
      </div>

      <div className="card section">
        <div className="section-title"><h3>Links de transmissão</h3></div>
        {station.streams.map((s) => (
          <div className="copy-row" key={s.mount}>
            <span className="lbl">{s.format.toUpperCase()} {s.bitrate}k</span>
            <code>{s.url}</code>
            <CopyButton text={s.url} />
          </div>
        ))}
        <p className="muted small-text">Use estes endereços em players externos (VLC, apps). No navegador, use o player público.</p>
        {station.dj && (
          <>
            <div className="copy-row">
              <span className="lbl">DJ ao vivo</span>
              <code>{station.dj.host}:{station.dj.port}{station.dj.mount}</code>
              <CopyButton text={`${station.dj.host}:${station.dj.port}${station.dj.mount}`} />
            </div>
            <div className="copy-row">
              <span className="lbl">Usuário / senha</span>
              <code>{station.dj.username}</code>
              <code>{station.dj.password}</code>
              <CopyButton text={station.dj.password} label="Copiar senha" />
            </div>
          </>
        )}
      </div>

      <div className="card tight">
        <div className="section-title" style={{ padding: '18px 20px 6px', margin: 0 }}><h3>Últimas músicas</h3></div>
        {history.length === 0 ? (
          <Empty icon="music" title="Nada tocou ainda" text="Quando a estação entrar no ar, o histórico aparece aqui." />
        ) : (
          <table>
            <tbody>
              {history.map((h, i) => (
                <tr key={i}>
                  <td>{h.artist ? <span className="muted">{h.artist} — </span> : null}{h.title}</td>
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
