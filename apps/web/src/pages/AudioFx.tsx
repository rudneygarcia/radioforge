import { useEffect, useState } from 'react';
import { api } from '../api';
import { useUi } from '../ui';

interface Fx {
  multiband: number;
  support: { multiband: boolean };
  levels: { level: number; label: string }[];
}

/** Compressor multibanda (plugin LSP). Vale após reiniciar a rádio. */
export default function AudioFx({ stationId, disabled, running }: { stationId: number; disabled: boolean; running: boolean }) {
  const { toast } = useUi();
  const [fx, setFx] = useState<Fx | null>(null);
  const [saved, setSaved] = useState(false);
  const base = `/api/stations/${stationId}/audio-fx`;

  useEffect(() => {
    api<Fx>(base).then(setFx).catch((e) => toast((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  async function save(level: number) {
    if (!fx) return;
    setFx({ ...fx, multiband: level });
    try {
      await api(base, { method: 'PUT', body: { multiband: level } });
      setSaved(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  if (!fx) return null;
  return (
    <div className="fields" style={{ marginTop: 12 }}>
      <label className="field">
        <span>Compressor multibanda (plugin LSP)</span>
        <select value={fx.multiband} onChange={(e) => void save(Number(e.target.value))} disabled={disabled || !fx.support.multiband}>
          {fx.levels.map((o) => (
            <option key={o.level} value={o.level}>{o.label}</option>
          ))}
        </select>
        <small className="hint">
          {fx.support.multiband
            ? 'Comprime graves, médios e agudos separadamente, antes do compressor e do limitador (que continuam no fim). Usa mais CPU: compare antes de deixar fixo.'
            : 'Indisponível: o plugin não foi encontrado ou o Liquidsoap não o aceitou.'}
        </small>
      </label>
      {saved && <div className="card notice">Salvo. {running ? 'Reinicie a rádio para aplicar.' : 'Vale na próxima vez que a rádio ligar.'}</div>}
    </div>
  );
}
