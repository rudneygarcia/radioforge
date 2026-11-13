import { useEffect, useState } from 'react';
import { api } from '../api';
import { useUi } from '../ui';

interface Fx {
  eq: string;
  width: string;
  multiband: boolean;
  support: { eq: boolean; width: boolean; multiband: boolean };
  eqOptions: { key: string; label: string }[];
  widthOptions: { key: string; label: string }[];
}

/** Etapas extras do processador (equalizador, largura estéreo, multibanda). Valem após reiniciar a rádio. */
export default function AudioFx({ stationId, disabled, running }: { stationId: number; disabled: boolean; running: boolean }) {
  const { toast } = useUi();
  const [fx, setFx] = useState<Fx | null>(null);
  const [saved, setSaved] = useState(false);
  const base = `/api/stations/${stationId}/audio-fx`;

  useEffect(() => {
    api<Fx>(base).then(setFx).catch((e) => toast((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  async function save(next: Fx) {
    setFx(next);
    try {
      await api(base, { method: 'PUT', body: { eq: next.eq, width: next.width, multiband: next.multiband } });
      setSaved(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  if (!fx) return null;
  const off = disabled;
  return (
    <div className="fields" style={{ marginTop: 12 }}>
      <h4 style={{ margin: '8px 0 0' }}>Etapas extras</h4>
      <p className="muted" style={{ margin: 0 }}>Entram antes do compressor e do limitador. Cada etapa só funciona se esta versão do Liquidsoap aceitar; senão ela é ignorada e o aviso aparece acima.</p>
      <label className="field">
        <span>Equalizador</span>
        <select value={fx.eq} onChange={(e) => void save({ ...fx, eq: e.target.value })} disabled={off || !fx.support.eq}>
          {fx.eqOptions.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        {!fx.support.eq && <small className="hint">Indisponível nesta versão do Liquidsoap.</small>}
      </label>
      <label className="field">
        <span>Estéreo</span>
        <select value={fx.width} onChange={(e) => void save({ ...fx, width: e.target.value })} disabled={off || !fx.support.width}>
          {fx.widthOptions.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
        {!fx.support.width && <small className="hint">Indisponível nesta versão do Liquidsoap.</small>}
      </label>
      <label className="field">
        <span>Compressor multibanda</span>
        <select value={fx.multiband ? 'on' : 'off'} onChange={(e) => void save({ ...fx, multiband: e.target.value === 'on' })} disabled={off || !fx.support.multiband}>
          <option value="off">Desligado</option>
          <option value="on">Ligado (graves, médios e agudos separados; usa mais CPU)</option>
        </select>
        {!fx.support.multiband && <small className="hint">Indisponível nesta versão do Liquidsoap.</small>}
      </label>
      {saved && <div className="card notice">Salvo. {running ? 'Reinicie a rádio para aplicar.' : 'Vale na próxima vez que a rádio ligar.'}</div>}
    </div>
  );
}
