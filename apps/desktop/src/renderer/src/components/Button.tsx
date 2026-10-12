import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** 按钮风格变体 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** 按钮尺寸 */
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 图标插槽（渲染在文字前） */
  icon?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'border border-transparent bg-accent text-accent-fg hover:opacity-90 active:opacity-80',
  secondary: 'border border-border bg-surface text-fg hover:bg-hover active:bg-active',
  ghost: 'border border-transparent bg-transparent text-fg hover:bg-hover active:bg-active',
  danger: 'border border-transparent bg-danger text-white hover:opacity-90 active:opacity-80',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1 px-2 text-tiny',
  md: 'h-8 gap-1.5 px-3 text-ui',
};

/** 基础按钮：支持四种变体、两种尺寸与图标插槽 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center rounded-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className ?? ''}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
