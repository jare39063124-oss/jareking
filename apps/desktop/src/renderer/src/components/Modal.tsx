import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './IconButton';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 标题栏文案 */
  title: string;
  children: ReactNode;
  /** 底部操作区（可选） */
  footer?: ReactNode;
  /** 面板最大宽度（px） */
  width?: number;
}

/** 模态面板：遮罩点击关闭、Esc 关闭、标题栏 + 可滚动内容区 */
export function Modal({ open, onClose, title, children, footer, width = 520 }: ModalProps) {
  // Esc 关闭（打开期间监听）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--jk-z-modal)] flex items-center justify-center p-6">
      {/* 遮罩层：点击关闭 */}
      <div className="absolute inset-0 bg-overlay" onClick={onClose} aria-hidden="true" />
      {/* 面板主体 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-overlay"
        style={{ maxWidth: width }}
      >
        {/* 标题栏 */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-ui font-semibold text-fg">{title}</h2>
          <IconButton label="关闭" size="sm" icon={<X size={14} />} onClick={onClose} />
        </div>
        {/* 内容区 */}
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {/* 底部操作区 */}
        {footer ? (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
