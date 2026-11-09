import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { CopyButton, Empty, Icon } from '../ui';
import type { StationCtx } from './StationLayout';

interface LiveListener {
  id: string;
  ip: string;
  country: string;
  countryName: string;
  flag: string;
  player: string;
  device: string;
  os: string;
  userAgent: string;
  seconds: number;
  mount: string;
}
interface Data {
  running: boolean;
  icecastError: string | null;
  total: number;
  unique: number;
  countries: { name: string; count: number }[];
  devices: { name: string; count: number }[];
  players: { name: string; count: number }[];
  items: LiveListener[];
}

const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`);

export default function ListenersPage() {
  const { station } = useOutletContext<StationCtx>();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return; // não consulta com a aba escondida
      api<Data>(`/api/stations/${station.id}/listeners`)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setUpdated(new Date());
          setError('');
        })
        .catch((e) => alive && setError((e as Error).message));
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [station.id]);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <div className="card skeleton" style={{ height: 160 }} />;

  const multi = station.streams.length > 1;
  return (
    <>
      {data.icecastError && (
        <div className="card notice">
          <strong>Aviso:</strong> não foi possível consultar o Icecast ({data.icecastError}). Os ouvintes que entram pelo player do site e pelos links do painel aparecem normalmente; só quem usa o <em>link direto</em> (porta do stream) pode não aparecer.
        </div>
      )}
      <div className="stat-grid">
        <div className="card">
          <div className="stat-label"><Icon name="users" /> Conectados agora</div>
          <p className="big">{data.total}</p>
          <p className="muted small-text">{data.unique} {data.unique === 1 ? 'IP diferente' : 'IPs diferentes'}</p>
        </div>
        <div className="card">
          <div className="stat-label">País</div>
          <div className="chips" style={{ marginTop: 10 }}>
            {data.countries.length === 0 ? <span className="muted">—</span> : data.countries.slice(0, 6).map((c) => <span className="tag" key={c.name}>{c.name} · {c.count}</span>)}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Aparelho</div>
          <div className="chips" style={{ marginTop: 10 }}>
            {data.devices.length === 0 ? <span className="muted">—</span> : data.devices.map((c) => <span className="tag" key={c.name}>{c.name} · {c.count}</span>)}
          </div>
        </div>
      </div>

      <div className="card tight">
        <div className="section-title" style={{ padding: '18px 20px 6px', margin: 0 }}>
          <h3>Ouvintes conectados</h3>
          <span className="muted small-text">{updated ? `atualiza sozinho a cada 5 s · ${updated.toLocaleTimeString()}` : ''}</span>
        </div>
        {!data.running ? (
          <Empty icon="radio" title="A estação está parada" text="Inicie a estação para ver quem está ouvindo." />
        ) : data.items.length === 0 ? (
          <Empty icon="users" title="Ninguém ouvindo agora" text="Quando alguém abrir o player ou o link do stream, aparece aqui na hora." />
        ) : (
          <table>
            <thead>
              <tr><th>IP</th><th>Local</th><th>Aparelho</th><th>Player</th>{multi && <th className="hide-sm">Stream</th>}<th>Conectado há</th></tr>
            </thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id}>
                  <td><code>{l.ip}</code> <CopyButton text={l.ip} label="" /></td>
                  <td>{l.flag} {l.countryName}</td>
                  <td title={l.userAgent}>{l.device}{l.os !== '—' ? <span className="muted"> · {l.os}</span> : null}</td>
                  <td>{l.player}</td>
                  {multi && <td className="muted hide-sm">{l.mount}</td>}
                  <td className="muted">{dur(l.seconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small-text" style={{ marginTop: 12 }}>
        Só tempo real: os IPs não são guardados (os relatórios guardam apenas um identificador anônimo e o país). A localização é só o <strong>país</strong>; passe o mouse no aparelho para ver o user-agent completo. Cada conexão conta como um ouvinte; quem abre em duas abas conta duas vezes.
      </p>
    </>
  );
}
