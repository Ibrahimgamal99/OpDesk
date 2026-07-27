import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Portal-rendered modal built on the app's existing `.modal-*` CSS
 * (styles/index.css) rather than a new class family, so it inherits the dark
 * theme, the fadeIn/slideUp animations and the RTL handling for free.
 */
export type ModalWidth = 'sm' | 'md' | 'wide' | 'xl';

const WIDTH_MAP: Record<ModalWidth, string> = {
  sm: 'min(420px, 94vw)',
  md: 'min(520px, 94vw)',
  wide: 'min(640px, 94vw)',
  xl: 'min(760px, 94vw)',
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ReactNode;
  width?: ModalWidth;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, icon, width = 'md', footer, children }: ModalProps) {
  // Escape to close. Bound only while open so background modals don't steal the key.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      {/* Inline maxWidth overrides the 440px default on `.modal`. */}
      <div
        className="modal"
        style={{ maxWidth: WIDTH_MAP[width] }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h3 className="modal-title">
            {icon && <span className="modal-icon">{icon}</span>}
            {title}
          </h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
