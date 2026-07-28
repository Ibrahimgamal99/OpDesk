import React from 'react';

/**
 * A numeric callout. The only way to render one.
 *
 * This replaces the magenta "13 TOTAL CALLS" tile on Call History, which was
 * built from `--gradient-purple` / `--glow-purple` — two tokens that existed
 * for that one tile and nothing else. Being in the token file was not enough to
 * make it in-system: a gradient needs a defined *role*, and "one page's
 * counter" is not a role. Tone here is semantic and flat.
 *
 * `danger` / `warning` / `success` mean status. Reusing them for decoration is
 * what teaches users to stop reading them as status, so a Stat that is merely
 * important stays `neutral`.
 */
export type StatTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface StatProps {
  value: React.ReactNode;
  label: string;
  tone?: StatTone;
  icon?: React.ReactNode;
}

export function Stat({ value, label, tone = 'neutral', icon }: StatProps) {
  return (
    <div className={`ui-stat ui-stat--${tone}`}>
      {icon && <span className="ui-stat-icon">{icon}</span>}
      <span className="ui-stat-value">{value}</span>
      <span className="ui-stat-label">{label}</span>
    </div>
  );
}
