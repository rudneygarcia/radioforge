import { useEffect } from 'react';

/**
 * Tema dos widgets (iframes nos sites dos clientes), pelos parâmetros da URL:
 * ?theme=light|dark (padrão: o do aparelho), ?accent=6d7cff (cor de destaque, hex sem #), ?bg=transparent.
 */
export function useWidgetTheme(embed: boolean) {
  useEffect(() => {
    if (!embed) return;
    const q = new URLSearchParams(location.search);
    const root = document.documentElement;
    const theme = q.get('theme');
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
    const accent = q.get('accent');
    if (accent && /^[0-9a-fA-F]{6}$/.test(accent)) {
      root.style.setProperty('--accent', `#${accent}`);
      root.style.setProperty('--accent-2', `color-mix(in srgb, #${accent} 70%, #a56bff)`);
    }
    if (q.get('bg') === 'transparent') {
      root.style.background = 'transparent';
      document.body.style.background = 'transparent';
      document.body.style.backgroundImage = 'none';
    }
  }, [embed]);
}
