import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Modal } from './Modal';

/* The one confirmation prompt. Replaces window.confirm, which cannot be styled,
   blocks the main thread (and with it the softphone's SIP keepalives), and reads
   as a browser warning rather than part of the app.

   ui-pure: no i18n here. Callers pass translated title/message/labels; the
   defaults are plain English for the rare caller that has none. */

export type ConfirmTone = 'danger' | 'primary';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger (the default) for destructive actions, primary otherwise. */
  tone?: ConfirmTone;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  /** Cancel button, Escape, the close button and a backdrop click. */
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'danger',
  onConfirm, onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width="sm"
      footer={
        <>
          {/* Cancel takes initial focus: Enter on a freshly opened prompt must
              never perform the destructive action. */}
          <button type="button" className="btn" data-autofocus onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {message && <p className="u-mt-0 u-mb-0 u-text-md u-fg-secondary">{message}</p>}
    </Modal>
  );
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

/**
 * Imperative confirm: `const [confirm, confirmDialog] = useConfirm();` render
 * `confirmDialog` once, then `if (!(await confirm({ title }))) return;`.
 * Resolves true on confirm, false on cancel / Escape / backdrop / unmount.
 */
export function useConfirm(): [ConfirmFn, ReactElement] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    // Options are kept so the text does not vanish during the exit animation.
    setOpen(false);
  }, []);

  const confirm = useCallback<ConfirmFn>(opts => new Promise<boolean>(resolve => {
    // A second prompt supersedes an unanswered first one.
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(opts);
    setOpen(true);
  }), []);

  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);

  const onConfirm = useCallback(() => settle(true), [settle]);
  const onCancel = useCallback(() => settle(false), [settle]);

  const element = (
    <ConfirmDialog
      {...(options ?? { title: '' })}
      open={open}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
  return [confirm, element];
}
