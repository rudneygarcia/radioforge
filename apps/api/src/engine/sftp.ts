import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ssh2, { type Attributes, type SFTPWrapper } from 'ssh2';
import { config, stationDir } from '../config.js';
import { all, get, run, type FolderRow, type MediaRow, type StationRow } from '../db.js';
import { coversDir } from './covers.js';
import { AUDIO_EXTENSIONS, importMediaFile } from './library.js';
import { writePlaylists } from './manager.js';

/**
 * SFTP por estação: o operador da rádio entra com usuário e senha próprios e vê só a biblioteca dela (pastas e músicas),
 * podendo enviar, baixar, renomear, mover e apagar músicas. Nunca toca nas configurações nem para/reinicia a rádio:
 * cada música enviada é só importada para a biblioteca (e as playlists são atualizadas em lote, sem reiniciar nada).
 */
const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const MAX_FILE = 300 * 1024 * 1024;

export const sftpPort = () => Number(process.env.SFTP_PORT ?? 2222);

interface Cred {
  station_id: number;
  username: string;
  password: string;
  enabled: number;
}
export const getSftp = (stationId: number) => get<Cred>('SELECT * FROM station_sftp WHERE station_id = ?', stationId);

/** Nome de usuário: 3 a 32 caracteres, letras minúsculas, números, ponto, hífen e sublinhado. */
export function validSftpUser(u: string) {
  return u.length >= 3 && u.length <= 32 && [...u].every((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '.' || c === '-' || c === '_');
}

// ---------- Playlists: reescritas em lote (uma vez depois de uma rajada de envios) ----------
const pending = new Map<number, NodeJS.Timeout>();
function scheduleRewrite(stationId: number) {
  if (pending.has(stationId)) clearTimeout(pending.get(stationId)!);
  pending.set(
    stationId,
    setTimeout(() => {
      pending.delete(stationId);
      try {
        writePlaylists(stationId);
      } catch (e) {
        console.error('[sftp] playlists:', (e as Error).message);
      }
    }, 8000),
  );
}

// ---------- Biblioteca como sistema de arquivos virtual ----------
const secs = (s: string) => Math.floor(Date.parse(s.replace(' ', 'T') + 'Z') / 1000) || Math.floor(Date.now() / 1000);

function listFolders(stationId: number) {
  return all<FolderRow>('SELECT * FROM media_folders WHERE station_id = ? ORDER BY lower(name)', stationId);
}

/** Arquivos de uma pasta (null = sem pasta) com nome único: repetidos ganham o código no fim. */
function listFiles(stationId: number, folderId: number | null) {
  const rows = folderId === null
    ? all<MediaRow>('SELECT * FROM media WHERE station_id = ? AND folder_id IS NULL ORDER BY id', stationId)
    : all<MediaRow>('SELECT * FROM media WHERE station_id = ? AND folder_id = ? ORDER BY id', stationId, folderId);
  const seen = new Set<string>();
  return rows.map((m) => {
    let name = m.original_name || `${m.title}${path.extname(m.path)}`;
    name = name.split('/').join('_').split('\\').join('_');
    if (seen.has(name.toLowerCase())) {
      const ext = path.extname(name);
      name = `${name.slice(0, name.length - ext.length)} (${m.id})${ext}`;
    }
    seen.add(name.toLowerCase());
    return { name, media: m };
  });
}

type Node =
  | { type: 'root' }
  | { type: 'dir'; folder: FolderRow }
  | { type: 'file'; media: MediaRow; folderId: number | null; name: string };

const parts = (p: string) => path.posix.normalize('/' + p.split('\\').join('/')).split('/').filter(Boolean);

function lookup(stationId: number, p: string): Node | null {
  const ps = parts(p);
  if (ps.length === 0) return { type: 'root' };
  if (ps.length > 2) return null;
  const folders = listFolders(stationId);
  const folder = folders.find((f) => f.name.toLowerCase() === ps[0].toLowerCase());
  if (ps.length === 1) {
    if (folder) return { type: 'dir', folder };
    const f = listFiles(stationId, null).find((x) => x.name.toLowerCase() === ps[0].toLowerCase());
    return f ? { type: 'file', media: f.media, folderId: null, name: f.name } : null;
  }
  if (!folder) return null;
  const f = listFiles(stationId, folder.id).find((x) => x.name.toLowerCase() === ps[1].toLowerCase());
  return f ? { type: 'file', media: f.media, folderId: folder.id, name: f.name } : null;
}

const dirAttrs = (): Attributes => ({ mode: 0o40755, uid: 0, gid: 0, size: 0, atime: Math.floor(Date.now() / 1000), mtime: Math.floor(Date.now() / 1000) });
const fileAttrs = (m: MediaRow): Attributes => ({ mode: 0o100644, uid: 0, gid: 0, size: m.size, atime: secs(m.created_at), mtime: secs(m.created_at) });
const longname = (name: string, a: Attributes) => `${a.mode! & 0o40000 ? 'd' : '-'}rwxr-xr-x 1 radio radio ${String(a.size).padStart(10)} Jan  1 00:00 ${name}`;

function removeMedia(st: StationRow, m: MediaRow) {
  run('DELETE FROM media WHERE id = ?', m.id);
  if (m.cover) fs.rmSync(path.join(coversDir(st.id), m.cover), { force: true });
  fs.rmSync(path.join(config.dataDir, m.path), { force: true });
}

function validName(n: string) {
  if (!n || n.length > 200 || n === '.' || n === '..') return false;
  for (const c of n) if (c.charCodeAt(0) < 32 || c === '/' || c === '\\') return false;
  return true;
}

type Handle =
  | { kind: 'dir'; entries: { filename: string; longname: string; attrs: Attributes }[]; pos: number }
  | { kind: 'read'; fd: number; size: number }
  | { kind: 'write'; fd: number; tmp: string; written: number; name: string; folderId: number | null; replaceId: number | null };

function serveSftp(sftp: SFTPWrapper, stationId: number, onClose: (fn: () => void) => void) {
  const handles = new Map<number, Handle>();
  let next = 1;
  const station = () => get<StationRow>('SELECT * FROM stations WHERE id = ?', stationId);
  const newHandle = (h: Handle) => {
    const id = next++;
    handles.set(id, h);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id);
    return b;
  };
  const getHandle = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
  const ok = (r: number) => sftp.status(r, STATUS_CODE.OK);
  const fail = (r: number, code: number = STATUS_CODE.FAILURE, msg = '') => sftp.status(r, code, msg);

  onClose(() => {
    for (const h of handles.values()) {
      if (h.kind === 'dir') continue;
      try {
        fs.closeSync(h.fd);
      } catch {
        /* já fechado */
      }
      if (h.kind === 'write') fs.rmSync(h.tmp, { force: true }); // envio interrompido: descarta o pedaço
    }
    handles.clear();
  });

  sftp.on('REALPATH', (r, p) => {
    const ps = parts(p);
    const abs = '/' + ps.join('/');
    sftp.name(r, [{ filename: abs, longname: abs, attrs: dirAttrs() }]);
  });

  const statPath = (r: number, p: string) => {
    const n = lookup(stationId, p);
    if (!n) return fail(r, STATUS_CODE.NO_SUCH_FILE);
    sftp.attrs(r, n.type === 'file' ? fileAttrs(n.media) : dirAttrs());
  };
  sftp.on('STAT', statPath);
  sftp.on('LSTAT', statPath);
  sftp.on('FSTAT', (r, h) => {
    const hd = getHandle(h);
    if (!hd || hd.kind === 'dir') return sftp.attrs(r, dirAttrs());
    sftp.attrs(r, { mode: 0o100644, uid: 0, gid: 0, size: hd.kind === 'write' ? hd.written : hd.size, atime: 0, mtime: Math.floor(Date.now() / 1000) });
  });
  sftp.on('SETSTAT', (r) => ok(r)); // permissões/datas: aceitas e ignoradas (alguns programas sempre enviam)
  sftp.on('FSETSTAT', (r) => ok(r));

  sftp.on('OPENDIR', (r, p) => {
    const n = lookup(stationId, p);
    if (!n || n.type === 'file') return fail(r, STATUS_CODE.NO_SUCH_FILE);
    const entries: { filename: string; longname: string; attrs: Attributes }[] = [];
    if (n.type === 'root') {
      for (const f of listFolders(stationId)) entries.push({ filename: f.name, longname: longname(f.name, dirAttrs()), attrs: dirAttrs() });
    }
    for (const f of listFiles(stationId, n.type === 'root' ? null : n.folder.id)) {
      const a = fileAttrs(f.media);
      entries.push({ filename: f.name, longname: longname(f.name, a), attrs: a });
    }
    sftp.handle(r, newHandle({ kind: 'dir', entries, pos: 0 }));
  });
  sftp.on('READDIR', (r, h) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== 'dir') return fail(r);
    if (hd.pos >= hd.entries.length) return fail(r, STATUS_CODE.EOF);
    const chunk = hd.entries.slice(hd.pos, hd.pos + 100);
    hd.pos += chunk.length;
    sftp.name(r, chunk);
  });

  sftp.on('OPEN', (r, p, flags) => {
    const writing = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
    const n = lookup(stationId, p);
    if (!writing) {
      if (!n || n.type !== 'file') return fail(r, STATUS_CODE.NO_SUCH_FILE);
      try {
        const abs = path.join(config.dataDir, n.media.path);
        const fd = fs.openSync(abs, 'r');
        return sftp.handle(r, newHandle({ kind: 'read', fd, size: fs.fstatSync(fd).size }));
      } catch {
        return fail(r, STATUS_CODE.NO_SUCH_FILE);
      }
    }
    // Envio: só áudio, na raiz ou dentro de uma pasta existente da biblioteca.
    const ps = parts(p);
    if (ps.length < 1 || ps.length > 2) return fail(r, STATUS_CODE.PERMISSION_DENIED, 'Envie dentro da biblioteca (raiz ou uma pasta)');
    const name = ps[ps.length - 1];
    if (!validName(name) || !AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) return fail(r, STATUS_CODE.PERMISSION_DENIED, 'Só arquivos de áudio (mp3, ogg, opus, flac, wav, m4a, aac)');
    let folderId: number | null = null;
    if (ps.length === 2) {
      const folder = listFolders(stationId).find((f) => f.name.toLowerCase() === ps[0].toLowerCase());
      if (!folder) return fail(r, STATUS_CODE.NO_SUCH_FILE);
      folderId = folder.id;
    }
    if (n && n.type === 'dir') return fail(r, STATUS_CODE.FAILURE);
    try {
      const dir = path.join(stationDir(stationId), 'sftp-tmp');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, crypto.randomUUID());
      const fd = fs.openSync(tmp, 'w');
      const existing = n && n.type === 'file' ? n.media.id : null;
      sftp.handle(r, newHandle({ kind: 'write', fd, tmp, written: 0, name, folderId, replaceId: existing }));
    } catch {
      fail(r);
    }
  });

  sftp.on('READ', (r, h, offset, length) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== 'read') return fail(r);
    const buf = Buffer.alloc(Math.min(length, 256 * 1024));
    fs.read(hd.fd, buf, 0, buf.length, offset, (err, n) => {
      if (err) return fail(r);
      if (n === 0) return fail(r, STATUS_CODE.EOF);
      sftp.data(r, buf.subarray(0, n));
    });
  });

  sftp.on('WRITE', (r, h, offset, data) => {
    const hd = getHandle(h);
    if (!hd || hd.kind !== 'write') return fail(r);
    if (offset + data.length > MAX_FILE) return fail(r, STATUS_CODE.FAILURE, 'Arquivo grande demais (limite de 300 MB)');
    fs.write(hd.fd, data, 0, data.length, offset, (err) => {
      if (err) return fail(r);
      hd.written = Math.max(hd.written, offset + data.length);
      ok(r);
    });
  });

  sftp.on('CLOSE', (r, h) => {
    const hd = getHandle(h);
    if (!hd) return fail(r);
    handles.delete(h.readUInt32BE(0));
    if (hd.kind === 'dir') return ok(r);
    try {
      fs.closeSync(hd.fd);
    } catch {
      /* já fechado */
    }
    if (hd.kind === 'read') return ok(r);
    if (hd.written === 0) {
      fs.rmSync(hd.tmp, { force: true });
      return ok(r);
    }
    const st = station();
    if (!st) {
      fs.rmSync(hd.tmp, { force: true });
      return fail(r);
    }
    importMediaFile(st, hd.tmp, hd.name, hd.folderId)
      .then(() => {
        if (hd.replaceId !== null) {
          const old = get<MediaRow>('SELECT * FROM media WHERE id = ? AND station_id = ?', hd.replaceId, st.id);
          if (old) removeMedia(st, old);
        }
        scheduleRewrite(st.id);
        ok(r);
      })
      .catch((e) => {
        fs.rmSync(hd.tmp, { force: true });
        console.error('[sftp] importação falhou:', (e as Error).message);
        fail(r);
      });
  });

  sftp.on('REMOVE', (r, p) => {
    const st = station();
    const n = lookup(stationId, p);
    if (!st || !n || n.type !== 'file') return fail(r, STATUS_CODE.NO_SUCH_FILE);
    removeMedia(st, n.media);
    scheduleRewrite(st.id);
    ok(r);
  });

  sftp.on('MKDIR', (r, p) => {
    const ps = parts(p);
    if (ps.length !== 1 || !validName(ps[0]) || ps[0].length > 60) return fail(r, STATUS_CODE.PERMISSION_DENIED, 'Pastas só na raiz (nome de até 60 caracteres)');
    if (lookup(stationId, p)) return fail(r, STATUS_CODE.FAILURE, 'Já existe');
    run('INSERT INTO media_folders (station_id, name) VALUES (?, ?)', stationId, ps[0]);
    ok(r);
  });

  sftp.on('RMDIR', (r, p) => {
    const n = lookup(stationId, p);
    if (!n || n.type !== 'dir') return fail(r, STATUS_CODE.NO_SUCH_FILE);
    if (listFiles(stationId, n.folder.id).length > 0) return fail(r, STATUS_CODE.FAILURE, 'A pasta não está vazia');
    run('DELETE FROM media_folders WHERE id = ? AND station_id = ?', n.folder.id, stationId);
    scheduleRewrite(stationId);
    ok(r);
  });

  sftp.on('RENAME', (r, from, to) => {
    const n = lookup(stationId, from);
    if (!n || n.type === 'root') return fail(r, STATUS_CODE.NO_SUCH_FILE);
    const tp = parts(to);
    if (tp.length < 1 || tp.length > 2) return fail(r, STATUS_CODE.PERMISSION_DENIED);
    const newName = tp[tp.length - 1];
    if (!validName(newName)) return fail(r, STATUS_CODE.PERMISSION_DENIED, 'Nome inválido');
    if (n.type === 'dir') {
      if (tp.length !== 1 || newName.length > 60) return fail(r, STATUS_CODE.PERMISSION_DENIED);
      const clash = lookup(stationId, to);
      if (clash && !(clash.type === 'dir' && clash.folder.id === n.folder.id)) return fail(r, STATUS_CODE.FAILURE, 'Já existe');
      run('UPDATE media_folders SET name = ? WHERE id = ? AND station_id = ?', newName, n.folder.id, stationId);
      return ok(r);
    }
    if (!AUDIO_EXTENSIONS.has(path.extname(newName).toLowerCase())) return fail(r, STATUS_CODE.PERMISSION_DENIED, 'Só arquivos de áudio');
    let folderId: number | null = null;
    if (tp.length === 2) {
      const folder = listFolders(stationId).find((f) => f.name.toLowerCase() === tp[0].toLowerCase());
      if (!folder) return fail(r, STATUS_CODE.NO_SUCH_FILE);
      folderId = folder.id;
    }
    const clash = lookup(stationId, to);
    if (clash && !(clash.type === 'file' && clash.media.id === n.media.id)) return fail(r, STATUS_CODE.FAILURE, 'Já existe um arquivo com esse nome');
    run('UPDATE media SET original_name = ?, folder_id = ? WHERE id = ? AND station_id = ?', newName, folderId, n.media.id, stationId);
    scheduleRewrite(stationId);
    ok(r);
  });

  sftp.on('READLINK', (r) => fail(r, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('SYMLINK', (r) => fail(r, STATUS_CODE.OP_UNSUPPORTED));
}

// ---------- Servidor SSH/SFTP ----------
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const fails = new Map<string, { n: number; since: number }>();

function hostKey(): string {
  const file = path.join(config.dataDir, '.secrets', 'sftp_host_ed25519');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const { private: key } = utils.generateKeyPairSync('ed25519');
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function startSftp() {
  const port = sftpPort();
  if (!port) return; // SFTP_PORT=0 desliga
  // Sobras de envios interrompidos por um reinício.
  for (const st of all<{ id: number }>('SELECT id FROM stations')) fs.rmSync(path.join(stationDir(st.id), 'sftp-tmp'), { recursive: true, force: true });

  const server = new Server({ hostKeys: [hostKey()], ident: 'RadioForge-SFTP' }, (client, info) => {
    let stationId = 0;
    const closers: (() => void)[] = [];
    client.on('authentication', (ctx) => {
      const f = fails.get(info.ip);
      if (f && Date.now() - f.since < 10 * 60_000 && f.n >= 10) return ctx.reject([]); // muitas tentativas erradas: bloqueia por 10 min
      if (ctx.method !== 'password') return ctx.reject(['password']);
      const row = get<Cred>('SELECT * FROM station_sftp WHERE lower(username) = lower(?) AND enabled = 1', ctx.username);
      const good = !!row && crypto.timingSafeEqual(sha(row.password), sha(ctx.password));
      if (!good) {
        const cur = f && Date.now() - f.since < 10 * 60_000 ? f : { n: 0, since: Date.now() };
        cur.n++;
        fails.set(info.ip, cur);
        return ctx.reject(['password']);
      }
      fails.delete(info.ip);
      stationId = row!.station_id;
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), stationId, (fn) => closers.push(fn)));
        // Sem terminal nem comandos: só SFTP (sem listener, o ssh2 recusa shell/exec).
      });
    });
    client.on('error', () => {});
    client.on('close', () => closers.forEach((fn) => fn()));
  });
  server.on('error', (e: Error) => console.error('[sftp] servidor:', e.message));
  server.listen(port, '0.0.0.0', () => console.log(`[sftp] ouvindo na porta ${port}`));
}
