import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { isTopmostTrap, useFocusTrap, useScrollLock } from './focus';

export type ModalWidth = 'sm' | 'md' | 'lg' | 'wide' | 'xl';

const WIDTH_MAP: Record<ModalWidth, string> = {
  sm:   'min(420px, 94vw)',
  md:   'min(520px, 94vw)',
  lg:   'min(560px, 94vw)',
  wide: 'min(640px, 94vw)',
  xl:   'min(760px, 94vw)',
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ReactNode;
  width?: ModalWidth;
  /** Rendered beside the title, before the close button — step counts, chips. */
  headerAside?: React.ReactNode;
  footer?: React.ReactNode;
  /** Extra class on the panel, for per-dialog body layout (grids, timelines). */
  className?: string;
  children: React.ReactNode;
}

export function Modal({
  open, onClose, title, icon, width = 'md', headerAside, footer, className, children,
}: ModalProps) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus is contained while open and returned to the trigger on close; the
  // page behind the scrim cannot be reached by Tab.
  useFocusTrap(panelRef, open);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    // Only the innermost overlay answers Escape: a confirm opened over an edit
    // modal must not close both with one key press.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopmostTrap(panelRef.current)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const handleOverlay = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  // Portalled to <body>: panels rendered inline are clipped by the
  // `overflow: hidden` on .cl-panel and the other card shells, and scroll with
  // the table they were opened from.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={overlayRef}
          className="modal-overlay"
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={handleOverlay}
        >
          <motion.div
            ref={panelRef}
            className={className ? `ui-modal ${className}` : 'ui-modal'}
            style={{ width: WIDTH_MAP[width] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            /* Holds focus when the dialog has no focusable child yet — an empty
               timeline, a body still loading. */
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            onClick={e => e.stopPropagation()}
          >
            <div className="ui-modal-head">
              <div className="ui-modal-title-row">
                {icon && <span className="ui-modal-icon">{icon}</span>}
                <h3 className="ui-modal-title" id={titleId}>{title}</h3>
                {headerAside}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon ui-modal-close"
                onClick={onClose}
                aria-label={t('common.close', 'Close')}
              >
                <X size={16} />
              </button>
            </div>

            <div className="ui-modal-body">
              {children}
            </div>

            {footer && (
              <div className="ui-modal-footer">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
