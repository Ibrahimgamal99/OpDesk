import type { ReactNode } from 'react';

export interface RowHintProps {
  /** Small leading glyph, rendered at the caption's own size. */
  icon: ReactNode;
  /** The caption itself. */
  children: ReactNode;
  /** Native tooltip for detail the one line has no room for. */
  title?: string;
}

/**
 * A one-line caption under a table cell's main value — the muted, icon-led note that says what
 * the value above it does not: what a lead is waiting for, when it is due, why it stalled.
 *
 * It exists as a shared component because a second one appeared (retry state and callback time
 * sit in the same cell, one under the other) and two hand-rolled copies would have drifted in
 * exactly the way that makes a table look untidy: different icon sizes, different gaps, one of
 * them wrapping. Everything visual is fixed here; callers choose only the icon and the words.
 */
export function RowHint({ icon, children, title }: RowHintProps) {
  return (
    <div className="u-text-xs u-nowrap" style={{ color: 'var(--text-muted)', marginTop: 3 }} title={title}>
      <span style={{ verticalAlign: -1, marginRight: 3, display: 'inline-flex' }}>{icon}</span>
      {children}
    </div>
  );
}

export default RowHint;
