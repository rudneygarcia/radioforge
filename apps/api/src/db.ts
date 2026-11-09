import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';

export const db = new DatabaseSync(path.join(config.dataDir, 'radioforge.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  stream_port INTEGER NOT NULL UNIQUE,
  mount TEXT NOT NULL DEFAULT '/radio',
  format TEXT NOT NULL DEFAULT 'mp3' CHECK (format IN ('mp3','ogg')),
  bitrate INTEGER NOT NULL DEFAULT 128,
  source_password TEXT NOT NULL,
  admin_password TEXT NOT NULL,
  live_enabled INTEGER NOT NULL DEFAULT 1,
  requests_enabled INTEGER NOT NULL DEFAULT 1,
  autostart INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS station_members (
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (station_id, user_id)
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_station ON media(station_id);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'shuffle' CHECK (mode IN ('shuffle','sequential')),
  weight INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_media (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (playlist_id, media_id)
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_station ON history(station_id, id DESC);

CREATE TABLE IF NOT EXISTS song_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/** Migrações simples: adiciona colunas novas em bancos já existentes. */
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('playlists', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0');
// 0 = rotação normal; N > 0 = toca 1 faixa desta playlist a cada N faixas da rotação (vinhetas, avisos).
addColumn('playlists', 'every_songs', 'INTEGER NOT NULL DEFAULT 0');
// 0 = desligado; N > 0 = a cada N minutos (alinhado ao relógio, ex.: 60 = todo início de hora) entra 1 faixa desta playlist.
addColumn('playlists', 'every_minutes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('playlists', 'start_time', "TEXT NOT NULL DEFAULT '00:00'");
addColumn('playlists', 'end_time', "TEXT NOT NULL DEFAULT '23:59'");
// Dias da semana separados por vírgula, 0=domingo … 6=sábado.
addColumn('playlists', 'days', "TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6'");

addColumn('stations', 'crossfade_seconds', 'REAL NOT NULL DEFAULT 0');
addColumn('stations', 'normalize', 'INTEGER NOT NULL DEFAULT 0');

// Mountpoints adicionais (além do principal), cada um com seu formato/bitrate.
db.exec(`
CREATE TABLE IF NOT EXISTS station_mounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  mount TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('mp3','ogg')),
  bitrate INTEGER NOT NULL,
  UNIQUE (station_id, mount)
);
`);

addColumn('stations', 'record_live', 'INTEGER NOT NULL DEFAULT 0');

// Contas de DJ: cada DJ conecta ao vivo com seu próprio usuário e senha.
db.exec(`
CREATE TABLE IF NOT EXISTS station_djs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (station_id, username)
);
`);
// Horário permitido para o DJ conectar (fora dele a conexão é recusada). Horário do servidor (UTC no Docker).
addColumn('station_djs', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('station_djs', 'start_time', "TEXT NOT NULL DEFAULT '00:00'");
addColumn('station_djs', 'end_time', "TEXT NOT NULL DEFAULT '23:59'");
addColumn('station_djs', 'days', "TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6'");

// Estatísticas: amostras de ouvintes (1 por minuto) e sessões lidas do access.log do Icecast.
db.exec(`
CREATE TABLE IF NOT EXISTS listener_samples (
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  listeners INTEGER NOT NULL,
  PRIMARY KEY (station_id, at)
);
CREATE TABLE IF NOT EXISTS listener_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  ip_hash TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '??',
  player TEXT NOT NULL DEFAULT 'Outro',
  mount TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_station ON listener_sessions(station_id, started_at);
CREATE TABLE IF NOT EXISTS station_log_state (
  station_id INTEGER PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  offset INTEGER NOT NULL DEFAULT 0
);
`);

// Chaves de API (só o hash é guardado) e webhooks por estação.
db.exec(`
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS station_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('generic','discord')),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT 'song_change',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT NOT NULL DEFAULT '',
  last_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
// Chaves somente leitura só podem fazer requisições GET/HEAD.
addColumn('api_keys', 'read_only', 'INTEGER NOT NULL DEFAULT 0');

export interface WebhookRow {
  id: number;
  station_id: number;
  name: string;
  type: 'generic' | 'discord';
  url: string;
  secret: string;
  events: string;
  enabled: number;
  last_status: string;
  last_at: string;
  created_at: string;
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: string;
}
export interface StationRow {
  id: number;
  name: string;
  slug: string;
  description: string;
  stream_port: number;
  mount: string;
  format: 'mp3' | 'ogg';
  bitrate: number;
  source_password: string;
  admin_password: string;
  live_enabled: number;
  requests_enabled: number;
  autostart: number;
  crossfade_seconds: number;
  normalize: number;
  record_live: number;
  created_at: string;
}
export interface DjRow {
  id: number;
  station_id: number;
  username: string;
  password: string;
  display_name: string;
  enabled: number;
  schedule_enabled: number;
  start_time: string;
  end_time: string;
  days: string;
  created_at: string;
}
export const djsFor = (stationId: number) =>
  all<DjRow>('SELECT * FROM station_djs WHERE station_id = ? ORDER BY id', stationId);
export interface MountRow {
  id: number;
  station_id: number;
  mount: string;
  format: 'mp3' | 'ogg';
  bitrate: number;
}
export const mountsFor = (stationId: number) =>
  all<MountRow>('SELECT * FROM station_mounts WHERE station_id = ? ORDER BY id', stationId);
export interface MediaRow {
  id: number;
  station_id: number;
  path: string;
  original_name: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  size: number;
  created_at: string;
}
export interface PlaylistRow {
  id: number;
  station_id: number;
  name: string;
  enabled: number;
  mode: 'shuffle' | 'sequential';
  weight: number;
  every_songs: number;
  every_minutes: number;
  schedule_enabled: number;
  start_time: string;
  end_time: string;
  days: string;
  created_at: string;
}
