import { useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api, downloadFile } from '../api';
import type { StationCtx } from './StationLayout';

interface Report {
  days: number;
  bucket: 'hour' | 'day';
  summary: { sessions: number; uniqueListeners: number; listeningHours: number; avgSessionMinutes: number; peakListeners: number };
  timeline: { t: string; avg: number; max: number }[];
  countries: { name: string; sessions: number; listeners: number }[];
  players: { name: string; sessions: number; listeners: number }[];
  hours: { hour: number; sessions: number }[];
}

const countryName = (code: string) => {
  if (code === '??') return 'Desconhecido';
  try {
    return new Intl.DisplayNames(['pt-BR'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Topo do eixo com 4 intervalos de valor inteiro e "redondo" (ouvintes são contagens). */
function niceMax(v: number) {
  const raw = Math.max(1, Math.ceil(v / 4));
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 3 ? 3 : m <= 4 ? 4 : m <= 5 ? 5 : m <= 6 ? 6 : m <= 8 ? 8 : 10) * p;
  return step * 4;
}

const W = 800;
const H = 260;
const M = { l: 40, r: 12, t: 12, b: 28 };

function formatT(t: string, bucket: 'hour' | 'day', days = 1) {
  const d = new Date(t.replace(' ', 'T') + 'Z');
  const date = d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
  if (bucket === 'day') return date;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return days > 1 ? `${date} ${time}` : time;
}

function LineChart({ data, bucket, days }: { data: Report['timeline']; bucket: 'hour' | 'day'; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const top = niceMax(Math.max(...data.map((d) => d.max), 1));
  const x = (i: number) => M.l + (data.length === 1 ? (W - M.l - M.r) / 2 : (i / (data.length - 1)) * (W - M.l - M.r));
  const y = (v: number) => M.t + (1 - v / top) * (H - M.t - M.b);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.avg).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const ticks = [0, 1, 2, 3, 4].map((k) => (top / 4) * k);
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));

  function move(e: React.MouseEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - M.l) / (W - M.l - M.r)) * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, i)));
  }

  const h = hover !== null ? data[hover] : null;
  return (
    <div className="chart" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Ouvintes ao longo do tempo">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} className="gridline" />
            <text x={M.l - 8} y={y(v) + 4} textAnchor="end" className="axis">{Math.round(v)}</text>
          </g>
        ))}
        {data.length > 1 ? (
          <>
            <path d={area} className="area" />
            <path d={line} className="line" />
          </>
        ) : (
          <circle cx={x(0)} cy={y(data[0].avg)} r={5} className="dot" />
        )}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.t} x={x(i)} y={H - 8} textAnchor={x(i) > W - 70 ? 'end' : x(i) < M.l + 40 ? 'start' : 'middle'} className="axis">{formatT(d.t, bucket, days)}</text>
          ) : null,
        )}
        {hover !== null && h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={H - M.b} className="cross" />
            <circle cx={x(hover)} cy={y(h.avg)} r={5} className="dot" />
          </g>
        )}
        <rect x={M.l} y={M.t} width={W - M.l - M.r} height={H - M.t - M.b} fill="transparent" onMouseMove={move} onMouseLeave={() => setHover(null)} />
      </svg>
      {hover !== null && h && (
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{formatT(h.t, bucket, days)}</strong>
          <div>Média: {h.avg} ouvintes</div>
          <div>Pico: {h.max}</div>
        </div>
      )}
    </div>
  );
}

function BarList({ rows, label }: { rows: { name: string; sessions: number; listeners: number }[]; label: (n: string) => string }) {
  const max = Math.max(...rows.map((r) => r.sessions), 1);
  if (rows.length === 0) return <p className="muted">Sem dados no período.</p>;
  return (
    <div className="barlist">
      {rows.map((r) => (
        <div key={r.name} className="barrow" title={`${label(r.name)}: ${r.sessions} sessões, ${r.listeners} ouvintes únicos`}>
          <span className="barname">{label(r.name)}</span>
          <span className="bartrack"><span className="barfill" style={{ width: `${(r.sessions / max) * 100}%` }} /></span>
          <span className="barval">{r.sessions}</span>
        </div>
      ))}
    </div>
  );
}

function HourChart({ hours }: { hours: Report['hours'] }) {
  const max = Math.max(...hours.map((h) => h.sessions), 1);
  const bw = (W - M.l - M.r) / 24;
  return (
    <svg viewBox={`0 0 ${W} 180`} role="img" aria-label="Sessões por hora do dia">
      {hours.map((h) => {
        const bh = (h.sessions / max) * 130;
        return (
          <g key={h.hour}>
            <rect x={M.l + h.hour * bw + 2} y={150 - bh} width={bw - 4} height={Math.max(bh, h.sessions ? 2 : 0)} rx={3} className="bar">
              <title>{`${String(h.hour).padStart(2, '0')}h: ${h.sessions} sessões`}</title>
            </rect>
            {h.hour % 3 === 0 && <text x={M.l + h.hour * bw + bw / 2} y={170} textAnchor="middle" className="axis">{String(h.hour).padStart(2, '0')}h</text>}
          </g>
        );
      })}
    </svg>
  );
}

export default function ReportsPage() {
  const { station } = useOutletContext<StationCtx>();
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<Report | null>(null);
  const [table, setTable] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    api<Report>(`/api/stations/${station.id}/reports?days=${days}&tzOffset=${new Date().getTimezoneOffset()}`)
      .then(setReport)
      .catch((e) => setError((e as Error).message));
  }, [station.id, days]);

  const empty = useMemo(() => !report || (report.timeline.length === 0 && report.summary.sessions === 0), [report]);

  if (error) return <p className="error">{error}</p>;
  if (!report) return <p className="muted">Carregando…</p>;
  const s = report.summary;

  return (
    <>
      <div className="row between">
        <h3>Relatórios</h3>
        <div className="row">
          <button
            className="ghost small"
            onClick={() =>
              downloadFile(`/api/stations/${station.id}/reports?days=${days}&format=csv`, `relatorio-${days}d.csv`).catch((e) =>
                setError((e as Error).message),
              )
            }
          >
            Exportar CSV
          </button>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Últimas 24 horas</option>
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
          </select>
        </div>
      </div>

      <div className="grid">
        <div className="card"><p className="muted">Ouvintes únicos</p><p className="big">{s.uniqueListeners}</p></div>
        <div className="card"><p className="muted">Sessões de escuta</p><p className="big">{s.sessions}</p></div>
        <div className="card"><p className="muted">Horas ouvidas</p><p className="big">{s.listeningHours}</p></div>
        <div className="card"><p className="muted">Pico de ouvintes</p><p className="big">{s.peakListeners}</p></div>
      </div>
      <p className="muted">Duração média por sessão: {s.avgSessionMinutes} min</p>

      {empty && (
        <div className="card">
          <p className="muted">Ainda não há dados neste período. As amostras são coletadas a cada minuto enquanto a estação está no ar, e as sessões entram quando o ouvinte desconecta.</p>
        </div>
      )}

      <div className="card">
        <div className="row between">
          <h3>Ouvintes ao longo do tempo</h3>
          <button className="ghost small" onClick={() => setTable(!table)}>{table ? 'Ver gráfico' : 'Ver como tabela'}</button>
        </div>
        {report.timeline.length === 0 ? (
          <p className="muted">Sem amostras no período.</p>
        ) : table ? (
          <table>
            <thead><tr><th>{report.bucket === 'hour' ? 'Hora' : 'Dia'}</th><th>Média</th><th>Pico</th></tr></thead>
            <tbody>
              {report.timeline.map((r) => (
                <tr key={r.t}><td>{formatT(r.t, report.bucket, report.days)}</td><td>{r.avg}</td><td>{r.max}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <LineChart data={report.timeline} bucket={report.bucket} days={report.days} />
        )}
      </div>

      <div className="grid">
        <div className="card"><h3>Países</h3><BarList rows={report.countries} label={countryName} /></div>
        <div className="card"><h3>Players</h3><BarList rows={report.players} label={(n) => n} /></div>
      </div>

      <div className="card">
        <h3>Sessões por hora do dia</h3>
        <HourChart hours={report.hours} />
      </div>
      <p className="muted">Países identificados com dados GeoLite2 da MaxMind (www.maxmind.com). Os endereços IP não são guardados: só um identificador anônimo e o país.</p>
    </>
  );
}
