import type React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Minus, Radio, TrendingDown, TrendingUp } from 'lucide-react';
import { Tooltip } from './ui';
import type { kpiTip, RateVerdict } from './analyticsUtils';
import '../styles/direction-cards.css';

/**
 * The figure cards every summary in the app is drawn with (styles/direction-cards.css):
 *
 *   * StatCard   -- one headline figure: the Dashboard's Today row, the Analytics headline
 *                   and Queue service rows.
 *   * FigureCard -- a period total with its sub-counts and a grid of quality figures: the
 *                   Inbound / Outbound cards on the Dashboard and Analytics, and the
 *                   per-queue cards.
 *
 * One implementation of each, so a card, its tones and its delta read the same on every page.
 */

export type Tone = '' | 'success' | 'warn' | 'danger';
export const VERDICT_TONE: Record<RateVerdict, Tone> = { good: 'success', warn: 'warn', bad: 'danger', '': '' };

/** Tooltip props: the sentence, its optional formula line, and the icon's name. */
export type Tip = Partial<ReturnType<typeof kpiTip>> & { content: string };
export interface Part { label: string; n: number }
export interface Metric { key: string; label: string; value: string; tone?: Tone; tip?: Tip }

/** The sub-counts under a figure: "Queue 2 · Direct 1". */
function Parts({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return null;
  return (
    <div className="dcard-parts">
      {parts.map((p) => <span key={p.label}>{p.label} <b>{p.n.toLocaleString()}</b></span>)}
    </div>
  );
}

/**
 * Change against the previous period of the same length. `good` says which direction is
 * an improvement (up for answer rate, down for AHT); left undefined the delta is neutral,
 * because more calls is neither better nor worse on its own.
 */
function Delta({ delta, good }: { delta: number; good?: 'up' | 'down' }) {
  const { t } = useTranslation();
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const tone = !good || delta === 0 ? '' : (delta > 0) === (good === 'up') ? ' pos' : ' neg';
  const shown = Number.isInteger(delta) ? delta.toLocaleString() : delta.toFixed(1);
  return (
    <span className={`dcard-delta${tone}`}>
      <Icon size={12} />
      {delta > 0 ? '+' : ''}{shown} {t('analytics.delta.vsPrevPeriod', 'vs previous period')}
    </span>
  );
}

export interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  tip?: Tip;
  /** A sub-line under the figure: "47 in · 25 out", "Contact rate 76.4%". */
  desc?: string;
  delta?: number | null;
  /** Which way the delta is an improvement; omit for a neutral count. */
  good?: 'up' | 'down';
  /** Colours the figure and the top edge: for a figure that is a verdict. */
  tone?: Tone;
  /** Colours only the icon tile, e.g. to match a chart series the card stands for. */
  iconTone?: Tone | 'muted';
}

/** One headline figure, as a dcard: icon and title, the figure, then its sub-line. */
export function StatCard({ icon, label, value, tip, desc, delta, good, tone = '', iconTone = '' }: StatCardProps) {
  return (
    <section className={`dcard dcard--stat${tone ? ` ${tone}` : ''}`} aria-label={label}>
      <header className="dcard-head">
        <span className={`dcard-icon${iconTone ? ` ${iconTone}` : ''}`}>{icon}</span>
        <h3 className="dcard-title">{label}</h3>
        {tip && <Tooltip {...tip} label={label} />}
      </header>
      <div className="dcard-stat-value">{value}</div>
      {delta !== null && delta !== undefined && <Delta delta={delta} good={good} />}
      {desc && <div className="dcard-stat-desc">{desc}</div>}
    </section>
  );
}

/** A row of StatCards that wraps to fit, the way the direction cards do. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="dstats">{children}</div>;
}

export interface FigureCardProps {
  icon: React.ReactNode;
  title: string;
  tip?: Tip;
  /** The count happening right now (Dashboard only), with its own sub-counts. */
  live?: number;
  liveParts?: Part[];
  periodLabel: string;
  period: number | null;
  periodDelta?: number | null;
  periodParts?: Part[];
  metrics: Metric[];
  /** A text flag beside the title, e.g. "Below SLA target". */
  badge?: React.ReactNode;
}

/**
 * One card of figures: a title, an optional live count, the period's headline number with
 * its sub-counts, then a grid of quality figures.
 */
export function FigureCard({
  icon, title, tip, live, liveParts = [], periodLabel, period, periodDelta, periodParts = [], metrics, badge,
}: FigureCardProps) {
  const { t } = useTranslation();
  return (
    <section className={`dcard${live ? ' live' : ''}`} aria-label={title}>
      <header className="dcard-head">
        <span className="dcard-icon">{icon}</span>
        <h3 className="dcard-title">{title}</h3>
        {tip && <Tooltip {...tip} label={title} />}
        {badge && <span className="dcard-badge">{badge}</span>}
      </header>

      {live !== undefined && (
        <>
          <div className="dcard-block">
            <div className="dcard-line">
              <span className="dcard-kicker live"><Radio size={12} />{t('dashboard.now', 'Now')}</span>
              <span className={`dcard-value${live > 0 ? ' now' : ' idle'}`}>{live}</span>
            </div>
            <Parts parts={liveParts} />
          </div>
          <div className="dcard-divider" />
        </>
      )}

      <div className="dcard-block">
        <div className="dcard-line">
          <span className="dcard-kicker"><CalendarDays size={12} />{periodLabel}</span>
          <span className="dcard-value">{period === null ? '—' : period.toLocaleString()}</span>
        </div>
        {period !== null && periodDelta !== undefined && periodDelta !== null && <Delta delta={periodDelta} />}
        {period !== null && <Parts parts={periodParts} />}
      </div>

      {period !== null && metrics.length > 0 && (
        <dl className="dcard-metrics">
          {metrics.map((m) => (
            <div key={m.key} className={`dcard-metric${m.tone ? ` ${m.tone}` : ''}`}>
              <dt>{m.label}{m.tip && <Tooltip {...m.tip} label={m.label} />}</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
