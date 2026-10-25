import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { Info } from 'lucide-react';
import { anchorVars, useAnchorBox, useDismissOnOutside } from './anchor';

/**
 * An explanatory layer attached to a control or a figure.
 *
 * `Dropdown` is a list of options, `Popover` is an interactive panel; this is
 * the third and last anchored layer — non-interactive text that describes the
 * thing it points at. All three share ui/anchor, so flipping, RTL anchoring and
 * viewport clamping behave identically.
 *
 * Openness is internal here, unlike the overlay contract the other two follow.
 * A tooltip is opened by hovering, focusing or tapping its trigger and by
 * nothing else — there is no "close after selecting" flow for a caller to drive,
 * and threading `open` through forty KPI tiles would be state nobody reads.
 *
 * Three ways in, because a tooltip that only answers to hover is invisible to
 * half the people who need it: pointer hover (after a short delay, so sweeping
 * the cursor across a KPI grid does not strobe), keyboard focus, and click/tap
 * for touch, where there is no hover at all.
 */
export interface TooltipProps {
  /** The explanation. Kept short — a sentence or two, translated at the call site. */
  content: React.ReactNode;
  /**
   * The calculation behind the figure, set below the sentence in mono. For the
   * reader who wants to know how a number was reached; the sentence alone has
   * to make sense without it.
   */
  formula?: string;
  /**
   * The thing being explained. Spread the props onto any element you like.
   * Omit it for the default info icon, which is what a KPI label wants.
   */
  trigger?: (props: TooltipTriggerProps) => React.ReactNode;
  /**
   * Names the default icon trigger for assistive tech ("About SLA"). Ignored
   * when `trigger` is supplied, since that element carries its own name.
   */
  label?: string;
  /** Widen the layer past its trigger. */
  minWidth?: number;
  /** Which of the trigger's inline edges the layer lines up with. */
  align?: 'start' | 'end';
  className?: string;
}

export interface TooltipTriggerProps {
  ref: (el: HTMLElement | null) => void;
  'aria-describedby'?: string;
  'data-state': 'open' | 'closed';
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: (e: React.MouseEvent) => void;
}

/** Long enough that crossing a tile on the way somewhere else does not open it. */
const OPEN_DELAY_MS = 150;

export function Tooltip({
  content, formula, trigger, label, minWidth, align, className,
}: TooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => { clearTimer(); setOpen(false); }, [clearTimer]);
  const openNow = useCallback(() => { clearTimer(); setOpen(true); }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const box = useAnchorBox({
    open, anchorRef: triggerRef, layerRef: panelRef, minWidth, align,
    // The panel's height follows its text, which differs per KPI.
    deps: [content, formula],
  });

  // A tap-opened tooltip has no pointerleave to close it.
  useDismissOnOutside(open, close, [triggerRef, panelRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const triggerProps: TooltipTriggerProps = {
    ref: (el) => { triggerRef.current = el; },
    'aria-describedby': open ? tipId : undefined,
    'data-state': open ? 'open' : 'closed',
    // Touch fires a synthetic pointerenter right before the tap; opening on the
    // delay and then toggling on the click would close it again immediately.
    onPointerEnter: (e) => {
      if (e.pointerType === 'touch') return;
      clearTimer();
      timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    },
    onPointerLeave: close,
    onFocus: openNow,
    onBlur: close,
    // Contained: the info icon on a sortable column header must not also sort the
    // table, and the one on a tile must not trigger whatever the tile does.
    onClick: (e) => { e.stopPropagation(); if (open) close(); else openNow(); },
  };

  const panel = open && box ? (
    <div
      ref={panelRef}
      id={tipId}
      role="tooltip"
      className={`ui-tooltip${box.flipped ? ' ui-tooltip--flipped' : ''}${className ? ` ${className}` : ''}`}
      style={anchorVars(box)}
    >
      {content}
      {formula && <span className="ui-tooltip-formula">{formula}</span>}
    </div>
  ) : null;

  return (
    <>
      {trigger
        ? trigger(triggerProps)
        : (() => {
          const { ref, ...rest } = triggerProps;
          return (
            <button
              type="button"
              className="ui-tooltip-trigger"
              aria-label={label}
              {...rest}
              ref={ref}
            >
              <Info size={12} aria-hidden="true" />
            </button>
          );
        })()}
      {panel && createPortal(panel, document.body)}
    </>
  );
}
