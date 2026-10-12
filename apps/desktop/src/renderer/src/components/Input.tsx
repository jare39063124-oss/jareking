import type { InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

/** 文本输入框（原生 input 样式封装） */
export function Input({ className, ...rest }: InputProps) {
  return (
    <input
      className={`h-8 w-full rounded-sm border border-border bg-surface px-2 text-ui text-fg transition-colors placeholder:text-muted hover:border-accent focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ''}`}
      {...rest}
    />
  );
}
