import type { StationRow } from '../db.js';

/**
 * Com o "front" de portas ligado (modo Icecast+Liquidsoap), a porta pública da estação (stream_port) é atendida pelo painel
 * — que aceita HTTP e HTTPS na mesma porta e repassa para o Icecast — e o Icecast de verdade escuta só em 127.0.0.1,
 * numa porta interna (stream_port + 10000). Tudo que fala direto com o Icecast usa icePort().
 */
let front = false;
export const setPortFront = (on: boolean) => void (front = on);
export const portFrontOn = () => front;
export const icePort = (st: Pick<StationRow, 'stream_port'>) => (front ? st.stream_port + 10000 : st.stream_port);
