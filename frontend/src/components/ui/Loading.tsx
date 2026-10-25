import { Loader2 } from 'lucide-react';

/**
 * What a page, card or list shows while its data is on the way: one spinner and
 * an optional muted line, centred. Replaces the per-panel variants (a 32px
 * spinner on Users and Groups, 28px on Recordings and Audit, 20px on Contacts,
 * an inline 16px one in settings cards, the Analytics `an-loading` row), so
 * waiting looks the same everywhere.
 */
export interface LoadingProps {
  label?: string;
  /** `sm` inside a card or table; `md` for a whole page body. */
  size?: 'sm' | 'md';
  className?: string;
}

export function Loading({ label, size = 'md', className }: LoadingProps) {
  return (
    <div className={`ui-loading ui-loading--${size}${className ? ` ${className}` : ''}`} role="status" aria-live="polite">
      <Loader2 size={size === 'sm' ? 16 : 22} className="spinner" aria-hidden />
      {label && <span className="ui-loading-label">{label}</span>}
    </div>
  );
}
