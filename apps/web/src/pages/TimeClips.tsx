import { useEffect, useRef, useState } from 'react';
import { api, getToken, uploadForm, type Station } from '../api';
import { Icon, useUi } from '../ui';

interface Clip {
  hour: number;
  minute: number;
  originalName: string;
  duration: number;
  size: number;
}
interface Result {
  name: string;
  status: 'ok' | 'error';
  slot?: string;
  replaced?: boolean;
  message?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Arquivos de áudio da hora certa: enviar vários de uma vez (a hora vem do nome), conferir o resultado e ouvir/trocar/excluir cada horário. */
export default function TimeClips({ station, isAdmin, voiceFallback }: { station: Station; isAdmin: boolean; voiceFallback: boolean }) {
  const { confirm, toast } = useUi();
  const base = `/api/stations/${station.id}/time-clips`;
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [report, setReport] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const slotInput = useRef<HTMLInputElement>(null);
  const slotTarget = useRef<{ hour: number; minute: number } | null>(null);

  const minutes = station.timeAnnounce === 15 ? [0, 15, 30, 45] : station.timeAnnounce === 30 ? [0, 30] : [0];
  const load = () => api<Clip[]>(base).then(setClips);
  useEffect(() => {
    load();
  }, [station.id]);

  const has = (h: number, m: number) => clips?.find((c) => c.hour === h && c.minute === m);
  const needed = HOURS.flatMap((h) => minutes.map((m) => [h, m] as const));
  const missing = needed.filter(([h, m]) => !has(h, m));
  const haveCount = needed.length - missing.length;

  async function send(files: FileList | File[] | null, slot?: { hour: number; minute: number }) {
    if (!files || !files.length) return;
    setBusy(true);
    setReport(null);
    try {
      const form = new FormData();
      for (const f of files) form.append('file', f);
      const qs = slot ? `?hour=${slot.hour}&minute=${slot.minute}` : '';
      const r = await uploadForm<{ results: Result[]; clips: Clip[] }>(`${base}${qs}`, form).promise;
      setClips(r.clips);
      setReport(r.results);
      const ok = r.results.filter((x) => x.status === 'ok').length;
      const bad = r.results.length - ok;
      toast(bad === 0 ? `${ok} arquivo(s) aceito(s)` : `${ok} aceito(s), ${bad} recusado(s): veja o relatório`, bad === 0 ? 'ok' : 'error');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      if (slotInput.current) slotInput.current.value = '';
    }
  }

  async function play(h: number, m: number) {
    try {
      const token = getToken();
      const res = await fetch(`${base}/${h}/${m}/audio`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('Não foi possível carregar o áudio');
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function remove(h: number, m: number) {
    if (!(await confirm({ title: `Excluir o arquivo das ${pad(h)}:${pad(m)}?`, message: 'Nesse horário a rádio passa a usar a voz sintética (se estiver ligada) ou não avisa a hora.', confirmLabel: 'Excluir', danger: true }))) return;
    await api(`${base}/${h}/${m}`, { method: 'DELETE' });
    toast('Arquivo excluído');
    load();
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title" style={{ marginBottom: 6 }}>
        <h3>Seus arquivos de áudio <span className="muted">({haveCount} de {needed.length} horários)</span></h3>
        {isAdmin && (
          <label className="button">
            <Icon name="upload" /> {busy ? 'Enviando…' : 'Enviar arquivos'}
            <input ref={input} type="file" multiple hidden disabled={busy} accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,audio/*" onChange={(e) => send(e.target.files)} />
          </label>
        )}
      </div>
      <p className="muted small-text" style={{ marginTop: 0 }}>
        Envie todos de uma vez: a hora é descoberta pelo <strong>nome do arquivo</strong> — <code>00.mp3</code>, <code>07.mp3</code>, <code>14.mp3</code>… (hora cheia) e <code>14h30.mp3</code>, <code>14-30.mp3</code> ou <code>1430.mp3</code> (meia hora). Também entendem <code>hora_14.mp3</code>, <code>meio-dia.mp3</code> e <code>meia-noite.mp3</code>. Aceita MP3, WAV, OGG, FLAC, M4A ou AAC, de até 10 MB e 60 s. Cada arquivo é conferido e o resultado aparece abaixo.
      </p>

      {report && (
        <div className="card" style={{ margin: '12px 0', background: 'var(--panel-2)', boxShadow: 'none' }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <strong>Resultado do envio</strong>
            <button type="button" className="ghost small" onClick={() => setReport(null)}>Fechar</button>
          </div>
          <div className="upload-list">
            {report.map((r, i) => (
              <div className="upload-item" key={i}>
                <span className="ellipsis" title={r.name}>{r.name}</span>
                <span className={`st ${r.status === 'ok' ? 'done' : 'error'}`}>
                  {r.status === 'ok' ? `✓ ${r.slot}${r.replaced ? ' (substituiu o anterior)' : ''}` : r.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {clips && station.timeAnnounce > 0 && missing.length > 0 && (
        <p className={voiceFallback ? 'muted small-text' : 'error small-text'}>
          {voiceFallback
            ? `Sem arquivo em ${missing.length} horário(s): neles a rádio usa a voz sintética.`
            : `Sem arquivo em ${missing.length} horário(s) e a voz sintética está desligada: nesses horários a rádio NÃO avisa a hora (${missing.slice(0, 8).map(([h, m]) => `${pad(h)}:${pad(m)}`).join(', ')}${missing.length > 8 ? '…' : ''}).`}
        </p>
      )}

      <input ref={slotInput} type="file" hidden accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,audio/*" onChange={(e) => slotTarget.current && send(e.target.files, slotTarget.current)} />
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 70 }}>Hora</th>
              {minutes.map((m) => <th key={m}>:{pad(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {HOURS.map((h) => (
              <tr key={h}>
                <td><strong>{pad(h)}h</strong></td>
                {minutes.map((m) => {
                  const c = has(h, m);
                  return (
                    <td key={m}>
                      {c ? (
                        <span className="row" style={{ margin: 0, gap: 6, flexWrap: 'nowrap' }}>
                          <button type="button" className="icon-btn" title={`Ouvir ${c.originalName}`} onClick={() => play(h, m)}><Icon name="play" size={14} /></button>
                          <span className="small-text ellipsis" style={{ maxWidth: 150 }} title={c.originalName}>✓ {c.originalName} <span className="muted">· {c.duration.toFixed(1)}s</span></span>
                          {isAdmin && (
                            <>
                              <button type="button" className="icon-btn" title="Trocar o arquivo" onClick={() => { slotTarget.current = { hour: h, minute: m }; slotInput.current?.click(); }}><Icon name="upload" size={14} /></button>
                              <button type="button" className="icon-btn" title="Excluir" onClick={() => remove(h, m)}><Icon name="trash" size={14} /></button>
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="muted small-text">
                          — {isAdmin && <button type="button" className="ghost small" style={{ marginLeft: 6 }} onClick={() => { slotTarget.current = { hour: h, minute: m }; slotInput.current?.click(); }}>Enviar</button>}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
