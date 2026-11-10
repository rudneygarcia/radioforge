import { useId } from 'react';

/** Logo do RadioForge: ondas de transmissão saindo de um ponto central, num quadrado com degradê. */
export default function LogoMark({ size = 32, light = false }: { size?: number; light?: boolean }) {
  const id = useId();
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="RadioForge" style={{ flex: 'none', display: 'block', filter: 'drop-shadow(0 6px 12px color-mix(in srgb, var(--accent) 45%, transparent))' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b6bff" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={light ? "#fff" : `url(#${id})`} />
      <g fill="none" stroke={light ? `url(#${id})` : "#fff"} strokeWidth="4.6" strokeLinecap="round">
        <path d="M20.5 22.5a14 14 0 0 0 0 19" />
        <path d="M43.5 22.5a14 14 0 0 1 0 19" />
        <path d="M13.5 15.5a24 24 0 0 0 0 33" opacity=".55" />
        <path d="M50.5 15.5a24 24 0 0 1 0 33" opacity=".55" />
      </g>
      <circle cx="32" cy="32" r="5.6" fill={light ? "#6d5bff" : "#fff"} />
    </svg>
  );
}
