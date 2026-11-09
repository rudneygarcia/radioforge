import { useEffect, useRef, useState } from 'react';
import { api, getToken, uploadForm, type Station } from '../api';
import { Icon, useUi } from '../ui';

interface VoiceInfo {
  voice: string;
  count: number;
}
interface Clip {
  hour: number;
  minute: number;
  originalName: string;
  duration: number;
}
interface Overview {
  voices: VoiceInfo[];
  active: string | null;
  voice: string | null;
  clips: Clip[];
}
interface Job {
  status: 'running' | 'done' | 'error';
  total: number;
  processed: number;
  accepted: number;
  replaced: number;
  rejected: number;
  voices: Record<string, number>;
  errors: { name: string; message: string }[];
  message?: string;
}
interface Result {
  name: string;
  status: 'ok' | 'error';
  voice?: string;
  slot?: string;
  replaced?: boolean;
  message?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const FULL = 1440; // um arquivo por minuto do dia
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Agrupa os minutos que faltam por hora: "00h: 05, 07 · 13h: 00–59". */
function missingSummary(clips: Clip[]): string[] {
  const have = new Set(clips.map((c) => c.hour * 60 + c.minute));
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    const miss: number[] = [];
    for (let m = 0; m < 60; m++) if (!have.has(h * 60 + m)) miss.push(m);
    if (miss.length === 0) continue;
    out.push(miss.length === 60 ? `${pad(h)}h: todos` : `${pad(h)}h: ${miss.map(pad).join(', ')}`);
  }
  return out;
}

/** Áudios da hora certa: envie tudo num ZIP (voz_HH_MM.mp3, uma voz por pasta ou prefixo), acompanhe o processamento e escolha a voz. */
export default function TimeClips({
  station,
  isAdmin,
  voiceFallback,
  voice,
  onVoice,
}: {
  station: Station;
  isAdmin: boolean;
  voiceFallback: boolean;
  voice: string;
  onVoice: (v: string) => void;
}) {
  const { confirm, toast } = useUi();
  const base = `/api/stations/${station.id}/time-clips`;
  const [ov, setOv] = useState<Overview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [sending, setSending] = useState<number | null>(null); // % do envio do ZIP até o servidor
  const [report, setReport] = useState<Result[] | null>(null);
  const [open, setOpen] = useState<string | null>(null); // voz com a lista do que falta aberta
  const [detail, setDetail] = useState<Clip[]>([]);
  const [when, setWhen] = useState('14:30');
  const zipInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => api<Overview>(base).then(setOv);
  useEffect(() => {
    load();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [station.id]);

  const active = ov?.active ?? null;
  const chosen = voice && ov?.voices.some((v) => v.voice === voice) ? voice : active;

  function watch(jobId: string) {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const j = await api<Job>(`${base}/zip/${jobId}`);
        setJob(j);
        if (j.status !== 'running') {
          if (poll.current) clearInterval(poll.current);
          load();
          toast(j.status === 'done' ? `${j.accepted} áudio(s) processado(s)${j.rejected ? `, ${j.rejected} recusado(s)` : ''}` : (j.message ?? 'Falha ao processar o ZIP'), j.status === 'done' && !j.rejected ? 'ok' : 'error');
        }
      } catch (e) {
        if (poll.current) clearInterval(poll.current);
        toast((e as Error).message, 'error');
      }
    }, 1000);
  }

  async function sendZip(file?: File) {
    if (!file) return;
    setReport(null);
    setJob(null);
    setSending(0);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await uploadForm<{ jobId: string }>(`${base}/zip`, form, (l, t) => setSending(Math.round((l / t) * 100))).promise;
      setSending(null);
      setJob({ status: 'running', total: 0, processed: 0, accepted: 0, replaced: 0, rejected: 0, voices: {}, errors: [] });
      watch(r.jobId);
    } catch (e) {
      setSending(null);
      toast((e as Error).message, 'error');
    } finally {
      if (zipInput.current) zipInput.current.value = '';
    }
  }

  async function sendFiles(files: FileList | null) {
    if (!files || !files.length) return;
    setJob(null);
    try {
      const form = new FormData();
      for (const f of files) form.append('file', f);
      const r = await uploadForm<{ results: Result[] }>(base, form).promise;
      setReport(r.results);
      load();
      const bad = r.results.filter((x) => x.status === 'error').length;
      toast(bad ? `${r.results.length - bad} aceito(s), ${bad} recusado(s)` : `${r.results.length} aceito(s)`, bad ? 'error' : 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      if (filesInput.current) filesInput.current.value = '';
    }
  }

  async function toggleMissing(v: string) {
    if (open === v) return setOpen(null);
    const d = await api<Overview>(`${base}?voice=${encodeURIComponent(v)}`);
    setDetail(d.clips);
    setOpen(v);
  }

  async function play(v: string) {
    const [h, m] = when.split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return toast('Informe o horário (HH:MM)', 'error');
    try {
      const token = getToken();
      const res = await fetch(`${base}/${encodeURIComponent(v)}/${h}/${m}/audio`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`Não há arquivo da voz ${v} para ${pad(h)}:${pad(m)}`);
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function removeVoice(v: string, count: number) {
    if (!(await confirm({ title: `Excluir a voz "${v}"?`, message: `Os ${count} arquivos dessa voz serão apagados do servidor.`, confirmLabel: 'Excluir voz', danger: true }))) return;
    await api(`${base}/${encodeURIComponent(v)}`, { method: 'DELETE' });
    toast('Voz excluída');
    if (voice === v) onVoice('');
    setOpen(null);
    load();
  }

  const pct = job && job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title" style={{ marginBottom: 6 }}>
        <h3>Seus áudios da hora certa</h3>
        {isAdmin && (
          <div className="row" style={{ margin: 0 }}>
            <label className="button">
              <Icon name="upload" /> {sending !== null ? `Enviando… ${sending}%` : 'Enviar ZIP'}
              <input ref={zipInput} type="file" hidden accept=".zip,application/zip" disabled={sending !== null || job?.status === 'running'} onChange={(e) => sendZip(e.target.files?.[0])} />
            </label>
            <label className="button ghost" style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-strong)' }}>
              Arquivos soltos
              <input ref={filesInput} type="file" multiple hidden accept=".mp3,.wav,.ogg,.flac,.m4a,.aac,audio/*" onChange={(e) => sendFiles(e.target.files)} />
            </label>
          </div>
        )}
      </div>
      <p className="muted small-text" style={{ marginTop: 0 }}>
        Coloque todos os áudios num <strong>único ZIP</strong> (pode ter pastas e várias vozes; até 400 MB) e envie: o servidor lê o nome de cada arquivo e processa tudo sozinho. Os nomes seguem o padrão <code>masculino_00_02.mp3</code> = <strong>voz</strong> <code>masculino</code>, <strong>hora</strong> 00, <strong>minuto</strong> 02 (um arquivo por minuto do dia, 1440 por voz). Também valem <code>14h30.mp3</code>, <code>14-30.mp3</code>, <code>14.mp3</code>… (a voz então vem da pasta, ou fica "padrao"). MP3, WAV, OGG, FLAC, M4A ou AAC, até 10 MB e 60 s cada.
      </p>

      {sending !== null && (
        <div className="card" style={{ margin: '10px 0', background: 'var(--panel-2)', boxShadow: 'none' }}>
          <strong>Enviando o ZIP… {sending}%</strong>
          <div className="progress" style={{ marginTop: 8 }}><i style={{ width: `${sending}%` }} /></div>
        </div>
      )}

      {job && (
        <div className="card" style={{ margin: '10px 0', background: 'var(--panel-2)', boxShadow: 'none' }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <strong>
              {job.status === 'running' ? `Processando o ZIP… ${job.processed} de ${job.total || '?'}` : job.status === 'done' ? 'ZIP processado' : 'Falha ao processar o ZIP'}
            </strong>
            {job.status !== 'running' && <button type="button" className="ghost small" onClick={() => setJob(null)}>Fechar</button>}
          </div>
          <div className={`progress ${job.status === 'done' ? (job.rejected ? 'error' : 'done') : job.status === 'error' ? 'error' : job.total ? '' : 'indeterminate'}`}><i style={{ width: `${job.status === 'done' ? 100 : pct}%` }} /></div>
          <p className="small-text" style={{ margin: '8px 0 0' }}>
            ✓ {job.accepted} aceito(s){job.replaced ? ` (${job.replaced} substituíram arquivos antigos)` : ''} · {job.rejected} recusado(s)
            {Object.keys(job.voices).length > 0 && <span className="muted"> · {Object.entries(job.voices).map(([v, n]) => `${v}: ${n}`).join(' · ')}</span>}
          </p>
          {job.message && <p className="error small-text">{job.message}</p>}
          {job.errors.length > 0 && (
            <div className="upload-list" style={{ marginTop: 8 }}>
              {job.errors.map((e, i) => (
                <div className="upload-item" key={i}><span className="ellipsis" title={e.name}>{e.name}</span><span className="st error">{e.message}</span></div>
              ))}
              {job.rejected > job.errors.length && <p className="muted small-text">…e mais {job.rejected - job.errors.length} recusado(s).</p>}
            </div>
          )}
        </div>
      )}

      {report && (
        <div className="card" style={{ margin: '10px 0', background: 'var(--panel-2)', boxShadow: 'none' }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <strong>Resultado do envio</strong>
            <button type="button" className="ghost small" onClick={() => setReport(null)}>Fechar</button>
          </div>
          <div className="upload-list">
            {report.map((r, i) => (
              <div className="upload-item" key={i}>
                <span className="ellipsis" title={r.name}>{r.name}</span>
                <span className={`st ${r.status === 'ok' ? 'done' : 'error'}`}>{r.status === 'ok' ? `✓ ${r.voice} ${r.slot}${r.replaced ? ' (substituiu)' : ''}` : r.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {ov && ov.voices.length === 0 && <p className="muted">Nenhum áudio enviado ainda.{voiceFallback ? ' Enquanto isso, a rádio usa a voz sintética.' : ' A voz sintética está desligada: a rádio não vai avisar a hora.'}</p>}

      {ov && ov.voices.length > 0 && (
        <>
          <div className="field" style={{ maxWidth: 360, marginBottom: 10 }}>
            <span>Voz em uso</span>
            <select value={chosen ?? ''} onChange={(e) => onVoice(e.target.value)} disabled={!isAdmin}>
              {ov.voices.map((v) => <option key={v.voice} value={v.voice}>{cap(v.voice)} ({v.count} de {FULL})</option>)}
            </select>
            <small className="hint">Salve as configurações para valer. Se a voz escolhida não tiver um minuto, a rádio usa o mesmo minuto de outra voz enviada.</small>
          </div>
          <div className="row" style={{ margin: '0 0 10px' }}>
            <span className="muted small-text">Ouvir o horário</span>
            <input type="time" value={when} onChange={(e) => setWhen(e.target.value)} style={{ width: 120 }} />
            {chosen && <button type="button" className="ghost small" onClick={() => play(chosen)}><Icon name="play" size={13} /> Ouvir ({cap(chosen)})</button>}
          </div>
          <table>
            <thead><tr><th>Voz</th><th>Horários cobertos</th><th /></tr></thead>
            <tbody>
              {ov.voices.map((v) => (
                <tr key={v.voice}>
                  <td><strong>{cap(v.voice)}</strong> {chosen === v.voice && <span className="badge on" style={{ marginLeft: 6 }}>em uso</span>}</td>
                  <td>
                    {v.count} de {FULL} {v.count >= FULL ? <span className="muted">· completa ✓</span> : <span style={{ color: 'var(--danger)' }}>· faltam {FULL - v.count}</span>}
                  </td>
                  <td>
                    <div className="table-actions">
                      {v.count < FULL && <button type="button" className="ghost small" onClick={() => toggleMissing(v.voice)}>{open === v.voice ? 'Ocultar' : 'Ver o que falta'}</button>}
                      {isAdmin && <button type="button" className="icon-btn" title="Excluir esta voz" onClick={() => removeVoice(v.voice, v.count)}><Icon name="trash" /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {open && (
            <div className="card" style={{ margin: '10px 0 0', background: 'var(--panel-2)', boxShadow: 'none' }}>
              <strong>Minutos sem arquivo na voz {cap(open)}</strong>
              <div className="upload-list" style={{ marginTop: 6 }}>
                {missingSummary(detail).map((l) => <div key={l} className="small-text" style={{ padding: '3px 0' }}>{l}</div>)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
