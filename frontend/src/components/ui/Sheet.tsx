import React, { useCallback, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

/**
 * Bottom sheet. The mobile presentation for anything that would otherwise be an
 * anchored panel — an anchored panel is unusable once the on-screen keyboard
 * claims half the viewport.
 *
 * Built on Radix Dialog, so the focus trap, Esc handling, focus restoration on
 * close, scroll locking, and `aria-modal` wiring come from the library. This is
 * the reason not to hand-roll it: ui/Modal.tsx predates the rule and reimplements
 * portalling itself, which is why it has none of the above.
 *
 * Controlled only — `open` plus `onOpenChange`, never internal open state.
 */
export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Required: labels the dialog for assistive tech. */
  title: string;
  children: React.ReactNode;
  /** Pinned below the scroll region — e.g. a "Clear all" / "Apply" pair. */
  footer?: React.ReactNode;
}

/** Past this much downward travel, releasing dismisses instead of springing back. */
const DISMISS_PX = 96;

export function Sheet({ open, onOpenChange, title, children, footer }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const offset = useRef(0);

  // Drag offset is fed to CSS as a custom property rather than a React inline
  // style: it changes every pointermove, and re-rendering the tree at pointer
  // rate to move one element is the wrong trade.
  const setDrag = useCallback((px: number) => {
    offset.current = px;
    panelRef.current?.style.setProperty('--sheet-drag', `${px}px`);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    startY.current = e.clientY;
    panelRef.current?.setAttribute('data-dragging', 'true');
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (startY.current === null) return;
    // Downward only; dragging up must not detach the sheet from the edge.
    setDrag(Math.max(0, e.clientY - startY.current));
  };

  const onPointerUp = () => {
    if (startY.current === null) return;
    startY.current = null;
    panelRef.current?.removeAttribute('data-dragging');
    const travelled = offset.current;
    setDrag(0);
    if (travelled > DISMISS_PX) onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-sheet-backdrop" />
        <Dialog.Content ref={panelRef} className="ui-sheet" aria-describedby={undefined}>
          <div
            className="ui-sheet-grip"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <span className="ui-sheet-grip-bar" aria-hidden="true" />
          </div>

          <div className="ui-sheet-head">
            <Dialog.Title className="ui-sheet-title">{title}</Dialog.Title>
            {/* Drag-to-dismiss is pointer-only, so the sheet still needs a real
                control for keyboard and assistive tech. */}
            <Dialog.Close className="ui-sheet-close" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="ui-sheet-body">{children}</div>
          {footer && <div className="ui-sheet-foot">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
