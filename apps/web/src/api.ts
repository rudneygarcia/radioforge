const TOKEN_KEY = 'rf_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

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
}
export interface NowPlaying {
  title: string;
  artist: string;
  playedAt: string;
}
export interface MountCfg {
  mount: string;
  format: 'mp3' | 'ogg';
  bitrate: number;
}
export interface StreamInfo extends MountCfg {
  url: string;
}
export interface Station {
  id: number;
  name: string;
  slug: string;
  description: string;
  format: 'mp3' | 'ogg';
  bitrate: number;
  liveEnabled: boolean;
  requestsEnabled: boolean;
  autostart: boolean;
  crossfadeSeconds: number;
  normalize: boolean;
  recordLive: boolean;
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
}
export interface Recording {
  name: string;
  size: number;
  modifiedAt: string;
}
export interface Playlist {
  id: number;
  name: string;
  enabled: boolean;
  mode: 'shuffle' | 'sequential';
  weight: number;
  everySongs: number;
  scheduleEnabled: boolean;
  startTime: string;
  endTime: string;
  days: number[];
  mediaIds: number[];
}
