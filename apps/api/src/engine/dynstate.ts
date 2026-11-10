/** Última vez que o Liquidsoap pediu uma faixa à API (rotação pela API): mostra se ela está funcionando. */
const lastAsk = new Map<number, number>();
export const markAsk = (stationId: number) => lastAsk.set(stationId, Date.now());
export const lastNextCall = (stationId: number) => lastAsk.get(stationId) ?? 0;
