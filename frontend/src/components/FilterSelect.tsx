import { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  dot?: 'green' | 'red' | 'blue' | 'orange' | 'neutral';
}

interface FilterSelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  icon?: React.ElementType;
  /** sm = compact (analytics bar), md = full-height (matches form-input) */
  size?: 'sm' | 'md';
  minWidth?: number;
  style?: React.CSSProperties;
}

export function FilterSelect({
  value,
  onChange,
  options,
  icon: Icon,
  size = 'sm',
  minWidth,
  style,
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const classes = ['an-select', open && 'open', size === 'md' && 'an-select--md']
    .filter(Boolean).join(' ');

  return (
    <div
      ref={ref}
      className={classes}
      style={{ minWidth, ...style }}
      onKeyDown={e => e.key === 'Escape' && setOpen(false)}
    >
      <button className="an-select-trigger" onClick={() => setOpen(o => !o)} type="button">
        {Icon && <Icon size={size === 'md' ? 15 : 13} className="an-select-icon" />}
        {selected?.dot && <span className={`an-dot an-dot-${selected.dot}`} />}
        <span className="an-select-label">{selected?.label}</span>
        <ChevronDown size={size === 'md' ? 14 : 12} className="an-select-chevron" />
      </button>
      {open && (
        <div className="an-select-dropdown">
          {options.map(opt => (
            <div
              key={opt.value}
              className={`an-select-option${value === opt.value ? ' selected' : ''}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.dot && <span className={`an-dot an-dot-${opt.dot}`} />}
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
