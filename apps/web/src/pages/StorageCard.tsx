import { useEffect, useState } from 'react';
import { api } from '../api';

interface Disk {
  total: number;
  free: number;
  device: string | null;
  fsType: string | null;
}
interface Storage {
  dataDir: string;
  stationsDir: string;
  separateDisk: boolean;
  writable: boolean;
  system: Disk;
  music: Disk;
  mediaBytes: number;
}

const gb = (n: number) => (n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(1)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
/** Sistemas de arquivos que não guardam permissões do Linux (ruins para o banco e para os arquivos do contêiner). */
const POOR_FS = ['ntfs', 'ntfs3', 'fuseblk', 'vfat', 'exfat', 'msdos'];

/** Onde as músicas estão gravadas: no disco do sistema ou em outro (HD externo), com o espaço livre. Só administrador. */
export default function StorageCard() {
  const [s, setS] = useState<Storage | null>(null);
  useEffect(() => {
    api<Storage>('/api/system/storage').then(setS).catch(() => {});
  }, []);
  if (!s) return null;

  const poorFs = !!s.music.fsType && POOR_FS.includes(s.music.fsType.toLowerCase());
  const lowSpace = s.music.total > 0 && (s.music.free < 5 * 1024 ** 3 || s.music.free / s.music.total < 0.05);
  const disk = (d: Disk) => (d.total > 0 ? `${gb(d.free)} livres de ${gb(d.total)}` : '—');
  const label = (d: Disk) => [d.device, d.fsType].filter(Boolean).join(' · ') || '—';

  return (
    <div className="card section">
      <div className="section-title">
        <h3>Armazenamento das músicas</h3>
        <span className={`badge ${s.writable ? 'on' : 'off'}`}>{s.writable ? (s.separateDisk ? 'em outro disco' : 'no disco do sistema') : 'sem permissão de gravar'}</span>
      </div>
      {!s.writable && <div className="card notice"><strong>O painel não consegue gravar em {s.stationsDir}.</strong> Se é um HD externo, confira se está montado e se a pasta pertence ao usuário 1001 (<code>chown -R 1001:1001 /mnt/hd/radioforge/stations</code>). Enquanto isso, o envio de músicas vai falhar.</div>}
      {s.writable && s.separateDisk && <p className="muted" style={{ marginTop: -4 }}>As músicas estão sendo gravadas em <strong>outro disco</strong> (o HD externo, por exemplo). O banco, os backups e o certificado ficam no disco do sistema.</p>}
      {s.writable && !s.separateDisk && <p className="muted" style={{ marginTop: -4 }}>As músicas estão no <strong>mesmo disco do sistema</strong>. Se você configurou um HD externo e esta mensagem aparece, ele não está montado no servidor ou o instalador não foi rodado com <code>RF_MEDIA_DIR</code>.</p>}
      {poorFs && <div className="card notice"><strong>Sistema de arquivos {s.music.fsType}:</strong> não guarda as permissões do Linux e pode dar erro de gravação. O recomendado para o HD é ext4.</div>}
      {lowSpace && <div className="card notice"><strong>Pouco espaço livre</strong> no disco das músicas ({disk(s.music)}).</div>}
      <dl className="kv">
        <dt>Músicas ({s.stationsDir})</dt><dd>{label(s.music)} — {disk(s.music)}</dd>
        <dt>Sistema ({s.dataDir})</dt><dd>{label(s.system)} — {disk(s.system)}</dd>
        <dt>Total na biblioteca</dt><dd>{gb(s.mediaBytes)}</dd>
      </dl>
    </div>
  );
}
