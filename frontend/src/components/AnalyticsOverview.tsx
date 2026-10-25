import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';
import { BarChart3, Gauge, Headset, Hourglass, PhoneIncoming, PhoneMissed, PhoneOff, RefreshCcw } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { ExecutiveKPIResponse, VolumeTrendPoint } from '../types';
import {
  fmtSecs, fmtPct, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip, metricTips, rangeLabel,
  slaVerdict, abandonVerdict, fcrVerdict,
} from './analyticsUtils';
import { Alert, Card, Tooltip } from './ui';
import { StatCard, StatRow, VERDICT_TONE, type StatCardProps } from './FigureCards';
import { DirectionCards, SummaryStats, figuresFromKpis } from './DirectionCards';
import { AnalyticsExportButton } from './AnalyticsExport';

function delta(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return parseFloat((a - b).toFixed(1));
}

interface Props { dateRange: DateRange }

/**
 * Analytics → Overview: the chosen range, top to bottom.
 *
 *   1. four headline figures, each against the previous period of the same length;
 *   2. inbound and outbound cards: each direction's total and its quality figures;
 *   3. queue service: the queue's own quality figures, together;
 *   4. charts: calls by direction per day, inbound outcomes per day.
 *
 * Every chart has one axis: a rate and a count never share a plot.
 */
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
    return <Alert>{t('analytics.error')}</Alert>;
  }

  const cur = kpis.current;
  const prev = kpis.prev_period;

  // The headline row and the Inbound / Outbound cards are the Dashboard's own components,
  // fed this range and the one before it.
  const figures = figuresFromKpis(cur);
  const previous = prev ? figuresFromKpis(prev) : null;

  // ── Tips. OpDesk's own formulas, so they carry their own English. ───────────
  const tips = {
    ...metricTips(t),
    shortAbandon: kpiTip(t, 'analytics.tip.kpi.shortAbandonShare', t('analytics.kpi.shortAbandon'), undefined,
      { text: 'Inbound callers who hung up within the short-abandon threshold — usually misdials.', formula: 'quick hang-ups ÷ offered' }),
  };

  const period = rangeLabel(dateRange);

  // ── 3. Queue service: how the queue treated the people who waited in it ─────
  const queueService: StatCardProps[] = [
    {
      icon: <Gauge size={16} />,
      label: t('metrics.sla'),
      value: fmtPct(cur.sla_pct),
      tip: tips.sla,
      desc: t('analytics.kpi.slaDesc'),
      delta: delta(cur.sla_pct, prev?.sla_pct),
      good: 'up',
      tone: VERDICT_TONE[slaVerdict(cur.sla_pct)],
    },
    {
      icon: <PhoneMissed size={16} />,
      label: t('metrics.abandonRate'),
      value: fmtPct(cur.abandonment_rate),
      tip: tips.abandonRate,
      desc: t('analytics.kpi.abandonmentDesc'),
      delta: delta(cur.abandonment_rate, prev?.abandonment_rate),
      good: 'down',
      tone: VERDICT_TONE[abandonVerdict(cur.abandonment_rate)],
    },
    {
      icon: <PhoneOff size={16} />,
      label: t('analytics.kpi.shortAbandon'),
      value: fmtPct(cur.short_abandon_rate),
      tip: tips.shortAbandon,
      desc: t('analytics.kpi.shortAbandonDesc'),
      delta: delta(cur.short_abandon_rate, prev?.short_abandon_rate),
      good: 'down',
      tone: VERDICT_TONE[abandonVerdict(cur.short_abandon_rate)],
    },
    {
      icon: <Hourglass size={16} />,
      label: t('metrics.avgWait'),
      value: fmtSecs(cur.avg_wait_secs),
      tip: tips.avgWait,
      desc: t('analytics.kpi.avgWaitDesc'),
      delta: delta(cur.avg_wait_secs, prev?.avg_wait_secs),
      good: 'down',
    },
    {
      icon: <RefreshCcw size={16} />,
      label: t('metrics.fcr'),
      value: fmtPct(cur.fcr_pct),
      tip: tips.fcr,
      desc: t('analytics.kpi.fcrDesc'),
      delta: delta(cur.fcr_pct, prev?.fcr_pct),
      good: 'up',
      tone: VERDICT_TONE[fcrVerdict(cur.fcr_pct)],
    },
  ];

  // ── 4. Charts ───────────────────────────────────────────────────────────────
  const inbound = t('direction.inbound', 'Inbound');
  const outbound = t('direction.outbound', 'Outbound');
  const byDay = trend.map((p) => ({
    date: p.date.slice(5),
    inbound: p.total_calls,
    outbound: p.outbound_total ?? 0,
    answered: p.answered_calls,
    abandoned: p.abandoned_calls,
  }));
  const daily = byDay.length > 1;           // one day has no trend to draw

  const tooltipStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-accent)',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-xs)',
    boxShadow: 'var(--shadow-lg)',
  };
  const axisTick = { fontSize: 11, fill: 'var(--text-muted)' };
  // Stacked segments sit on a 2px surface gap, and only the top segment rounds its end.
  const seg = { stroke: 'var(--bg-card)', strokeWidth: 2 } as const;
  const top: [number, number, number, number] = [4, 4, 0, 0];

  const chartTitle = (label: string, tip: ReturnType<typeof kpiTip>) => (
    <span className="u-inline-row u-gap-1h">
      {label}
      <Tooltip {...tip} />
    </span>
  );

  return (
    <div className="u-col u-gap-4">
      <div className="an-export-row">
        <AnalyticsExportButton report="overview" dateRange={dateRange}
          title={t('analytics.export.overviewTitle', 'The period’s figures as a CSV file')} />
        <AnalyticsExportButton report="trend" dateRange={dateRange}
          label={t('analytics.export.trendCsv', 'Daily CSV')}
          title={t('analytics.export.trendTitle', 'Calls per day as a CSV file')} />
      </div>
      <SummaryStats figures={figures} previous={previous} />
      <DirectionCards figures={figures} previous={previous} periodLabel={period} />

      <Card icon={Headset}
            title={chartTitle(t('analytics.overview.queueService', 'Queue service'),
              kpiTip(t, 'analytics.tip.overview.queueService', t('analytics.overview.queueService', 'Queue service'), undefined,
                { text: 'How the queues treated the people who waited in them: how fast they were answered, how many gave up, and whether they had to call again.' }))}>
        <StatRow>{queueService.map((c) => <StatCard key={c.label} {...c} />)}</StatRow>
      </Card>

      {daily && (
        <div className="an-chart-pair">
          <Card icon={BarChart3}
                title={chartTitle(t('analytics.overview.byDirection', 'Calls by direction'),
                  kpiTip(t, 'analytics.tip.overview.byDirectionInOut', t('analytics.overview.byDirection', 'Calls by direction'), undefined,
                    { text: 'Inbound and outbound calls per day.' }))}
                description={period}>
            <div className="an-chart-wrap" dir="ltr">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byDay} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} />
                  <YAxis tick={axisTick} width={40} axisLine={false} tickLine={false} allowDecimals={false} />
                  <ChartTooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }} />
                  <Legend wrapperStyle={{ fontSize: 'var(--text-xs)', paddingTop: 8 }} iconType="circle" iconSize={8} />
                  <Bar dataKey="inbound" name={inbound} stackId="d" fill="var(--chart-inbound)" {...seg} />
                  <Bar dataKey="outbound" name={outbound} stackId="d" fill="var(--chart-outbound)" radius={top} {...seg} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card icon={PhoneIncoming}
                title={chartTitle(t('analytics.overview.inboundOutcomes', 'Inbound outcomes'),
                  kpiTip(t, 'analytics.tip.overview.inboundOutcomes', t('analytics.overview.inboundOutcomes', 'Inbound outcomes'), undefined,
                    { text: 'Inbound calls per day: answered, and the ones nobody answered.' }))}
                description={period}>
            <div className="an-chart-wrap" dir="ltr">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={byDay} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} />
                  <YAxis tick={axisTick} width={40} axisLine={false} tickLine={false} allowDecimals={false} />
                  <ChartTooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }} />
                  <Legend wrapperStyle={{ fontSize: 'var(--text-xs)', paddingTop: 8 }} iconType="circle" iconSize={8} />
                  <Bar dataKey="answered" name={t('metrics.answered')} stackId="o" fill="var(--chart-inbound)" {...seg} />
                  <Bar dataKey="abandoned" name={t('analytics.kpi.unansweredCalls', 'Unanswered')} stackId="o" fill="var(--accent-danger)" radius={top} {...seg} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
