import React, { useRef } from 'react';
import { Loader2, Upload } from 'lucide-react';

export interface FileUploadProps {
  /** Called with the file the user picked. Picking the same file again calls it again. */
  onFile: (file: File) => void;
  /** The button's text. */
  label: React.ReactNode;
  /** File types the picker offers, as the native `accept` attribute. */
  accept?: string;
  /** Shown before the label. Defaults to the upload icon; `false` for none. */
  icon?: React.ReactNode | false;
  disabled?: boolean;
  /** Shows a spinner in place of the icon and disables the button. */
  loading?: boolean;
  id?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * The one file picker: a button that opens the browser's file dialog. The native
 * input stays hidden, because its own control cannot be styled or labelled
 * consistently across browsers. Three screens had each hand-rolled this pair (a
 * hidden input plus a button that clicks it), each remembering, or not, to reset
 * the input so the same file could be picked twice.
 */
export function FileUpload({
  onFile, label, accept, icon, disabled, loading, id, className, 'data-testid': testId,
}: FileUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const shown = loading
    ? <Loader2 size={14} className="spinner" />
    : icon === undefined ? <Upload size={14} /> : icon || null;

  return (
    <>
      <input
        ref={input}
        type="file"
        className="u-hidden"
        accept={accept}
        tabIndex={-1}
        aria-hidden="true"
        onChange={e => {
          const file = e.target.files?.[0];
          // Reset first, so picking the same file again fires onChange again.
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        id={id}
        data-testid={testId}
        className={['btn u-row u-gap-1h', className].filter(Boolean).join(' ')}
        disabled={disabled || loading}
        onClick={() => input.current?.click()}
      >
        {shown}{label}
      </button>
    </>
  );
}
