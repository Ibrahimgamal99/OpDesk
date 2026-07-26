import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
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
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value) ?? options[0];

  // Position the dropdown as a fixed-position portal so it is never clipped by an
  // ancestor with `overflow: hidden` (e.g. the filter bar or a scroll container).
  const updateMenuPosition = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const rtl = getComputedStyle(ref.current).direction === 'rtl';
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 5,
      // Anchor to the trigger's leading edge so the menu grows outward correctly
      // in both LTR and RTL, and lines up with the trigger regardless of direction.
      ...(rtl ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      minWidth: rect.width,
      maxHeight: 260,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      zIndex: 10000,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    updateMenuPosition();
    const onScrollOrResize = () => updateMenuPosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const el = e.target as Node;
      if (ref.current?.contains(el) || menuRef.current?.contains(el)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const classes = ['an-select', open && 'open', size === 'md' && 'an-select--md']
    .filter(Boolean).join(' ');

  const menu = open && menuStyle ? (
    <div
      ref={menuRef}
      className="an-select-dropdown"
      style={menuStyle}
      onWheel={e => e.stopPropagation()}
    >
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
  ) : null;

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
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
