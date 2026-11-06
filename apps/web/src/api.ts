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
  mounts: MountCfg[];
  streams: StreamInfo[];
  running: boolean;
  listeners: number;
  nowPlaying: NowPlaying | null;
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
export interface Playlist {
  id: number;
  name: string;
  enabled: boolean;
  mode: 'shuffle' | 'sequential';
  weight: number;
  scheduleEnabled: boolean;
  startTime: string;
  endTime: string;
  days: number[];
  mediaIds: number[];
}
