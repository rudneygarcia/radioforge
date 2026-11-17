const TOKEN_KEY = 'rf_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

/** Segundos de validade restantes e idade do login (lidos do próprio token, sem consultar o servidor). */
function tokenTimes(t: string | null): { iat: number; exp: number } | null {
  if (!t) return null;
  try {
    const p = JSON.parse(atob(t.split('.')[1].split('-').join('+').split('_').join('/'))) as { iat?: number; exp?: number };
    return p.iat && p.exp ? { iat: p.iat * 1000, exp: p.exp * 1000 } : null;
  } catch {
    return null;
  }
}

let lastActivity = Date.now();
let activeUploads = 0;
let keeperOn = false;
let renewing = false;

/**
 * Mantém o login vivo enquanto a pessoa usa o painel: cada atividade (mouse, teclado, toque, rolagem) ou envio de
 * arquivos em andamento renova o login. Sem atividade por 3 horas o login expira e é preciso entrar de novo.
 * (As consultas automáticas do painel NÃO contam como atividade: só a pessoa.)
 */
export function startSessionKeeper() {
  if (keeperOn) return;
  keeperOn = true;
  const touch = () => {
    lastActivity = Date.now();
  };
  for (const ev of ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel']) window.addEventListener(ev, touch, { passive: true, capture: true });
  const tick = async () => {
    const token = getToken();
    const t = tokenTimes(token);
    if (!token || !t) return;
    if (t.exp <= Date.now()) {
      setToken(null);
      location.href = '/login';
      return;
    }
    const recentlyActive = lastActivity > t.iat || activeUploads > 0; // houve atividade desde que este login foi emitido
    if (recentlyActive && Date.now() - t.iat > 5 * 60_000 && !renewing) {
      renewing = true;
      try {
        const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) setToken(((await r.json()) as { token: string }).token);
      } catch {
        /* sem rede agora: tenta de novo no próximo ciclo */
      } finally {
        renewing = false;
      }
    }
  };
  setInterval(tick, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void tick();
  });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(path, { method: init.method ?? 'GET', headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/api/auth')) {
    setToken(null);
    location.href = '/login';
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Erro ${res.status}`);
  return data as T;
}

/** Baixa um arquivo protegido por login (o token vai no cabeçalho, então não dá para usar um link simples). */
export async function downloadFile(path: string, fallbackName: string) {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Erro ${res.status}`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'user';
  /** O que o usuário pode fazer nas estações (administrador: tudo). */
  permissions: string[];
}
export interface NowPlaying {
  title: string;
  artist: string;
  playedAt: string;
  /** Capa da música (extraída das tags), quando existe. */
  coverUrl?: string | null;
}
export interface MountCfg {
  mount: string;
  format: 'mp3' | 'ogg' | 'aac';
  bitrate: number;
}
export interface StreamInfo extends MountCfg {
  url: string;
  proxyUrl: string;
  /** Link direto por HTTPS na porta da estação (quando o certificado existe). */
  secureUrl?: string | null;
}
export interface Station {
  id: number;
  name: string;
  slug: string;
  description: string;
  mount: string;
  /** Capa (logo) da rádio, quando enviada. */
  coverUrl?: string | null;
  format: 'mp3' | 'ogg' | 'aac';
  bitrate: number;
  historyLimit: number;
  audioPreset: 'off' | 'balanced' | 'loud' | 'master_me';
  audioGain: number;
  audioMasterTarget: number;
  audioWarning: string | null;
  noRepeatMinutes: number;
  liveTimeout: number;
  liveContinue: boolean;
  timeAnnounce: number;
  timeVoice: string;
  autocue: boolean;
  autocueCustom: boolean;
  autocueDuration: number;
  autocueFadeIn: number;
  autocueFadeOut: number;
  jingleOverlap: number;
  jingleGain: number;
  autocueLevel: boolean;
  hiddenWords: string;
  jingleHideName: boolean;
  requestInterval: number;
  requestDelay: number;
  stereoEnabled: boolean;
  stereoPreset: string;
  stereoKeySet: boolean;
  noRepeatArtistMinutes: number;
  streamPort: number;
  autodj: boolean;
  /** Disco onde entram as músicas novas ('' = principal). */
  disk: string;
  timeAnnounceVoice: boolean;
  timezone: string;
  liveEnabled: boolean;
  requestsEnabled: boolean;
  autostart: boolean;
  crossfadeSeconds: number;
  normalize: boolean;
  mounts: MountCfg[];
  streams: StreamInfo[];
  engine: 'liquidsoap' | 'native';
  running: boolean;
  listeners: number;
  nowPlaying: NowPlaying | null;
  live: { name: string; username: string; since: string } | null;
  streamUrl: string;
  dj: { host: string; port: number; mount: string; username: string; password: string } | null;
}
export interface Media {
  id: number;
  title: string;
  artist: string;
  album: string;
  duration: number;
  size: number;
  originalName: string;
  folderId: number | null;
  coverUrl?: string | null;
}
export interface Folder {
  id: number;
  name: string;
  count: number;
}
export interface Webhook {
  id: number;
  name: string;
  type: 'generic' | 'discord';
  url: string;
  secret: string | null;
  events: string[];
  enabled: boolean;
  lastStatus: string;
  lastAt: string;
}
export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  readOnly: boolean;
}
export interface Dj {
  id: number;
  username: string;
  displayName: string;
  enabled: boolean;
  password: string;
  scheduleEnabled: boolean;
  startTime: string;
  endTime: string;
  days: number[];
}
export interface Playlist {
  id: number;
  name: string;
  enabled: boolean;
  mode: 'shuffle' | 'sequential';
  weight: number;
  jingle: boolean;
  isDefault: boolean;
  requestable: boolean;
  everySongs: number;
  everyMinutes: number;
  scheduleEnabled: boolean;
  startTime: string;
  endTime: string;
  days: number[];
  mediaIds: number[];
  folderIds: number[];
  trackCount: number;
}

/**
 * Envia um formulário com arquivos acompanhando o progresso (o fetch não informa o andamento do envio).
 * `abort()` cancela. A promessa rejeita com ApiError (mensagem do servidor) ou Error('cancelado').
 */
export function uploadForm<T = unknown>(path: string, form: FormData, onProgress?: (loaded: number, total: number) => void) {
  const xhr = new XMLHttpRequest();
  activeUploads++; // envio em andamento conta como atividade (o login não expira no meio dele)
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', path);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: unknown = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* resposta sem JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      if (xhr.status === 401 && token) {
        setToken(null);
        location.href = '/login';
      }
      reject(new ApiError(xhr.status, (data as { error?: string }).error ?? `Erro ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão durante o envio'));
    xhr.onabort = () => reject(new Error('Envio cancelado'));
    xhr.send(form);
  });
  const done = () => {
    activeUploads = Math.max(0, activeUploads - 1);
    lastActivity = Date.now();
  };
  promise.then(done, done);
  return { promise, abort: () => xhr.abort() };
}
