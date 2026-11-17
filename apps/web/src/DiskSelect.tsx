import { useEffect, useState } from 'react';
import { api } from './api';

export interface DiskInfo {
  id: string;
  name: string;
  total: number;
  free: number;
  device: string | null;
  fsType: string | null;
  writable: boolean;
}

export const fmtSize = (n: number) => (n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(1)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Discos onde as músicas podem ficar (principal + HDs extras). Só administrador; falha em silêncio (lista vazia). */
export function useDisks(): DiskInfo[] | null {
  const [disks, setDisks] = useState<DiskInfo[] | null>(null);
  useEffect(() => {
    api<DiskInfo[]>('/api/disks').then(setDisks).catch(() => setDisks([]));
  }, []);
  return disks;
}

export const diskLabel = (d: DiskInfo) =>
  `${d.id ? d.name : 'Disco principal (do sistema)'}${d.total > 0 ? ` — ${fmtSize(d.free)} livres de ${fmtSize(d.total)}` : ''}${d.writable ? '' : ' — sem permissão de gravar'}`;

export function DiskSelect({ disks, value, onChange, disabled }: { disks: DiskInfo[]; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {disks.map((d) => (
        <option key={d.id} value={d.id} disabled={!d.writable && d.id !== value}>{diskLabel(d)}</option>
      ))}
    </select>
  );
}
