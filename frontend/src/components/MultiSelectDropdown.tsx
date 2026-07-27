import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronDown, Check } from 'lucide-react';

export interface MultiSelectOption<T extends string> {
  value: T;
  label: string;
}

interface MultiSelectDropdownProps<T extends string> {
  options: MultiSelectOption<T>[];
  value: T[];
  onChange: (value: T[]) => void;
  placeholder?: string;
  emptyMessage?: string;
}

/**
 * Shared multi-select combobox: type-to-filter, tag chips, keyboard navigation,
 * and a fixed-position portal menu that flips above the trigger when there is no
 * room below. Used across Teams (Users, Groups) and anywhere else a multi-pick
 * list is needed so every dropdown behaves identically.
 */
export function MultiSelectDropdown<T extends string>({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  emptyMessage = 'No options',
}: MultiSelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [listStyle, setListStyle] = useState<React.CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      o => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, filter]);

  const updateListPosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < Math.min(220, spaceAbove) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(260, openUp ? spaceAbove : spaceBelow));
    setListStyle({
      position: 'fixed',
      ...(openUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
      left: rect.left,
      width: rect.width,
      maxHeight,
      overflowY: 'auto',
      overflowX: 'hidden',
      overscrollBehavior: 'contain',
      WebkitOverflowScrolling: 'touch',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      // Named layer, not a magic number: --z-dropdown sits above --z-modal
      // so a menu opened inside a dialog is not painted behind it.
      zIndex: 'var(--z-dropdown)',
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setListStyle(null);
      return;
    }
    updateListPosition();
    const onScrollOrResize = () => updateListPosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updateListPosition]);

  useEffect(() => {
    if (!open) {
      setFilter('');
      return;
    }
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActive(a => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const el = e.target as Node;
      if (containerRef.current?.contains(el) || listRef.current?.contains(el)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const toggle = (v: T) => {
    if (value.includes(v)) onChange(value.filter(x => x !== v));
    else onChange([...value, v]);
  };

  const clearAll = () => {
    onChange([]);
    setFilter('');
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
      e.preventDefault();
      if (filtered[active]) toggle(filtered[active].value);
    } else if (e.key === 'Backspace' && !filter && value.length) {
      // Remove the last chip when the filter box is empty.
      onChange(value.slice(0, -1));
    }
  };

  const boxStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    minHeight: 38,
    padding: '6px 8px 6px 10px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    position: 'relative',
  };

  const tagStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-accent)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    color: 'var(--text-primary)',
  };

  const selectedLabels = value.map(v => options.find(o => o.value === v)?.label ?? v);

  const listbox = open && listStyle ? (
    <div
      ref={listRef}
      role="listbox"
      style={listStyle}
      onClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {filtered.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>{emptyMessage}</div>
      ) : (
        filtered.map((opt, i) => {
          const isSel = value.includes(opt.value);
          const bg = isSel ? 'rgba(88,166,255,0.12)' : i === active ? 'var(--bg-hover)' : 'transparent';
          return (
            <div
              key={opt.value}
              role="option"
              aria-selected={isSel}
              ref={i === active ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => toggle(opt.value)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', fontSize: 13, background: bg, color: isSel ? 'var(--accent-primary)' : 'var(--text-primary)' }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{opt.label}</span>
              {isSel && <Check size={13} style={{ flexShrink: 0 }} />}
            </div>
          );
        })
      )}
    </div>
  ) : null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }} onKeyDown={onKeyDown}>
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={0}
        style={boxStyle}
        onClick={() => setOpen(o => !o)}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          {selectedLabels.map((label, i) => (
            <span key={value[i]} style={tagStyle} onClick={e => e.stopPropagation()}>
              {label}
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-muted)', lineHeight: 1, display: 'flex' }}
                aria-label="Remove"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {open && (
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onClick={e => e.stopPropagation()}
              placeholder={placeholder}
              style={{ flex: 1, minWidth: 80, border: 'none', background: 'transparent', color: 'var(--text-primary)', outline: 'none', fontSize: 13 }}
              autoFocus
            />
          )}
          {!open && value.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{placeholder}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {value.length > 0 && (
            <button type="button" onClick={e => { e.stopPropagation(); clearAll(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-muted)', display: 'flex' }} aria-label="Clear all">
              <X size={14} />
            </button>
          )}
          <ChevronDown size={16} style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
      </div>
      {listbox && createPortal(listbox, document.body)}
    </div>
  );
}
