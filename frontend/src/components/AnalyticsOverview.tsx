import { useTranslation } from 'react-i18next';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  Legend, ResponsiveContainer, LineChart,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { ExecutiveKPIResponse, VolumeTrendPoint } from '../types';
import { fmtSecs, fmtPct, buildDateParams, analyticsGet, useAnalyticsFetch } from './analyticsUtils';

interface KpiCardProps {
  label: string;
  value: string;
  desc?: string;
  delta?: number | null;
  deltaInvert?: boolean;
  trend?: number[];
  colorClass?: 'good' | 'warn' | 'bad' | '';
}

function pctColor(v: number | null, threshold = 80): 'good' | 'warn' | 'bad' | '' {
  if (v === null) return '';
  if (v >= threshold) return 'good';
  if (v >= threshold * 0.7) return 'warn';
  return 'bad';
}

function abandonColor(v: number | null): 'good' | 'warn' | 'bad' | '' {
  if (v === null) return '';
  if (v <= 5) return 'good';
  if (v <= 15) return 'warn';
  return 'bad';
}

function delta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return parseFloat((a - b).toFixed(1));
}

function KpiCard({ label, value, desc, delta, deltaInvert = false, trend, colorClass = '' }: KpiCardProps) {
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
    <div className={`an-kpi-card${colorClass ? ` ${colorClass}` : ''}`}>
      <div className="an-kpi-label">{label}</div>
      <div className={`an-kpi-value${colorClass ? ` ${colorClass}` : ''}`}>{value}</div>
      {delta !== null && delta !== undefined && (
        <div className={`an-kpi-delta ${deltaClass}`}>
          <DeltaIcon size={11} />
          <span>{deltaSign}{delta?.toFixed(1)}</span>
          <span className="an-kpi-delta-label">{t('analytics.delta.vsPrevPeriod')}</span>
        </div>
      )}
      {desc && <div className="an-kpi-desc">{desc}</div>}
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

interface Props { dateRange: DateRange }

export function AnalyticsOverview({ dateRange }: Props) {
  const { t } = useTranslation();
  const { data, loading, error } = useAnalyticsFetch(
    async () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      const [kpis, trendResp] = await Promise.all([
        analyticsGet<ExecutiveKPIResponse>(`/api/analytics/overview?${params}`),
        analyticsGet<{ trend: VolumeTrendPoint[] }>(`/api/analytics/trend?${params}`),
      ]);
      return { kpis, trend: trendResp.trend || [] };
    },
    [dateRange],
  );
  const kpis = data?.kpis ?? null;
  const trend = data?.trend ?? [];

  if (loading) {
    return (
      <div className="an-loading">
        <div className="an-spinner" />
        {t('analytics.loading')}
      </div>
    );
  }

  if (error || !kpis) {
    return <div className="an-empty">{t('analytics.error')}</div>;
  }

  const cur = kpis.current;
  const prev = kpis.prev_period;

  const outKpis = cur.outbound;
  const prevOut = prev.outbound;
  const combinedKpis = cur.combined;
  const prevCombined = prev.combined;

  // Derived: inbound answer rate
  const inboundAnswerRate = cur.total_calls > 0
    ? parseFloat(((cur.answered_calls / cur.total_calls) * 100).toFixed(1))
    : null;
  const prevInboundAnswerRate = prev.total_calls > 0
    ? parseFloat(((prev.answered_calls / prev.total_calls) * 100).toFixed(1))
    : null;

  // Format total talk time as e.g. "3h 42m" or "54m"
  function fmtTalkTime(secs: number | null | undefined): string {
    if (secs === null || secs === undefined) return '—';
    if (secs < 60) return `${secs}s`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h === 0) return `${m}m`;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  const cards: KpiCardProps[] = [
    // ── Inbound quality ──────────────────────────────────────────────────────
    {
      label: t('analytics.kpi.sla'),
      value: fmtPct(cur.sla_pct),
      desc: t('analytics.kpi.slaDesc'),
      delta: delta(cur.sla_pct, prev.sla_pct),
      colorClass: pctColor(cur.sla_pct),
    },
    {
      label: t('analytics.kpi.fcr'),
      value: fmtPct(cur.fcr_pct),
      desc: t('analytics.kpi.fcrDesc'),
      delta: delta(cur.fcr_pct, prev.fcr_pct),
      colorClass: pctColor(cur.fcr_pct, 85),
    },
    {
      label: t('analytics.kpi.abandonment'),
      value: fmtPct(cur.abandonment_rate),
      desc: t('analytics.kpi.abandonmentDesc'),
      delta: delta(cur.abandonment_rate, prev.abandonment_rate),
      deltaInvert: true,
      colorClass: abandonColor(cur.abandonment_rate),
    },
    {
      label: t('analytics.kpi.shortAbandon'),
      value: fmtPct(cur.short_abandon_rate),
      desc: t('analytics.kpi.shortAbandonDesc'),
      delta: delta(cur.short_abandon_rate, prev.short_abandon_rate),
      deltaInvert: true,
      colorClass: abandonColor(cur.short_abandon_rate),
    },
    {
      label: t('analytics.kpi.avgWaitKpi'),
      value: fmtSecs(cur.avg_wait_secs),
      desc: t('analytics.kpi.avgWaitDesc'),
      delta: cur.avg_wait_secs !== null && prev.avg_wait_secs !== null
        ? delta(cur.avg_wait_secs, prev.avg_wait_secs)
        : null,
      deltaInvert: true,
    },
    {
      label: t('analytics.kpi.aht'),
      value: fmtSecs(cur.aht_secs),
      desc: t('analytics.kpi.ahtDesc'),
      delta: cur.aht_secs !== null && prev.aht_secs !== null
        ? delta(cur.aht_secs, prev.aht_secs)
        : null,
      deltaInvert: true,
    },
    // ── Inbound volume ───────────────────────────────────────────────────────
    {
      label: t('analytics.kpi.inboundAnswerRate'),
      value: fmtPct(inboundAnswerRate),
      desc: t('analytics.kpi.inboundAnswerRateDesc'),
      delta: delta(inboundAnswerRate, prevInboundAnswerRate),
      colorClass: pctColor(inboundAnswerRate),
    },
    {
      label: t('analytics.kpi.volume'),
      value: (combinedKpis?.total_calls ?? cur.total_calls).toLocaleString(),
      desc: [
        `${t('analytics.kpi.answeredCalls')}: ${(combinedKpis?.answered_calls ?? cur.answered_calls).toLocaleString()}`,
        outKpis ? `${t('analytics.kpi.outboundCalls')}: ${outKpis.total_calls.toLocaleString()}` : '',
      ].filter(Boolean).join(' · '),
      delta: delta(combinedKpis?.total_calls ?? cur.total_calls, prevCombined?.total_calls ?? prev.total_calls),
    },
    // ── Outbound KPIs (always shown; N/A when no outbound data) ─────────────
    {
      label: t('analytics.kpi.outboundVolume'),
      value: outKpis ? outKpis.total_calls.toLocaleString() : t('analytics.kpi.na'),
      desc: outKpis ? `${t('analytics.kpi.answeredCalls')}: ${outKpis.answered_calls.toLocaleString()}` : undefined,
      delta: outKpis && prevOut ? delta(outKpis.total_calls, prevOut.total_calls) : null,
    },
    {
      label: t('analytics.kpi.outboundAnswerRate'),
      value: outKpis ? fmtPct(outKpis.answer_rate) : t('analytics.kpi.na'),
      delta: outKpis && prevOut && outKpis.answer_rate !== null && prevOut.answer_rate !== null
        ? delta(outKpis.answer_rate, prevOut.answer_rate) : null,
      colorClass: outKpis ? pctColor(outKpis.answer_rate, 70) : '',
    },
    {
      label: t('analytics.kpi.outboundAht'),
      value: outKpis ? fmtSecs(outKpis.aht_secs) : t('analytics.kpi.na'),
      delta: outKpis && prevOut && outKpis.aht_secs !== null && prevOut.aht_secs !== null
        ? delta(outKpis.aht_secs, prevOut.aht_secs) : null,
      deltaInvert: true,
    },
    // ── Market ───────────────────────────────────────────────────────────────
    {
      label: t('analytics.kpi.market'),
      value: outKpis ? fmtTalkTime(outKpis.sum_billsec) : t('analytics.kpi.na'),
      desc: t('analytics.kpi.marketDesc'),
      delta: outKpis && prevOut ? delta(outKpis.sum_billsec, prevOut.sum_billsec) : null,
    },
  ];

  const chartData = trend.map(p => ({
    date: p.date.slice(5),
    answered: p.answered_calls,
    abandoned: p.abandoned_calls,
    outbound: p.outbound_total ?? 0,
    // Answer rate uses inbound-only figures (answered / inbound total)
    answer_rate: (p.answered_calls + p.abandoned_calls) > 0
      ? parseFloat(((p.answered_calls / (p.answered_calls + p.abandoned_calls)) * 100).toFixed(1))
      : 0,
  }));

  const tooltipStyle = {
    background: 'var(--bg-card, #1a1f26)',
    border: '1px solid var(--border-accent, #484f58)',
    borderRadius: 8,
    fontSize: 12,
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="an-kpi-grid">
        {cards.map(c => <KpiCard key={c.label} {...c} />)}
      </div>

      {chartData.length > 0 && (
        <div className="an-section">
          <div className="an-section-header">
            <div className="an-section-title">
              {t('analytics.kpi.volume')} — {dateRange.from} → {dateRange.to}
            </div>
          </div>
          <div className="an-chart-wrap" dir="ltr">
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--border-subtle, rgba(48,54,61,0.5))" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  width={36}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={v => `${v}%`}
                  tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                  width={40}
                  domain={[0, 100]}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 4 }}
                  itemStyle={{ color: 'var(--text-secondary)' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '0.75rem', color: 'var(--text-muted)', paddingTop: 8 }}
                  iconType="circle"
                  iconSize={8}
                />
                <Bar
                  yAxisId="left"
                  dataKey="answered"
                  fill="rgba(88,166,255,0.4)"
                  name={t('analytics.kpi.answeredCalls')}
                  radius={[2,2,0,0]}
                  stackId="inbound"
                />
                <Bar
                  yAxisId="left"
                  dataKey="abandoned"
                  fill="rgba(248,81,73,0.4)"
                  name={t('analytics.kpi.abandonedCalls')}
                  radius={[2,2,0,0]}
                  stackId="inbound"
                />
                <Bar
                  yAxisId="left"
                  dataKey="outbound"
                  fill="rgba(255,165,0,0.45)"
                  name={t('analytics.kpi.outboundTrend')}
                  radius={[2,2,0,0]}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="answer_rate"
                  stroke="var(--accent-success)"
                  dot={false}
                  strokeWidth={2}
                  name={t('analytics.kpi.answerRate', 'Answer Rate')}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
