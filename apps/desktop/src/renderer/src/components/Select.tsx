import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[];
}

/** 下拉选择框（原生 select 封装，带自定义箭头图标） */
export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <span className={`relative inline-flex items-center ${className ?? ''}`}>
      <select
        className="h-8 w-full cursor-pointer appearance-none rounded-sm border border-border bg-surface pl-2 pr-7 text-ui text-fg transition-colors hover:border-accent focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        {...rest}
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
