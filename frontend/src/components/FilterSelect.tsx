import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search } from 'lucide-react';

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
  /**
   * Show a type-to-filter search box inside the dropdown. Defaults to `true`
   * once the list is long enough that scrolling alone is painful; compact
   * selects with few options stay untouched.
   */
  searchable?: boolean;
  searchPlaceholder?: string;
}

export function FilterSelect({
  value,
  onChange,
  options,
  icon: Icon,
  size = 'sm',
  minWidth,
  style,
  searchable,
  searchPlaceholder = 'Search…',
}: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value) ?? options[0];

  // Show the search box whenever the list is long enough to scroll. When the
  // caller forces `searchable`, honour that instead.
  const canSearch = searchable ?? overflow;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  // Position the dropdown as a fixed-position portal so it is never clipped by an
  // ancestor with `overflow: hidden` (e.g. the filter bar or a scroll container),
  // and flip it above the trigger when there isn't room below.
  const updateMenuPosition = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const rtl = getComputedStyle(ref.current).direction === 'rtl';
    const gap = 5;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < Math.min(260, spaceAbove) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(140, Math.min(300, openUp ? spaceAbove : spaceBelow));
    setMenuStyle({
      position: 'fixed',
      // Anchor to the edge nearest the trigger so the menu grows away from it and
      // never runs off-screen, whichever direction it opens.
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
      // Anchor to the trigger's leading edge so the menu grows outward correctly
      // in both LTR and RTL, and lines up with the trigger regardless of direction.
      ...(rtl ? { right: window.innerWidth - rect.right } : { left: rect.left }),
      minWidth: rect.width,
      maxHeight,
      // Named layer, not a magic number: --z-dropdown sits above --z-modal
      // so a menu opened inside a dialog is not painted behind it.
      zIndex: 'var(--z-dropdown)',
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

  // Reset the query and highlight the current selection each time we open.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const idx = filtered.findIndex(o => o.value === value);
    setActive(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Decide whether the (unfiltered) list overflows and therefore needs a search
  // box. Measured once per open with the full list visible, so filtering down
  // to a few matches never makes the search box flicker away.
  useEffect(() => {
    if (!open) {
      setOverflow(false);
      return;
    }
    // Only measure with the full list showing; while a filter is applied the
    // list is shorter, which must not flip the search box off.
    if (query.trim()) return;
    const id = requestAnimationFrame(() => {
      const el = optionsRef.current;
      if (el) setOverflow(el.scrollHeight > el.clientHeight + 1);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menuStyle, options.length, query]);

  // Keep the highlight in range as the filtered list changes while typing.
  useEffect(() => {
    setActive(a => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

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

  const commit = (opt?: SelectOption) => {
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(a => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      // Prevent submitting the surrounding form when picking an option.
      e.preventDefault();
      commit(filtered[active]);
    }
  };

  const classes = ['an-select', open && 'open', size === 'md' && 'an-select--md']
    .filter(Boolean).join(' ');

  const menu = open && menuStyle ? (
    <div
      ref={menuRef}
      className="an-select-dropdown"
      style={menuStyle}
      onWheel={e => e.stopPropagation()}
    >
      {canSearch && (
        <div className="an-select-search">
          <Search size={14} className="an-select-search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder={searchPlaceholder}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="an-select-options" ref={optionsRef}>
        {filtered.length === 0 ? (
          <div className="an-select-empty">{searchPlaceholder}</div>
        ) : (
          filtered.map((opt, i) => (
            <div
              key={opt.value}
              role="option"
              aria-selected={value === opt.value}
              ref={i === active ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={`an-select-option${value === opt.value ? ' selected' : ''}${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(opt)}
            >
              {opt.dot && <span className={`an-dot an-dot-${opt.dot}`} />}
              {opt.label}
            </div>
          ))
        )}
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={ref}
      className={classes}
      style={{ minWidth, ...style }}
      onKeyDown={onKeyDown}
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
