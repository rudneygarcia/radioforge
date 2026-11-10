import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { CopyButton, Icon } from '../ui';
import type { StationCtx } from './StationLayout';

const TYPES = {
  player: { label: 'Player', desc: 'Capa, nome, música tocando, botão ouvir e volume.', height: 460 },
  requests: { label: 'Pedido de músicas', desc: 'Busca no catálogo, botão pedir, resposta do envio e lista dos pedidos.', height: 560 },
  history: { label: 'Últimas músicas', desc: 'As últimas músicas tocadas, com capa.', height: 420 },
} as const;
type WType = keyof typeof TYPES;

/** Gera o código (iframe) para incorporar os widgets da rádio em qualquer site. */
export default function WidgetsPage() {
  const { station } = useOutletContext<StationCtx>();
  const [type, setType] = useState<WType>('player');
  const [theme, setTheme] = useState<'auto' | 'light' | 'dark'>('auto');
  const [accent, setAccent] = useState('#6d7cff');
  const [height, setHeight] = useState<number>(TYPES.player.height);
  const [transparent, setTransparent] = useState(false);

  const url = useMemo(() => {
    const q = new URLSearchParams();
    if (theme !== 'auto') q.set('theme', theme);
    if (accent.toLowerCase() !== '#6d7cff') q.set('accent', accent.replace('#', ''));
    if (transparent) q.set('bg', 'transparent');
    const qs = q.toString();
    return `${location.origin}/widget/${station.slug}/${type}${qs ? `?${qs}` : ''}`;
  }, [station.slug, type, theme, accent, transparent]);

  const code = `<iframe src="${url}" width="100%" height="${height}" style="border:0;max-width:520px;border-radius:16px" loading="lazy" allow="autoplay" title="${TYPES[type].label} - ${station.name.replace(/"/g, '')}"></iframe>`;

  return (
    <div className="dash">
      <div className="dash-col">
        <section className="pcard">
          <header className="pcard-hd"><h3>Widgets para o seu site</h3></header>
          <div className="pcard-bd">
            <p className="muted" style={{ marginTop: 0 }}>Escolha o widget, ajuste o visual e cole o código no site (WordPress, Wix, HTML…). O widget usa os dados desta rádio em tempo real.</p>
            <div className="fields">
              <label className="field">
                <span>Widget</span>
                <select value={type} onChange={(e) => { const t = e.target.value as WType; setType(t); setHeight(TYPES[t].height); }}>
                  {(Object.keys(TYPES) as WType[]).map((k) => <option key={k} value={k}>{TYPES[k].label}</option>)}
                </select>
                <small className="hint">{TYPES[type].desc}</small>
              </label>
              <div className="field-row">
                <label className="field">
                  <span>Tema</span>
                  <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
                    <option value="auto">Automático (do aparelho)</option>
                    <option value="light">Claro</option>
                    <option value="dark">Escuro</option>
                  </select>
                </label>
                <label className="field">
                  <span>Cor de destaque</span>
                  <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} style={{ padding: 2, height: 42 }} />
                </label>
                <label className="field">
                  <span>Altura (px)</span>
                  <input type="number" min={200} max={1200} value={height} onChange={(e) => setHeight(Math.max(200, Math.min(1200, Number(e.target.value) || 200)))} />
                </label>
              </div>
              <label className="check-line">
                <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
                <span>Fundo transparente<small>O fundo do widget fica transparente e usa o do seu site.</small></span>
              </label>
            </div>
          </div>
        </section>

        <section className="pcard">
          <header className="pcard-hd"><h3>Código para incorporar</h3></header>
          <div className="pcard-bd">
            <textarea readOnly rows={5} value={code} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12.5 }} />
            <div className="row" style={{ margin: '10px 0 0' }}>
              <CopyButton text={code} label="Copiar código" />
              <CopyButton text={url} label="Copiar só o link" />
              <a className="button ghost small" href={url} target="_blank" rel="noreferrer"><Icon name="link" size={14} /> Abrir em outra aba</a>
            </div>
            <p className="muted small-text" style={{ margin: '10px 0 0' }}>O site que receber o widget precisa abrir em HTTPS se o painel estiver em HTTPS. A altura é só uma sugestão: ajuste ao seu layout.</p>
          </div>
        </section>
      </div>

      <div className="dash-col">
        <section className="pcard">
          <header className="pcard-hd"><h3>Pré-visualização</h3></header>
          <div className="pcard-bd" style={{ background: theme === 'dark' ? '#0b0e14' : undefined }}>
            <iframe key={url} src={url} title="Pré-visualização do widget" style={{ border: 0, width: '100%', maxWidth: 520, height, borderRadius: 16, display: 'block', margin: '0 auto' }} allow="autoplay" />
          </div>
        </section>
      </div>
    </div>
  );
}
