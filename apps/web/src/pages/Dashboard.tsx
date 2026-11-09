import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import type { StationCtx } from './StationLayout';

interface Hist {
  title: string;
  artist: string;
  played_at: string;
}

export default function Dashboard() {
  const { station, reload } = useOutletContext<StationCtx>();
  const [history, setHistory] = useState<Hist[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Hist[]>(`/api/stations/${station.id}/history`).then(setHistory);
  }, [station.id, station.nowPlaying?.playedAt]);

  async function action(a: 'start' | 'stop' | 'restart') {
    setBusy(true);
    setError('');
    try {
      await api(`/api/stations/${station.id}/${a}`, { method: 'POST' });
      await reload();
    } catch (e) {
      setError((e as Error).message);
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
      <div className="grid">
        <div className="card">
          <h3>Status</h3>
          <span className={`badge ${station.running ? 'on' : 'off'}`}>{station.running ? 'no ar' : 'parada'}</span>
          {station.running && station.live && (
            <p style={{ marginTop: 8 }}>
              🎙 <strong>{station.live.name}</strong> está ao vivo
              <span className="muted"> desde {new Date(station.live.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </p>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button disabled={busy || station.running} onClick={() => action('start')}>Iniciar</button>
            <button disabled={busy || !station.running} onClick={() => action('restart')} className="ghost">Reiniciar</button>
            <button disabled={busy || !station.running} onClick={() => action('stop')} className="danger">Parar</button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="card">
          <h3>Ouvintes</h3>
          <p className="big">{station.listeners}</p>
        </div>
        <div className="card">
          <h3>Tocando agora</h3>
          {station.nowPlaying ? (
            <>
              <p className="big small">{station.nowPlaying.title}</p>
              <p className="muted">{station.nowPlaying.artist}</p>
            </>
          ) : (
            <p className="muted">—</p>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Links</h3>
        {station.streams.map((s) => (
          <p key={s.mount}>Stream {s.format.toUpperCase()} {s.bitrate}k: <code>{s.url}</code></p>
        ))}
        {station.dj && (
          <p>
            DJ ao vivo: <code>{station.dj.host}:{station.dj.port}{station.dj.mount}</code> · usuário <code>{station.dj.username}</code> · senha <code>{station.dj.password}</code>
          </p>
        )}
      </div>

      <div className="card">
        <h3>Últimas músicas</h3>
        <table>
          <tbody>
            {history.map((h, i) => (
              <tr key={i}>
                <td>{h.artist ? `${h.artist} — ` : ''}{h.title}</td>
                <td className="muted">{new Date(h.played_at + 'Z').toLocaleString()}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td className="muted">Nada tocou ainda.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
