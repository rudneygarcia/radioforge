import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

// Este módulo NÃO importa o db.ts: roda antes de o banco ser aberto.
const dbFile = path.join(config.dataDir, 'radioforge.db');
const pendingDir = path.join(config.dataDir, 'restore');
const pendingFile = path.join(pendingDir, 'pending.db');

/** Confere se o arquivo é um banco SQLite íntegro do RadioForge. Lança erro com o motivo se não for. */
export function validateBackupFile(file: string) {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const check = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== 'ok') throw new Error('o arquivo está corrompido');
    const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['users', 'stations', 'playlists']) if (!tables.includes(t)) throw new Error(`não parece um backup do RadioForge (falta a tabela ${t})`);
    const admins = probe.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number };
    if (admins.n === 0) throw new Error('o backup não tem nenhum administrador');
  } finally {
    probe?.close();
  }
}

/** Deixa o backup escolhido pronto para entrar no próximo início da API. */
export function stageRestore(backupPath: string) {
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.copyFileSync(backupPath, pendingFile);
}

/**
 * Chamado no início do boot, antes de abrir o banco: se há uma restauração pendente, troca o arquivo
 * do banco (e descarta o WAL do banco antigo, que não vale para o novo).
 */
export function applyPendingRestore() {
  if (!fs.existsSync(pendingFile)) return;
  try {
    validateBackupFile(pendingFile);
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
    fs.renameSync(pendingFile, dbFile);
    console.log('[restore] banco restaurado a partir do backup escolhido');
  } catch (e) {
    console.error('[restore] restauração ignorada:', (e as Error).message);
    fs.rmSync(pendingFile, { force: true });
  }
}
