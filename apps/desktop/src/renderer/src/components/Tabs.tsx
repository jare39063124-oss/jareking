import type { ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  /** 当前激活的标签 id */
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

/** 标签切换组（Ribbon 菜单标签复用；激活项带强调色下划线） */
export function Tabs({ items, value, onChange, className }: TabsProps) {
  return (
    <div role="tablist" className={`flex items-center gap-0.5 ${className ?? ''}`}>
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.id)}
            className={`relative flex h-8 items-center gap-1.5 rounded-sm px-3 text-ui transition-colors ${
              active
                ? 'bg-active font-medium text-fg'
                : 'text-muted hover:bg-hover hover:text-fg'
            }`}
          >
            {item.icon}
            {item.label}
            {active ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" aria-hidden="true" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
