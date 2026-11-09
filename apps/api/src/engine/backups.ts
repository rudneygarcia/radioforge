import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';

/** Quantas cópias automáticas/manuais ficam guardadas (as mais antigas são apagadas). */
export const KEEP_BACKUPS = 7;
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
  for (const old of listBackups().slice(KEEP_BACKUPS)) fs.rmSync(path.join(backupsDir, old.name), { force: true });
  return { name, size: fs.statSync(file).size, createdAt: new Date().toISOString() };
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
