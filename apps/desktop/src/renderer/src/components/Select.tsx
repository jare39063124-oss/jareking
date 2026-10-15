import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'onChange'> {
  options: SelectOption[];
  /**
   * 值变更回调：直接回传选中的 `value` 字符串。
   * 本封装以「值」为契约（调用方无需读取原生 event），与各业务调用点用法一致
   * （如 setKind(v) / setRotateDeg(v)）。原生 onChange 由组件内部包装。
   */
  onChange?: (value: string) => void;
}

/** 下拉选择框（原生 select 封装，带自定义箭头图标） */
export function Select({ options, className, onChange, ...rest }: SelectProps) {
  return (
    <span className={`relative inline-flex items-center ${className ?? ''}`}>
      <select
        className="h-8 w-full cursor-pointer appearance-none rounded-sm border border-border bg-surface pl-2 pr-7 text-ui text-fg transition-colors hover:border-accent focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        {...rest}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-1.5 text-muted" aria-hidden="true" />
    </span>
  );
}
