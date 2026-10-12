import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { useToastStore, type ToastItem, type ToastType } from '../stores/toastStore';

/** 自动消失时长（ms） */
const AUTO_DISMISS_MS = 3000;

const TOAST_ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 size={16} className="shrink-0 text-success" aria-hidden="true" />,
  info: <Info size={16} className="shrink-0 text-accent" aria-hidden="true" />,
  warning: <TriangleAlert size={16} className="shrink-0 text-warning" aria-hidden="true" />,
};

/** 全局 Toast 视口（单例，挂在 App 根部） */
export function ToastViewport() {
  const toasts = useToastStore((state) => state.toasts);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed top-3 left-1/2 z-[var(--jk-z-toast)] flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>,
    document.body,
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((state) => state.dismissToast);

  // 自动消失
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(item.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [dismiss, item.id]);

  return (
    <div className="pointer-events-auto flex min-w-56 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 shadow-panel">
      {TOAST_ICONS[item.type]}
      <span className="flex-1 text-ui text-fg">{item.message}</span>
      <button
        type="button"
        aria-label="关闭提示"
        className="shrink-0 text-muted transition-colors hover:text-fg"
        onClick={() => dismiss(item.id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}
