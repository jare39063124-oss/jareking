import type { ReactNode } from 'react';

export interface TooltipProps {
  /** 提示文案 */
  label: string;
  /** 出现位置 */
  side?: 'top' | 'bottom';
  children: ReactNode;
}

/**
 * 轻量 Tooltip：基于 group-hover/group-focus-within 的纯 CSS 实现，
 * 无定时器与状态，子元素获得焦点时同样展示（键盘可达）。
 */
export function Tooltip({ label, side = 'top', children }: TooltipProps) {
  const positionClass =
    side === 'top'
      ? 'bottom-full left-1/2 mb-1 -translate-x-1/2'
      : 'top-full left-1/2 mt-1 -translate-x-1/2';

  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${positionClass} z-[var(--jk-z-dropdown)] hidden whitespace-nowrap rounded-sm border border-border bg-surface px-1.5 py-0.5 text-tiny text-fg shadow-panel group-hover/tt:block group-focus-within/tt:block`}
      >
        {label}
      </span>
    </span>
  );
}
