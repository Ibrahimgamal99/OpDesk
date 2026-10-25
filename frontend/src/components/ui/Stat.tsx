import React from 'react';

/**
 * A plain number tile for a page's summary row: Dialer totals, queue counts,
 * live-call counts. Analytics keeps KpiCard, which adds the formula tooltip,
 * period delta and sparkline those figures need; this is the one for
 * everything else, so no page draws its own accent-striped tile.
 *
 * `tone` colours the icon only. Semantic tones are for figures that are a
 * status (live calls, failures), not for decoration.
 */
export interface StatProps {
  label: string;
  value: React.ReactNode;
  /** Secondary line under the value, e.g. "of 12 agents". */
  hint?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Pulsing dot beside the label while the figure is live and non-zero. */
  live?: boolean;
  className?: string;
}

export function Stat({ label, value, hint, icon, tone = 'primary', live, className }: StatProps) {
  return (
    <div className={`ui-stat ui-stat--${tone}${className ? ` ${className}` : ''}`}>
      <div className="ui-stat-label">
        {icon && <span className="ui-stat-icon">{icon}</span>}
        <span>{label}</span>
        {live && <span className="ui-stat-live" aria-hidden />}
      </div>
      <div className="ui-stat-value">{value}</div>
      {hint && <div className="ui-stat-hint">{hint}</div>}
    </div>
  );
}

/** The row Stats sit in. Wraps to two columns, then one, on narrow screens.
 *  Carries no outer margin; the parent spaces it. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`ui-stat-row${className ? ` ${className}` : ''}`}>{children}</div>;
}
