import { useEffect, useState } from 'react';
import { api, type Station } from '../api';
import { DiskSelect, diskLabel, useDisks } from '../DiskSelect';
import { useUi } from '../ui';

/** Em qual disco (HD) ficam as músicas desta estação; trocar copia tudo para o disco novo. Só administrador. */
export default function StationDiskCard({ station, reload }: { station: Station; reload: () => void }) {
  const { confirm, toast } = useUi();
  const disks = useDisks();
  const [pick, setPick] = useState(station.disk);
  const [busy, setBusy] = useState(false);
  const moving = station.diskMove?.state === 'moving';

  // Durante a cópia, atualiza a tela até terminar.
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [moving, reload]);
  useEffect(() => setPick(station.disk), [station.disk]);

  if (!disks || disks.length < 2) return null; // só um disco: nada para escolher
  const current = disks.find((d) => d.id === station.disk);

  async function move() {
    const target = disks!.find((d) => d.id === pick);
    if (!target) return;
    const ok = await confirm({
      title: 'Mover as músicas para outro disco?',
      message: `As músicas desta estação serão copiadas para "${target.id ? target.name : 'Disco principal'}", conferidas e só então apagadas do disco atual. A estação fica parada durante a cópia (pode levar bastante tempo se a biblioteca for grande) e volta sozinha ao terminar.`,
      confirmLabel: 'Mover',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/api/stations/${station.id}/disk`, { method: 'PUT', body: { disk: pick } });
      toast('Movendo as músicas…');
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
      <p className="muted" style={{ marginTop: -4 }}>Onde os arquivos de música desta estação ficam gravados{current ? <>: <strong>{diskLabel(current)}</strong></> : null}.</p>
      {station.diskMove?.state === 'error' && <div className="card notice"><strong>Não foi possível mover:</strong> {station.diskMove.error}. As músicas continuam no disco anterior.</div>}
      {moving ? (
        <p><strong>Movendo as músicas…</strong> A estação volta ao ar sozinha quando terminar. Não feche o servidor.</p>
      ) : (
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <DiskSelect disks={disks} value={pick} onChange={setPick} />
          <button type="button" disabled={busy || pick === station.disk} onClick={move}>Mover músicas</button>
        </div>
      )}
    </div>
  );
}
