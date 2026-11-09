import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/* ---------- Ícones (SVG inline, traço 2px) ---------- */
const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14M10 11v6M14 11v6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  copy: 'M9 9h11v11H9zM5 15V5h10',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  upload: 'M12 16V5m0 0L8 9m4-4l4 4M5 20h14',
  play: 'M7 5l12 7-12 7z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 9v4m0 4h.01M10.3 4l-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0z',
  info: 'M12 8h.01M11 12h1v5h1M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  refresh: 'M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M20 4v5h-5M4 20v-5h5',
  stop: 'M7 7h10v10H7z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6',
  radio: 'M4 9h16v11H4zM8 9l8-5M8 14.5h.01M12 14.5h6M12 17.5h6',
  key: 'M14 10a4 4 0 1 1-3.5 6L4 22v-3H2v-2h3l5.5-5.5A4 4 0 0 1 14 10zm1-1h.01',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm9 3l-4.3-4.3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  back: 'M15 18l-6-6 6-6',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

/* ---------- Modal ---------- */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Foco no primeiro campo (ou no próprio diálogo) para o teclado funcionar de imediato.
    const t = setTimeout(() => (box.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea') ?? box.current)?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title} ref={box} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar" type="button"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------- Confirmação e avisos (contexto global) ---------- */
interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
type ToastKind = 'ok' | 'error' | 'info';
interface Ui {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  toast: (message: string, kind?: ToastKind) => void;
}
const Ctx = createContext<Ui | null>(null);
export const useUi = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi fora do UiProvider');
  return v;
};

export function UiProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  const seq = useRef(0);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), []);
  const toast = useCallback((message: string, kind: ToastKind = 'ok') => {
    const id = ++seq.current;
    setToasts((l) => [...l, { id, message, kind }]);
    setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  const close = (v: boolean) => {
    ask?.resolve(v);
    setAsk(null);
  };

  return (
    <Ctx.Provider value={{ confirm, toast }}>
      {children}
      <Modal
        open={!!ask}
        size="sm"
        title={ask?.title ?? ''}
        onClose={() => close(false)}
        footer={
          <>
            <button className="ghost" onClick={() => close(false)}>Cancelar</button>
            <button className={ask?.danger ? 'solid-danger' : ''} onClick={() => close(true)}>{ask?.confirmLabel ?? 'Confirmar'}</button>
          </>
        }
      >
        <div className={`confirm-body ${ask?.danger ? 'danger' : ''}`}>
          <span className="confirm-icon"><Icon name={ask?.danger ? 'alert' : 'info'} size={22} /></span>
          <div className="muted" style={{ margin: 0 }}>{ask?.message}</div>
        </div>
      </Modal>
      {createPortal(
        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'error' ? 'alert' : 'info'} />
              <span>{t.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

/* ---------- Blocos de página ---------- */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="row" style={{ margin: 0 }}>{actions}</div>}
    </div>
  );
}

export function Empty({ icon = 'music', title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={26} /></span>
      <strong>{title}</strong>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

/** Botão que copia um texto e avisa com um toast. */
export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const { toast } = useUi();
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('Não foi possível copiar', 'error'))}
    >
      <Icon name="copy" size={13} /> {label}
    </button>
  );
}
