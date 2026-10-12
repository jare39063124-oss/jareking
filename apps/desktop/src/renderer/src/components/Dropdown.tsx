import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface DropdownItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 危险操作（红色文字） */
  danger?: boolean;
  onSelect: () => void;
}

export interface DropdownProps {
  /** 触发器节点（包裹在可点击容器中） */
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  className?: string;
}

/** 下拉菜单：点击外部 / Esc 关闭，选中后自动收起 */
export function Dropdown({ trigger, items, align = 'left', className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 打开期间监听：点击菜单外部或按 Esc 时关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={`relative inline-flex ${className ?? ''}`}>
      <span className="inline-flex cursor-pointer" onClick={() => setOpen((value) => !value)}>
        {trigger}
      </span>
      {open ? (
        <div
          role="menu"
          className={`absolute top-full z-[var(--jk-z-dropdown)] mt-1 min-w-36 rounded-md border border-border bg-surface py-1 shadow-panel ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-ui transition-colors hover:bg-hover ${
                item.danger ? 'text-danger' : 'text-fg'
              }`}
              onClick={() => {
                item.onSelect();
                setOpen(false);
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
