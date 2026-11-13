import { all, get, run, type StationRow } from '../db.js';

/**
 * Cache do AutoCue: a análise de cada música (onde começa e termina de verdade, fades, sobreposição, volume) é a parte mais
 * pesada do Liquidsoap. Na primeira vez que a música toca, o Liquidsoap avisa o resultado e ele fica salvo aqui; nas próximas
 * vezes o painel entrega esses valores junto com a faixa (annotate) e o Liquidsoap NÃO analisa o arquivo de novo.
 * Desliga com AUTOCUE_CACHE=false (volta a analisar sempre).
 */
export const cueCacheOn = () => process.env.AUTOCUE_CACHE !== 'false';

/** Chaves que o AutoCue produz (o Liquidsoap pula a análise quando o início/fim já vêm na faixa, então guardamos o conjunto todo). */
export const CUE_KEYS = [
  'liq_amplify',
  'liq_cue_in',
  'liq_cue_out',
  'liq_cross_start_duration',
  'liq_cross_max_start_duration',
  'liq_cross_end_duration',
  'liq_fade_in',
  'liq_fade_out',
  'liq_fade_out_start_next',
  'liq_fade_out_delay',
  'liq_fade_in_type',
  'liq_fade_in_curve',
  'liq_fade_out_type',
  'liq_fade_out_curve',
] as const;

/** Só valores simples (números, "dB", nomes de curva): nada que quebre o annotate. */
const safeValue = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 40) return false;
  for (const c of v) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || ' .+-:_'.includes(c))) return false;
  return true;
};

/** Guarda o resultado da análise (só se vier o início ou o fim da música). */
export function saveCue(mediaId: number, raw: Record<string, unknown>): boolean {
  const data: Record<string, string> = {};
  for (const k of CUE_KEYS) if (safeValue(raw[k])) data[k] = raw[k] as string;
  if (!data.liq_cue_in && !data.liq_cue_out) return false;
  run(
    'INSERT INTO media_cue (media_id, data) VALUES (?, ?) ON CONFLICT(media_id) DO UPDATE SET data = excluded.data, created_at = datetime(\'now\')',
    mediaId,
    JSON.stringify(data),
  );
  return true;
}

/** Texto do annotate com os valores salvos (termina em vírgula), ou '' se não há. O rf_cue avisa que não precisa guardar de novo. */
function toAnnotation(json: string | undefined): string {
  if (!json) return '';
  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of CUE_KEYS) if (safeValue(data[k])) parts.push(`${k}="${data[k]}"`);
    return parts.length ? `${parts.join(',')},rf_cue="1",` : '';
  } catch {
    return '';
  }
}

/** Valores salvos de todas as músicas da estação (para montar as playlists de uma vez). */
export function cueMap(st: StationRow): Map<number, string> {
  const map = new Map<number, string>();
  if (!cueCacheOn() || !st.autocue) return map;
  for (const r of all<{ media_id: number; data: string }>('SELECT c.media_id, c.data FROM media_cue c JOIN media m ON m.id = c.media_id WHERE m.station_id = ?', st.id)) {
    const a = toAnnotation(r.data);
    if (a) map.set(r.media_id, a);
  }
  return map;
}

export function cueFor(st: StationRow, mediaId: number): string {
  if (!cueCacheOn() || !st.autocue) return '';
  return toAnnotation(get<{ data: string }>('SELECT data FROM media_cue WHERE media_id = ?', mediaId)?.data);
}

export function clearCueCache(stationId: number): number {
  return run('DELETE FROM media_cue WHERE media_id IN (SELECT id FROM media WHERE station_id = ?)', stationId).changes as number;
}
