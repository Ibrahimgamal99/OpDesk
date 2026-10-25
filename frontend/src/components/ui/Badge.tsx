import React from 'react';

/**
 * The status pill. Renders the existing `.badge` + modifier classes so pages
 * stop spelling the class names by hand and stop inventing per-feature chips.
 * Semantic tones are for status only; `primary` is for neutral labels such as
 * a dialer mode.
 */
export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'live';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'badge-muted',
  primary: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
  info: 'badge-info',
  purple: 'badge-purple',
  live: 'badge-live',
};

export interface BadgeProps {
  tone?: BadgeTone;
  /**
   * A colour token for a categorical palette the tones cannot express, such as
   * the ten call statuses in callStatus.ts. Overrides `tone`; the tint and
   * border are derived from it, so the pill keeps the same shape.
   */
  color?: string;
  /** Leading dot, for a live state (Running, Talking, Ready). */
  dot?: boolean;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ tone = 'neutral', color, dot, icon, title, className, children }: BadgeProps) {
  return (
    <span
      className={`badge ${color ? 'badge-custom' : TONE_CLASS[tone]}${className ? ` ${className}` : ''}`}
      style={color ? { '--badge-color': color } as React.CSSProperties : undefined}
      title={title}
    >
      {dot && <span className="badge-dot" aria-hidden />}
      {icon}
      {children}
    </span>
  );
}
