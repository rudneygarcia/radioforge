import type { MediaRow, StationRow } from '../db.js';

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Palavras/trechos configurados na estação (uma por linha ou separadas por vírgula/;). */
export function hiddenWords(st: Pick<StationRow, 'hidden_words'>): string[] {
  return (st.hidden_words ?? '')
    .split(/[\n,;]+/)
    .map((w) => norm(w.trim()))
    .filter((w) => w.length >= 2);
}

/** A faixa contém alguma palavra oculta no título, artista, álbum ou nome do arquivo? Então ela toca sem enviar metadados. */
export function isHiddenTrack(st: Pick<StationRow, 'hidden_words'>, m: Pick<MediaRow, 'title' | 'artist' | 'album' | 'original_name'>): boolean {
  const words = hiddenWords(st);
  if (!words.length) return false;
  const hay = norm(`${m.title} ${m.artist} ${m.album} ${m.original_name}`);
  return words.some((w) => hay.includes(w));
}
