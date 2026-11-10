import LogoMark from '../Logo';
import type { ReactNode } from 'react';
import { Icon } from '../ui';

/** Moldura das telas de acesso (entrar, esqueci a senha, nova senha): painel de marca à esquerda e formulário à direita. */
export default function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="login-page">
      <aside className="login-brand">
        <div className="login-brand-in">
          <div className="login-logo"><LogoMark size={40} light /> RadioForge</div>
          <h2>Sua rádio no ar, do jeito profissional.</h2>
          <p>AutoDJ inteligente, transmissão ao vivo, programação por horário, blocos comerciais e relatórios de ouvintes em um só painel.</p>
          <ul>
            <li><Icon name="music" size={18} /> AutoDJ com passagens perfeitas entre músicas</li>
            <li><Icon name="mic" size={18} /> DJs ao vivo com retorno automático</li>
            <li><Icon name="users" size={18} /> Ouvintes em tempo real, com cidade e aparelho</li>
            <li><Icon name="megaphone" size={18} /> Blocos comerciais com comprovante de veiculação</li>
          </ul>
        </div>
      </aside>
      <main className="login-main">
        <div className="login-card">
          <div className="login-mobile-logo"><LogoMark size={32} /> RadioForge</div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}
