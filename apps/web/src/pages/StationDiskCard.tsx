import { useEffect, useState } from 'react';
import { api, type Station } from '../api';
import { DiskSelect, useDisks } from '../DiskSelect';
import { useUi } from '../ui';

/** Em qual disco (HD) entram as músicas NOVAS desta estação (envio pelo painel e por SFTP). Só administrador. */
export default function StationDiskCard({ station, reload }: { station: Station; reload: () => void }) {
  const { toast } = useUi();
  const disks = useDisks();
  const [pick, setPick] = useState(station.disk);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPick(station.disk), [station.disk]);

  if (!disks || disks.length < 2) return null; // só um disco: nada para escolher

  async function save() {
    setBusy(true);
    try {
      await api(`/api/stations/${station.id}/disk`, { method: 'PUT', body: { disk: pick } });
      toast('Disco das músicas salvo');
      reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card section">
      <div className="section-title"><h3>Disco das músicas</h3></div>
      <p className="muted" style={{ marginTop: -4 }}>Tudo que for enviado para a biblioteca desta estação (pelo painel ou por SFTP) passa a ser gravado neste disco. As músicas que já estão na biblioteca continuam onde estão e tocam normalmente.</p>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <DiskSelect disks={disks} value={pick} onChange={setPick} />
        <button type="button" disabled={busy || pick === station.disk} onClick={save}>Salvar</button>
      </div>
    </div>
  );
}
