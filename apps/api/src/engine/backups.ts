import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, get, run } from '../db.js';

/** Quantas cópias ficam guardadas por padrão (o administrador muda na tela de Backups; as mais antigas são apagadas). */
export const DEFAULT_KEEP_BACKUPS = 7;
export const MIN_KEEP_BACKUPS = 1;
export const MAX_KEEP_BACKUPS = 90;

/** Quantos backups guardar agora (configuração salva; 7 se ninguém mudou). */
export function getKeepBackups(): number {
  const n = Number(get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'backup_keep'")?.value);
  return Number.isInteger(n) && n >= MIN_KEEP_BACKUPS && n <= MAX_KEEP_BACKUPS ? n : DEFAULT_KEEP_BACKUPS;
}

export function setKeepBackups(n: number) {
  run("INSERT INTO app_settings (key, value) VALUES ('backup_keep', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(n));
}
const DAY_MS = 24 * 3600_000;
export const SAFE_BACKUP = /^radioforge-\d{8}-\d{6}\.db$/;

export const backupsDir = path.join(config.dataDir, 'backups');

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((f) => SAFE_BACKUP.test(f))
    .map((name) => {
      const s = fs.statSync(path.join(backupsDir, name));
      return { name, size: s.size, createdAt: s.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Cópia consistente do banco (VACUUM INTO funciona com o banco em uso).
 * Só o banco: usuários, estações, playlists, relatórios, chaves e webhooks. Músicas e gravações
 * ficam fora (são grandes); para elas, faça cópia do volume /data.
 */
export function createBackup(): BackupInfo {
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `radioforge-${stamp}.db`;
  const file = path.join(backupsDir, name);
  if (fs.existsSync(file)) fs.rmSync(file);
  // O caminho vai como parâmetro, então não há injeção de SQL.
  db.prepare('VACUUM INTO ?').run(file);
  fs.chmodSync(file, 0o600);
  pruneBackups();
  return { name, size: fs.statSync(file).size, createdAt: new Date().toISOString() };
}

/** Apaga as cópias mais antigas além do limite. */
export function pruneBackups() {
  for (const old of listBackups().slice(getKeepBackups())) fs.rmSync(path.join(backupsDir, old.name), { force: true });
}

/** Nome livre no padrão dos backups (para o arquivo enviado de outro servidor). */
export function newBackupName(): string {
  let t = Date.now();
  for (;;) {
    const stamp = new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `radioforge-${stamp}.db`;
    if (!fs.existsSync(path.join(backupsDir, name))) return name;
    t += 1000;
  }
}

/** Cria uma cópia por dia: confere a cada hora se a última tem mais de 24 h. */
export function startBackupScheduler() {
  const tick = () => {
    try {
      const last = listBackups()[0];
      if (!last || Date.now() - Date.parse(last.createdAt) >= DAY_MS) {
        const b = createBackup();
        console.log(`[backup] criado ${b.name} (${b.size} bytes)`);
      }
    } catch (e) {
      console.error('[backup] falhou:', e);
    }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 3600_000).unref();
}
