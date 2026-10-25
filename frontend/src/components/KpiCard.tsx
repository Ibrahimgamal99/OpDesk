import { useTranslation } from 'react-i18next';
import { LineChart, Line } from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { kpiTip } from './analyticsUtils';
import { Tooltip } from './ui';

/**
 * The one KPI card. A label with its explanation, the figure, an optional
 * period-over-period delta, a sub-line and an optional sparkline.
 *
 * Which direction of a delta counts as good is `deltaInvert` (for figures like AHT where
 * less is better). It lives beside PageRange rather than in ui/ for the same reason that one
 * does: it is bound to this app's i18n, and ui/ carries no i18n dependency. Anything purely visual belongs in the an-kpi-* styles.
 */
export interface KpiCardProps {
  label: string;
  value: string;
  /** Plain sentence plus formula, from kpiTip(). Shown on the card's info icon. */
  tip: ReturnType<typeof kpiTip>;
  desc?: string;
  delta?: number | null;
  deltaInvert?: boolean;
  trend?: number[];
  colorClass?: 'good' | 'warn' | 'bad' | '';
  /** A headline card: larger, and tinted with its tone (brand blue when it has none) so the
   *  figures a stakeholder reads first stand out from the detail below them. */
  featured?: boolean;
}

export function KpiCard({
  label, value, tip, desc, delta, deltaInvert = false, trend, colorClass = '', featured = false,
}: KpiCardProps) {
  const { t } = useTranslation();
  let deltaClass = 'neu';
  let deltaSign = '';
  let DeltaIcon = Minus;

  if (delta !== null && delta !== undefined) {
    const isPositive = deltaInvert ? delta < 0 : delta > 0;
    deltaClass = isPositive ? 'pos' : delta === 0 ? 'neu' : 'neg';
    deltaSign = delta > 0 ? '+' : '';
    DeltaIcon = isPositive ? TrendingUp : delta === 0 ? Minus : TrendingDown;
  }

  return (
    // The ui-stat-* classes are Stat's: same tile, label and figure as every other
    // summary row. The an-kpi-* ones carry only what a KPI adds (tone, delta, sparkline).
    <div className={`ui-stat an-kpi-card${featured ? ' an-kpi-card--featured' : ''}`}
         data-tone={featured ? colorClass || 'brand' : undefined}>
      <div className="ui-stat-label">
        {label}
        <Tooltip {...tip} />
      </div>
      <div className={`ui-stat-value an-kpi-value${colorClass ? ` ${colorClass}` : ''}`}>{value}</div>
      {delta !== null && delta !== undefined && (
        <Tooltip
          {...kpiTip(t, 'analytics.tip.kpi.delta', t('analytics.delta.vsPrevPeriod'), undefined,
                     { text: 'Change from the period just before this one.', formula: 'this period − previous' })}
          trigger={({ ref, ...triggerProps }) => (
            <div {...triggerProps} ref={ref} tabIndex={0} className={`an-kpi-delta ${deltaClass}`}>
              <DeltaIcon size={12} />
              <span>{deltaSign}{delta?.toFixed(1)}</span>
              <span className="an-kpi-delta-label">{t('analytics.delta.vsPrevPeriod')}</span>
            </div>
          )}
        />
      )}
      {desc && <div className="ui-stat-hint">{desc}</div>}
      {trend && trend.length > 1 && (
        <div className="an-sparkline">
          <div dir="ltr">
            <LineChart width={120} height={34} data={trend.map((v, i) => ({ i, v }))}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={
                  colorClass === 'good' ? 'var(--accent-success)' :
                  colorClass === 'warn' ? 'var(--accent-warning)' :
                  colorClass === 'bad'  ? 'var(--accent-danger)'  :
                  'var(--accent-primary)'
                }
                dot={false}
                strokeWidth={1.5}
              />
            </LineChart>
          </div>
        </div>
      )}
    </div>
  );
}
