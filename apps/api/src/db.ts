import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.js';
import { applyPendingRestore } from './engine/restore.js';

applyPendingRestore(); // precisa rodar antes de abrir o banco

export const db = new DatabaseSync(path.join(config.dataDir, 'radioforge.db'));
// WAL + synchronous NORMAL: sem fsync a cada gravação (histórico, sessões, amostras); seguro contra queda do programa e,
// no pior caso (queda de energia), só se perde o que foi gravado nos últimos instantes.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000; PRAGMA foreign_keys = ON;');

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

-- Pastas da biblioteca (planas) e pastas escolhidas por playlist (entram todas as músicas da pasta, inclusive as futuras).
CREATE TABLE IF NOT EXISTS media_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (station_id, name)
);
CREATE TABLE IF NOT EXISTS playlist_folders (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES media_folders(id) ON DELETE CASCADE,
  PRIMARY KEY (playlist_id, folder_id)
);

-- Arquivos de áudio da hora certa enviados pelo usuário (um por horário).
CREATE TABLE IF NOT EXISTS time_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  voice TEXT NOT NULL DEFAULT 'padrao',
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL DEFAULT 0,
  file TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  UNIQUE (station_id, voice, hour, minute)
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
CREATE TABLE IF NOT EXISTS podcast_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'audio/mpeg',
  duration REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_station ON podcast_episodes(station_id, id DESC);
`);

/** Migrações simples: adiciona colunas novas em bancos já existentes. */
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// Formato AAC: os CHECK antigos só aceitavam mp3/ogg. Troca o texto do esquema (sem recriar tabelas) e avisa o SQLite.
function allowAacFormat() {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('stations', 'station_mounts')").all() as { name: string; sql: string }[];
  const old = "CHECK (format IN ('mp3','ogg'))";
  const stale = rows.filter((r) => r.sql.includes(old));
  if (stale.length === 0) return;
  try {
    const version = (db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
    db.enableDefensive(false); // o Node liga o modo defensivo, que bloqueia editar o esquema
    db.exec('PRAGMA writable_schema = ON');
    for (const r of stale) {
      db.prepare('UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?').run(r.sql.replace(old, "CHECK (format IN ('mp3','ogg','aac'))"), 'table', r.name);
    }
    db.exec(`PRAGMA schema_version = ${version + 1}`);
    db.exec('PRAGMA writable_schema = OFF');
  } catch (e) {
    // Nunca impede a API de subir: sem a migração só o formato AAC fica indisponível.
    console.error('[db] não foi possível liberar o formato AAC no banco:', (e as Error).message);
  } finally {
    db.enableDefensive(true);
  }
}
allowAacFormat();
// Permissões do operador (lista JSON de chaves). NULL = padrão (o que operadores já podiam antes).
addColumn('users', 'permissions', 'TEXT');
// Acesso SFTP à biblioteca de cada estação (usuário e senha próprios).
db.exec(`CREATE TABLE IF NOT EXISTS station_sftp (
  station_id INTEGER PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
)`);
addColumn('stations', 'history_limit', 'INTEGER NOT NULL DEFAULT 5'); // quantas músicas recentes o player público mostra
addColumn('stations', 'audio_preset', "TEXT NOT NULL DEFAULT 'off'"); // off | balanced | loud (Liquidsoap)
// Não repetir a mesma música por N minutos (0 = desligado).
// Segundos sem receber áudio do encoder até considerá-lo desconectado (e o AutoDJ voltar). Padrão do Liquidsoap: 30.
addColumn('stations', 'live_timeout', 'INTEGER NOT NULL DEFAULT 8');
// 1 = ao voltar do ao vivo, o AutoDJ continua a música que está tocando (roda em segundo plano durante o DJ); 0 = começa uma nova.
addColumn('stations', 'live_continue', 'INTEGER NOT NULL DEFAULT 1');
// Hora certa: 0 = desligada; 15, 30 ou 60 = avisa a hora a cada N minutos (fuso da estação).
addColumn('stations', 'time_announce', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stations', 'timezone', "TEXT NOT NULL DEFAULT 'America/Sao_Paulo'");
// 1 = quando não há arquivo de áudio enviado para o horário, usa a voz sintética; 0 = não avisa nesse horário.
addColumn('stations', 'time_announce_voice', 'INTEGER NOT NULL DEFAULT 1');
// Voz da hora certa em uso (vazio = a mais completa entre as enviadas).
addColumn('stations', 'time_voice', "TEXT NOT NULL DEFAULT ''");
// time_clips antiga (um arquivo por horário, sem voz) vira a voz "padrao".
if (!(db.prepare('PRAGMA table_info(time_clips)').all() as { name: string }[]).some((c) => c.name === 'voice')) {
  db.exec(`ALTER TABLE time_clips RENAME TO time_clips_old;
    CREATE TABLE time_clips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
      voice TEXT NOT NULL DEFAULT 'padrao',
      hour INTEGER NOT NULL,
      minute INTEGER NOT NULL DEFAULT 0,
      file TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      UNIQUE (station_id, voice, hour, minute)
    );
    INSERT INTO time_clips (station_id, voice, hour, minute, file, original_name, duration, size)
      SELECT station_id, 'padrao', hour, minute, file, original_name, duration, size FROM time_clips_old;
    DROP TABLE time_clips_old;`);
}
// AutoCue: o Liquidsoap analisa cada música (início/fim reais, silêncio, volume) e faz as passagens (música, vinheta, hora certa) sem cortes.
addColumn('stations', 'autocue', 'INTEGER NOT NULL DEFAULT 0');
// Personalização do AutoCue: 1 = usa os valores abaixo no crossfade; 0 = padrão do Liquidsoap.
addColumn('stations', 'autocue_custom', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stations', 'autocue_duration', 'REAL NOT NULL DEFAULT 5');
addColumn('stations', 'autocue_fade_in', 'REAL NOT NULL DEFAULT 3');
addColumn('stations', 'autocue_fade_out', 'REAL NOT NULL DEFAULT 3');
// Passagem entre vinhetas/avisos (s de sobreposição; 0 = uma termina inteira e a outra começa) e ganho extra (dB) delas.
addColumn('stations', 'jingle_overlap', 'REAL NOT NULL DEFAULT 0');
addColumn('stations', 'jingle_gain', 'REAL NOT NULL DEFAULT 0');
// Nivela o volume de tudo pelo AutoCue (liq_amplify): músicas, vinhetas e hora certa no mesmo nível.
addColumn('stations', 'autocue_level', 'INTEGER NOT NULL DEFAULT 1');
// Faixas que contêm estas palavras tocam sem enviar metadados (nem o nome da estação). Vinhetas: opção de também não enviar o nome.
addColumn('stations', 'hidden_words', "TEXT NOT NULL DEFAULT ''");
addColumn('stations', 'jingle_hide_name', 'INTEGER NOT NULL DEFAULT 0');
// Pedidos: minutos que cada ouvinte espera para pedir de novo (0 = sem limite) e minutos até o pedido entrar no AutoDJ (0 = na hora).
addColumn('stations', 'request_interval', 'INTEGER NOT NULL DEFAULT 5');
addColumn('stations', 'request_delay', 'INTEGER NOT NULL DEFAULT 0');
// Stereo Tool: processador comercial; a biblioteca (.so) é do servidor, o preset (.sts) e a chave de licença são da estação.
addColumn('stations', 'stereo_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stations', 'stereo_key', "TEXT NOT NULL DEFAULT ''");
addColumn('stations', 'stereo_preset', "TEXT NOT NULL DEFAULT ''");
// Não repetir o mesmo artista por N minutos (0 = desligado).
addColumn('stations', 'no_repeat_artist_minutes', 'INTEGER NOT NULL DEFAULT 0');
// AutoDJ ligado (1) ou só transmissão ao vivo (0): sem AutoDJ roda apenas o Icecast (o DJ conecta direto nele) e o Liquidsoap fica desligado.
addColumn('stations', 'autodj', 'INTEGER NOT NULL DEFAULT 1');
// Disco onde entram as músicas novas ('' = principal; senão o nome de uma subpasta de /disks).
addColumn('stations', 'disk', "TEXT NOT NULL DEFAULT ''");

// Configurações gerais (ex.: e-mail SMTP) e pedidos de recuperação de senha (só o hash do código é guardado).
db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwreset_hash ON password_resets(token_hash);
`);

// Blocos comerciais (comerciais de uma pasta da Biblioteca nos horários programados) e o comprovante de veiculação.
db.exec(`
CREATE TABLE IF NOT EXISTS ad_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_id INTEGER REFERENCES media_folders(id) ON DELETE SET NULL,
  times TEXT NOT NULL DEFAULT '',
  days TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  mode TEXT NOT NULL DEFAULT 'sequential',
  items INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired TEXT NOT NULL DEFAULT '',
  cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ad_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  block_id INTEGER,
  block_name TEXT NOT NULL DEFAULT '',
  media_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT NOT NULL DEFAULT '',
  pushed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_plays_station ON ad_plays(station_id, id DESC);
`);
// Resultado da análise do AutoCue de cada música (não precisa analisar de novo a cada vez que ela toca).
db.exec(`CREATE TABLE IF NOT EXISTS media_cue (
  media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Quando o comercial realmente começou a tocar (confirmado pelo Liquidsoap).
addColumn('ad_plays', 'played_at', 'TEXT');
// Não repetir o mesmo artista por N minutos (0 = desligado).
addColumn('song_requests', 'due_at', "TEXT NOT NULL DEFAULT ''");
addColumn('song_requests', 'pushed', 'INTEGER NOT NULL DEFAULT 1');
// 1 = o painel já reenviou o pedido à fila (quando o Liquidsoap perdeu o primeiro envio).
addColumn('song_requests', 'retried', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stations', 'cover', 'TEXT'); // capa/logo da rádio (arquivo dentro da pasta da estação); usada quando a música não tem capa
addColumn('stations', 'no_repeat_minutes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('history', 'media_id', 'INTEGER'); // música tocada (para a regra de não repetir); null em vinhetas/antigos
addColumn('stations', 'audio_gain', 'REAL NOT NULL DEFAULT 0'); // ganho extra em dB (0 a 12), antes do limitador
addColumn('stations', 'audio_master_target', 'REAL NOT NULL DEFAULT -14'); // volume alvo do master_me, em LUFS (ex.: -14, -16, -23)
// Vinhetas de bloco comercial: tocam antes (saída) e depois (entrada) de QUALQUER bloco disparado. Com mais de uma
// música na playlist escolhida, cada disparo toca a próxima (cursor), não a mesma sempre nem ao acaso.
addColumn('stations', 'ad_exit_playlist_id', 'INTEGER REFERENCES playlists(id) ON DELETE SET NULL');
addColumn('stations', 'ad_exit_cursor', 'INTEGER NOT NULL DEFAULT 0');
addColumn('stations', 'ad_entry_playlist_id', 'INTEGER REFERENCES playlists(id) ON DELETE SET NULL');
addColumn('stations', 'ad_entry_cursor', 'INTEGER NOT NULL DEFAULT 0');
// Migração única (user_version 1): quem estava sem processador passa ao "Equilibrado", que nivela o volume (o áudio original saía baixo).
if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version < 1) {
  db.exec("UPDATE stations SET audio_preset = 'balanced' WHERE audio_preset = 'off'");
  db.exec('PRAGMA user_version = 1');
}
addColumn('media', 'cover', 'TEXT'); // arquivo da capa extraída das tags (null = sem capa)
addColumn('media', 'cover_checked', 'INTEGER NOT NULL DEFAULT 0'); // 1 = já tentamos extrair a capa
addColumn('media', 'folder_id', 'INTEGER REFERENCES media_folders(id) ON DELETE SET NULL');
addColumn('playlists', 'schedule_enabled', 'INTEGER NOT NULL DEFAULT 0');
// Playlist padrão (uma por estação): é a rotação base; as outras entram por regra e não se misturam com ela.
addColumn('playlists', 'is_default', 'INTEGER NOT NULL DEFAULT 0');
// Vinheta: toca normalmente, mas o nome do arquivo NÃO é enviado ao servidor (não entra no "tocando agora", histórico nem webhooks).
addColumn('playlists', 'is_jingle', 'INTEGER NOT NULL DEFAULT 0');
// Pedidos dos ouvintes: só as músicas das playlists com esta opção ligada aparecem para pedir.
addColumn('playlists', 'requestable', 'INTEGER NOT NULL DEFAULT 0');
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
  permissions: string | null;
  created_at: string;
}
export interface StationRow {
  id: number;
  name: string;
  slug: string;
  description: string;
  stream_port: number;
  mount: string;
  format: 'mp3' | 'ogg' | 'aac';
  bitrate: number;
  source_password: string;
  admin_password: string;
  live_enabled: number;
  requests_enabled: number;
  autostart: number;
  crossfade_seconds: number;
  normalize: number;
  record_live: number;
  history_limit: number;
  audio_preset: 'off' | 'balanced' | 'loud' | 'master_me';
  audio_gain: number;
  audio_master_target: number;
  ad_exit_playlist_id: number | null;
  ad_exit_cursor: number;
  ad_entry_playlist_id: number | null;
  ad_entry_cursor: number;
  no_repeat_minutes: number;
  live_timeout: number;
  live_continue: number;
  time_announce: number;
  time_announce_voice: number;
  time_voice: string;
  autocue: number;
  autocue_custom: number;
  autocue_duration: number;
  autocue_fade_in: number;
  autocue_fade_out: number;
  jingle_overlap: number;
  jingle_gain: number;
  autocue_level: number;
  hidden_words: string;
  jingle_hide_name: number;
  request_interval: number;
  request_delay: number;
  stereo_enabled: number;
  disk: string;
  stereo_key: string;
  stereo_preset: string;
  no_repeat_artist_minutes: number;
  autodj: number;
  timezone: string;
  cover: string | null;
  created_at: string;
}
export interface EpisodeRow {
  id: number;
  station_id: number;
  title: string;
  description: string;
  path: string;
  original_name: string;
  mime: string;
  duration: number;
  size: number;
  published: number;
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
  format: 'mp3' | 'ogg' | 'aac';
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
  folder_id: number | null;
  cover: string | null;
  cover_checked: number;
  created_at: string;
}
export interface FolderRow {
  id: number;
  station_id: number;
  name: string;
  created_at: string;
}

/**
 * Todas as músicas de uma playlist: as escolhidas uma a uma (na ordem) + as de cada pasta escolhida
 * (por artista/título), sem repetir. Músicas novas numa pasta escolhida entram sozinhas.
 */
export function playlistMedia(playlistId: number): MediaRow[] {
  const direct = all<MediaRow>(
    `SELECT m.* FROM playlist_media pm JOIN media m ON m.id = pm.media_id WHERE pm.playlist_id = ? ORDER BY pm.position, m.id`,
    playlistId,
  );
  const fromFolders = all<MediaRow>(
    `SELECT m.* FROM media m WHERE m.folder_id IN (SELECT folder_id FROM playlist_folders WHERE playlist_id = ?) ORDER BY m.artist, m.title, m.id`,
    playlistId,
  );
  const seen = new Set(direct.map((m) => m.id));
  return [...direct, ...fromFolders.filter((m) => !seen.has(m.id))];
}
export interface RecentPlays {
  ids: Set<number>;
  /** A última música tocada (para nunca repetir a faixa de trás para a frente). */
  last: number | null;
}

/** Músicas tocadas nos últimos `minutes` minutos (vazio se a regra estiver desligada). */
export function recentMedia(stationId: number, minutes: number): RecentPlays {
  if (minutes <= 0) return { ids: new Set(), last: null };
  const rows = all<{ media_id: number }>(
    `SELECT media_id FROM history WHERE station_id = ? AND media_id IS NOT NULL AND played_at >= datetime('now', ?) ORDER BY id DESC`,
    stationId,
    `-${Math.floor(minutes)} minutes`,
  );
  return { ids: new Set(rows.map((r) => r.media_id)), last: rows[0]?.media_id ?? null };
}

/**
 * Tira da lista as músicas tocadas há pouco. Se não sobrar nenhuma (biblioteca pequena), nunca deixa a
 * rádio sem música: usa tudo, menos a última tocada (quando houver outra).
 */
export function avoidRecent<T extends { id: number }>(media: T[], recent: RecentPlays): T[] {
  if (recent.ids.size === 0) return media;
  const fresh = media.filter((m) => !recent.ids.has(m.id));
  if (fresh.length > 0) return fresh;
  return media.length > 1 ? media.filter((m) => m.id !== recent.last) : media;
}

/** Músicas que os ouvintes podem pedir: as de playlists ativas com pedidos ligados (e que não são vinhetas). */
export function requestableMedia(stationId: number): MediaRow[] {
  const lists = all<{ id: number }>('SELECT id FROM playlists WHERE station_id = ? AND enabled = 1 AND requestable = 1 AND is_jingle = 0', stationId);
  const seen = new Map<number, MediaRow>();
  for (const l of lists) for (const m of playlistMedia(l.id)) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => (a.artist + ' ' + a.title).localeCompare(b.artist + ' ' + b.title, 'pt-BR'));
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
  is_default: number;
  is_jingle: number;
  requestable: number;
  schedule_enabled: number;
  start_time: string;
  end_time: string;
  days: string;
  created_at: string;
}
