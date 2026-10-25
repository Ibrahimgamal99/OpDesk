import { useEffect, type RefObject } from 'react';

/* Focus containment for overlays. There was no trap anywhere in the codebase:
   every modal left Tab free to walk out into the page behind the scrim, where
   the focus ring is invisible under `backdrop-filter` and Enter activates a
   control the user cannot see. Escape and the close button were the only exits
   a keyboard could find, and neither is discoverable from a focus ring parked
   somewhere off-overlay. */

/* Tab order is the DOM order of these, filtered at trap time — a modal's
   focusables change as it renders (a disabled submit button becomes enabled,
   a list loads), so the set cannot be computed once on open. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
].join(',');

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => {
    // offsetParent is null for display:none and for anything inside it. A
    // collapsed <AdvancedSection> would otherwise contribute invisible tab
    // stops, which reads to a keyboard user as focus vanishing mid-cycle.
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    return el.getAttribute('aria-hidden') !== 'true';
  });
}

/* Active traps, innermost last. A confirm dialog opened from inside an edit
   modal stacks a second trap on the first: only the top one may act on Tab, or
   the outer trap sees focus "outside" its panel and drags it back behind the
   scrim. */
const trapStack: HTMLElement[] = [];

/** True when `el` is the innermost active trap — the overlay keyboard input
 *  (Tab, Escape) belongs to — or when no trap is active at all. */
export function isTopmostTrap(el: HTMLElement | null): boolean {
  return trapStack.length === 0 || trapStack[trapStack.length - 1] === el;
}

/**
 * Traps Tab within `containerRef` while `active`, moves focus in on activate,
 * and returns focus to the previously-focused element on deactivate.
 *
 * Initial focus goes to `[data-autofocus]` if present, else the first focusable
 * child, else the container itself. Give the container `tabIndex={-1}` so that
 * last case can hold focus rather than dropping it to <body>.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previous = document.activeElement as HTMLElement | null;
    trapStack.push(container);

    // Deferred a frame: on the open transition the panel is mounted but its
    // children may not be laid out yet, so offsetParent is still null and
    // focusable() would come back empty and drop focus on <body>.
    const raf = requestAnimationFrame(() => {
      const preferred = container.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? focusable(container)[0] ?? container).focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (!isTopmostTrap(container)) return;
      const items = focusable(container);
      if (items.length === 0) {
        // Nothing to cycle between, but Tab must still not escape.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;

      // Focus outside the container (a click on the scrim moved it, or the
      // trap mounted late) — pull it back to the edge Tab is heading toward.
      if (!container.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      const at = trapStack.lastIndexOf(container);
      if (at !== -1) trapStack.splice(at, 1);
      // Only restore if the trigger is still in the document and focus has not
      // already been claimed elsewhere — a modal that closes by navigating away
      // must not yank focus back to a detached node.
      if (previous && previous.isConnected) previous.focus();
    };
  }, [containerRef, active]);
}

/** Locks background scroll while `active`. Nested overlays are counted, so the
 *  inner one closing does not unlock the page under the outer one. */
let lockCount = 0;
let restoreOverflow = '';

export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      restoreOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount++;
    return () => {
      lockCount--;
      if (lockCount === 0) document.body.style.overflow = restoreOverflow;
    };
  }, [active]);
}
