import type React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Tooltip } from './ui';
import type { kpiTip, RateVerdict } from './analyticsUtils';
import '../styles/direction-cards.css';

/**
 * One card of figures for a period: a title, the period's headline number with its
 * sub-counts, then a grid of quality figures. The Overview's direction cards and the
 * Queues tab's per-queue cards are both built from it, so they read alike. Markup and
 * classes follow echo's FigureCard (styles/direction-cards.css), minus the live block,
 * which only the Dashboard has.
 */
export type Tone = '' | 'success' | 'warn' | 'danger';
export const VERDICT_TONE: Record<RateVerdict, Tone> = { good: 'success', warn: 'warn', bad: 'danger', '': '' };

type Tip = ReturnType<typeof kpiTip>;
export interface Part { label: string; n: number }
export interface Metric { key: string; label: string; value: string; tone?: Tone; tip?: Tip }

/** The sub-counts under a figure: "Answered 120 · Abandoned 8". */
function Parts({ parts }: { parts: Part[] }) {
  if (parts.length === 0) return null;
  return (
    <div className="dcard-parts">
      {parts.map((p) => <span key={p.label}>{p.label} <b>{p.n.toLocaleString()}</b></span>)}
    </div>
  );
}

/** The period total against the previous period of the same length. Neutral rather than
 *  good or bad: more calls is not better or worse on its own. */
function PeriodDelta({ delta }: { delta: number }) {
  const { t } = useTranslation();
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  return (
    <span className="dcard-delta">
      <Icon size={12} />
      {delta > 0 ? '+' : ''}{delta.toLocaleString()} {t('analytics.delta.vsPrevPeriod')}
    </span>
  );
}

export interface FigureCardProps {
  icon: React.ReactNode;
  title: string;
  tip?: Tip;
  periodLabel: string;
  period: number | null;
  periodDelta?: number | null;
  periodParts: Part[];
  metrics: Metric[];
  /** A text flag beside the title, e.g. "Below SLA target". */
  badge?: React.ReactNode;
}

export function FigureCard({
  icon, title, tip, periodLabel, period, periodDelta, periodParts, metrics, badge,
}: FigureCardProps) {
  return (
    <section className="dcard" aria-label={title}>
      <header className="dcard-head">
        <span className="dcard-icon">{icon}</span>
        <h3 className="dcard-title">{title}</h3>
        {tip && <Tooltip {...tip} label={title} />}
        {badge && <span className="dcard-badge">{badge}</span>}
      </header>

      <div className="dcard-block">
        <div className="dcard-line">
          <span className="dcard-kicker"><CalendarDays size={12} />{periodLabel}</span>
          <span className="dcard-value">{period === null ? '—' : period.toLocaleString()}</span>
        </div>
        {period !== null && periodDelta !== undefined && periodDelta !== null && <PeriodDelta delta={periodDelta} />}
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
