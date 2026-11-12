import { useCallback, useEffect, useState } from 'react';
import { api, getToken, uploadForm } from '../api';
import { Icon, useUi } from '../ui';

interface Lib {
  present: boolean;
  size: number;
  updatedAt: string | null;
  name: string;
}

/** Stereo Tool: biblioteca do servidor (.so), preset (.sts) por estação e chave de licença. */
export default function StereoTool({
  stationId,
  isAdmin,
  isSystem,
  enabled,
  onEnabled,
}: {
  stationId: number;
  isAdmin: boolean;
  isSystem: boolean;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
}) {
  const { toast, confirm } = useUi();
  const [lib, setLib] = useState<Lib | null>(null);
  const [busy, setBusy] = useState(false);
  // Andamento do envio: mostra a barra, o "processando" no servidor e o resultado (ou o erro) na tela.
  const [up, setUp] = useState<{ name: string; pct: number; stage: 'sending' | 'processing' | 'done' | 'error'; msg: string } | null>(null);
  // Resultado da escolha automática: cada biblioteca do ZIP e se carregou ou por que não.
  const [tries, setTries] = useState<{ name: string; ok: boolean; note: string }[] | null>(null);
  const [diag, setDiag] = useState<string | null>(null);
  const inspect = async () => {
    setDiag('Analisando…');
    try {
      const r = await api<{ present: boolean; arch?: string; size?: number; missing?: string[]; ldd?: string; symbols?: string[] }>('/api/stereotool/inspect');
      if (!r.present) return setDiag('Biblioteca não enviada.');
      setDiag(
        [
          `Arquitetura: ${r.arch}`,
          `Tamanho: ${((r.size ?? 0) / 1024 / 1024).toFixed(1)} MB`,
          `Dependências que faltam: ${r.missing && r.missing.length ? r.missing.join(' | ') : 'nenhuma'}`,
          '',
          'Funções com “stereo” no nome:',
          ...(r.symbols && r.symbols.length ? r.symbols : ['(nenhuma encontrada — provavelmente não é a biblioteca de plugin)']),
          '',
          'ldd:',
          r.ldd ?? '',
        ].join('\n'),
      );
    } catch (e) {
      setDiag((e as Error).message);
    }
  };
  const [key, setKey] = useState('');
  const [keySet, setKeySet] = useState(false);

  const load = useCallback(() => {
    api<{ library: Lib; keySet: boolean }>('/api/stereotool').then((r) => { setLib(r.library); setKeySet(r.keySet); }).catch(() => {});
  }, [stationId]);
  useEffect(load, [load]);

  async function send(path: string, file: File | undefined, done: string) {
    if (!file) return;
    if (path.endsWith('/library')) return sendLibrary(file);
    setBusy(true);
    const mb = (file.size / 1024 / 1024).toFixed(1);
    setUp({ name: `${file.name} (${mb} MB)`, pct: 0, stage: 'sending', msg: 'Enviando…' });
    try {
      const form = new FormData();
      form.append('file', file);
      await uploadForm(path, form, (loaded, total) => {
        const pct = Math.round((loaded / total) * 100);
        setUp((cur) => (cur ? { ...cur, pct, stage: pct >= 100 ? 'processing' : 'sending', msg: pct >= 100 ? 'Enviado. O servidor está verificando o arquivo…' : `Enviando… ${pct}%` } : cur));
      }).promise;
      setUp((cur) => (cur ? { ...cur, pct: 100, stage: 'done', msg: done } : cur));
      toast(done);
      load();
    } catch (e) {
      const msg = (e as Error).message;
      setUp((cur) => (cur ? { ...cur, stage: 'error', msg } : cur));
      toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** Envia o ZIP/.so em partes de 40 MB (cada requisição é pequena para o proxy) e deixa o servidor escolher a biblioteca certa. */
  async function sendLibrary(file: File) {
    setBusy(true);
    setTries(null);
    const CH = 40 * 1024 * 1024;
    const headers: Record<string, string> = getToken() ? { Authorization: `Bearer ${getToken()}` } : {};
    const label = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
    const fail = (msg: string) => {
      setUp({ name: label, pct: 100, stage: 'error', msg });
      toast(msg, 'error');
    };
    try {
      setUp({ name: label, pct: 0, stage: 'sending', msg: 'Preparando o envio…' });
      const start = await api<{ id: string }>('/api/stereotool/upload', { method: 'POST', body: { name: file.name, size: file.size } });
      for (let off = 0, i = 0; off < file.size; off += CH, i++) {
        const piece = file.slice(off, off + CH);
        const pct = Math.round((off / file.size) * 100);
        setUp({ name: label, pct, stage: 'sending', msg: `Enviando… ${pct}% (parte ${i + 1} de ${Math.ceil(file.size / CH)})` });
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          const res = await fetch(`/api/stereotool/upload/${start.id}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: piece }).catch(() => null);
          ok = !!res && res.ok;
          if (!ok && attempt === 2) return fail(`Falha ao enviar a parte ${i + 1} (${res ? `erro ${res.status}` : 'sem conexão'}).`);
        }
      }
      setUp({ name: label, pct: 100, stage: 'processing', msg: 'Enviado. O servidor está extraindo as bibliotecas e testando uma por uma no Liquidsoap (pode levar um minuto)…' });
      const r = await api<{ chosen: string | null; results: { name: string; ok: boolean; note: string }[] }>(`/api/stereotool/upload/${start.id}/finish`, { method: 'POST' });
      setTries(r.results);
      if (r.chosen) {
        setUp({ name: label, pct: 100, stage: 'done', msg: `Pronto: o servidor escolheu ${r.chosen}.` });
        toast('Biblioteca instalada');
      } else fail('Nenhuma das bibliotecas do arquivo carregou no Liquidsoap (veja abaixo o motivo de cada uma).');
      load();
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveKey(k: string) {
    setBusy(true);
    try {
      await api('/api/stereotool/license', { method: 'PUT', body: { key: k } });
      setKey('');
      toast(k ? 'Chave salva' : 'Chave removida');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeLib() {
    if (!(await confirm({ title: 'Remover a biblioteca do Stereo Tool?', message: 'As estações que usam o Stereo Tool voltam para o processador interno ao reiniciar.', confirmLabel: 'Remover', danger: true }))) return;
    await api('/api/stereotool/library', { method: 'DELETE' });
    load();
  }

  return (
    <div className="fields">
      <p className="muted" style={{ marginTop: -4 }}>
        O <strong>Stereo Tool</strong> é um processador de áudio profissional <strong>pago</strong>: você usa a sua própria licença, uma só para todas as estações. Envie o <strong>ZIP do plugin para Liquidsoap</strong> baixado do site do Stereo Tool (“x86/64 Linux libStereoTool plugin”) uma vez para o servidor: o painel acha a biblioteca Linux 64 bits dentro dele (um <code>.so</code> solto também serve), e o preset (<code>.sts</code>) de cada estação. Ligado, ele substitui o
        processador interno. Ele usa bastante CPU: ligue só nas estações que precisam.
      </p>

      {up && (
        <div className={`req-msg ${up.stage === 'error' ? 'err' : up.stage === 'done' ? 'ok' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} role="status">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Icon name={up.stage === 'error' ? 'alert' : up.stage === 'done' ? 'check' : 'upload'} size={18} />
            <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{up.name}</strong>
            {(up.stage === 'done' || up.stage === 'error') && <button type="button" className="icon-btn" onClick={() => setUp(null)} aria-label="Fechar"><Icon name="x" size={14} /></button>}
          </div>
          <div className={`progress${up.stage === 'processing' ? ' indeterminate' : ''}${up.stage === 'done' ? ' done' : ''}${up.stage === 'error' ? ' error' : ''}`}><i style={{ width: `${up.stage === 'error' ? 100 : up.pct}%` }} /></div>
          <span>{up.msg}</span>
        </div>
      )}

      {tries && (
        <div className="card" style={{ padding: 14 }}>
          <strong>Bibliotecas encontradas no arquivo</strong>
          {tries.map((t) => (
            <p key={t.name} className="small-text" style={{ margin: '6px 0 0', color: t.ok ? 'var(--ok, #16a34a)' : undefined }}>
              {t.ok ? '✔' : '✖'} <strong>{t.name}</strong> — {t.note}
            </p>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 14 }}>
        <strong>1. Biblioteca e licença (do servidor, valem para todas as estações)</strong>
        <p className="muted small-text" style={{ margin: '4px 0 8px' }}>
          {lib === null ? 'Verificando…' : lib.present ? `Enviada: ${lib.name || 'biblioteca'} (${(lib.size / 1024 / 1024).toFixed(1)} MB).` : 'Ainda não enviada.'}
        </p>
        {isSystem && (
          <div className="row" style={{ margin: 0 }}>
            <label className="button ghost small">
              {busy ? 'Enviando…' : lib?.present ? 'Trocar biblioteca' : 'Enviar o ZIP do plugin (inteiro)'}
              <input type="file" hidden accept=".zip,.so" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void send('/api/stereotool/library', f, 'Biblioteca enviada'); }} />
            </label>
            {lib?.present && <button type="button" className="ghost small" onClick={inspect}><Icon name="info" size={13} /> Testar biblioteca</button>}
            {lib?.present && <button type="button" className="ghost small" onClick={removeLib}><Icon name="trash" size={13} /> Remover</button>}
          </div>
        )}
        {diag && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, maxHeight: 260, overflow: 'auto', margin: '10px 0 0' }}>{diag}</pre>}
        <label className="field" style={{ marginTop: 12 }}>
          <span>Chave de licença {keySet && <em className="hint">(já salva)</em>}</span>
          <div className="row" style={{ margin: 0 }}>
            <input type="password" autoComplete="off" value={key} placeholder={keySet ? '•••••••• (digite para trocar)' : 'Cole a chave da sua licença'} onChange={(e) => setKey(e.target.value)} disabled={!isSystem} style={{ flex: 1, minWidth: 180 }} />
            {isSystem && <button type="button" className="small" disabled={busy || !key.trim()} onClick={() => saveKey(key)}>Salvar chave</button>}
            {isSystem && keySet && <button type="button" className="ghost small" onClick={() => saveKey('')}>Remover</button>}
          </div>
          <small className="hint">Uma só chave para o servidor inteiro (vale para todas as estações); fica só no servidor e nunca é exibida de volta. Sem licença válida o Stereo Tool roda limitado. Vale ao reiniciar as estações.</small>
        </label>
      </div>

      <label className="check-line" style={{ opacity: isAdmin ? 1 : 0.55 }}>
        <input type="checkbox" checked={enabled} disabled={!isAdmin} onChange={(e) => onEnabled(e.target.checked)} />
        <span>Usar o Stereo Tool nesta estação<small>Vale ao salvar (a estação reinicia). Se o Liquidsoap não carregar a biblioteca, a rádio sobe com o processador interno e o painel avisa.</small></span>
      </label>

      <p className="muted small-text" style={{ margin: 0 }}>O preset (.sts) de cada estação é enviado e escolhido no menu <strong>Stereo Tool</strong> da própria estação.</p>
    </div>
  );
}
