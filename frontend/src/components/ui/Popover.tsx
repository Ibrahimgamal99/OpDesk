import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { anchorVars, useAnchorBox, useDismissOnOutside } from './anchor';

/**
 * An anchored panel with arbitrary content.
 *
 * `Dropdown` covers the case where the panel is a list of options; this covers
 * everything else — a range picker, a small form, a summary card. The two share
 * ui/anchor, so flipping, RTL anchoring and dismissal behave identically and a
 * fix to either lands in both.
 *
 * Controlled only, per the overlay contract: `open` + `onOpenChange`, no
 * internal open state. A popover that owns its own openness cannot be closed by
 * the thing that opened it, which is what every "close after selecting" flow
 * needs.
 */
export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The anchor. Rendered inline and given the ref plus the ARIA that ties it to
   * the panel, so callers style their own trigger without restating any of it.
   */
  trigger: (props: PopoverTriggerProps) => React.ReactNode;
  children: React.ReactNode;
  /** Names the panel for assistive tech. Translated at the call site. */
  label?: string;
  /** Widen the panel past its trigger. */
  minWidth?: number;
  /**
   * Which of the trigger's inline edges the panel lines up with. Use `end` for
   * a narrow trigger in a trailing slot; the panel is clamped into the viewport
   * either way.
   */
  align?: 'start' | 'end';
  /** Height ceiling, when the content is taller than the default cap. */
  maxHeight?: number;
  /** Re-place when the panel's content changes height. */
  deps?: readonly unknown[];
  className?: string;
}

export interface PopoverTriggerProps {
  ref: (el: HTMLElement | null) => void;
  'aria-expanded': boolean;
  'aria-haspopup': 'dialog';
  'aria-controls'?: string;
  'data-state': 'open' | 'closed';
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function Popover({
  open, onOpenChange, trigger, children, label, minWidth, align,
  maxHeight, deps = [], className,
}: PopoverProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const box = useAnchorBox({
    open, anchorRef: triggerRef, layerRef: panelRef, minWidth, align, maxHeight, deps,
  });

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  useDismissOnOutside(open, close, [triggerRef, panelRef]);

  // Esc closes from anywhere inside the panel, and focus goes back to the
  // trigger — otherwise closing a portalled panel drops focus to <body> and a
  // keyboard user restarts from the top of the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Move focus into the panel on open so Tab walks its contents rather than
  // continuing past the trigger into the page behind it.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      first?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const triggerProps: PopoverTriggerProps = {
    ref: (el) => { triggerRef.current = el; },
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    'aria-controls': open ? panelId : undefined,
    'data-state': open ? 'open' : 'closed',
    onClick: () => onOpenChange(!open),
    onKeyDown: (e) => {
      if (e.key === 'ArrowDown' && !open) { e.preventDefault(); onOpenChange(true); }
    },
  };

  const panel = open && box ? (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={label}
      className={`ui-popover${box.flipped ? ' ui-popover--flipped' : ''}${className ? ` ${className}` : ''}`}
      style={anchorVars(box)}
    >
      {children}
    </div>
  ) : null;

  return (
    <>
      {trigger(triggerProps)}
      {panel && createPortal(panel, document.body)}
    </>
  );
}
