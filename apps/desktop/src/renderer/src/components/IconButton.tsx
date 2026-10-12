import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 提示文案（同时作为无障碍名称） */
  label: string;
  /** 图标节点（由调用方控制 lucide 图标尺寸） */
  icon: ReactNode;
  size?: 'sm' | 'md';
  /** 提示出现的位置 */
  tooltipSide?: 'top' | 'bottom';
}

const SIZE_CLASSES = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
} as const;

/** 图标按钮：自带 Tooltip 提示 */
export function IconButton({
  label,
  icon,
  size = 'md',
  tooltipSide = 'top',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        type={type}
        aria-label={label}
        className={`inline-flex shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-fg active:bg-active disabled:cursor-not-allowed disabled:opacity-50 ${SIZE_CLASSES[size]} ${className ?? ''}`}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
