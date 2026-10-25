import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';
import {
  BarChart3, Clock, Gauge, Headset, Hourglass, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOff, RefreshCcw, Undo2,
} from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { ExecutiveKPIResponse, HourVolume, VolumeTrendPoint } from '../types';
import {
  fmtSecs, fmtPct, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip, metricTips, rangeLabel,
  slaVerdict, abandonVerdict, fcrVerdict, perPersonRateVerdict,
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
 *   3. queue service: the queue's own quality figures, together, and the abandoned
 *      callers an agent rang back;
 *   4. charts: calls by direction per day, inbound outcomes per day, calls by hour of day.
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
        analyticsGet<{ trend: VolumeTrendPoint[]; hourly?: HourVolume[] }>(`/api/analytics/trend?${params}`),
      ]);
      return { kpis, trend: trendResp.trend || [], hourly: trendResp.hourly || [] };
    },
    [dateRange],
  );
  const kpis = data?.kpis ?? null;
  const trend = data?.trend ?? [];
  const hourly = data?.hourly ?? [];

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
  // Null past 31 days: a wide range is a picture of a period, with no deltas.
  const prev = kpis.prev_period;
  const cfg = kpis.settings;

  // The headline row and the Inbound / Outbound cards are the Dashboard's own components,
  // fed this range and the one before it.
  const figures = figuresFromKpis(cur);
  const previous = prev ? figuresFromKpis(prev) : null;

  // ── Tips. OpDesk's own formulas, so they carry their own English. ───────────
  const tips = {
    ...metricTips(t),
    shortAbandon: kpiTip(t, 'analytics.tip.kpi.shortAbandonShare', t('analytics.kpi.shortAbandon'), undefined,
      { text: 'Inbound callers who hung up within the short-abandon threshold — usually misdials.', formula: 'quick hang-ups ÷ offered' }),
    recovered: kpiTip(t, 'analytics.tip.kpi.recovered', t('analytics.kpi.recovered', 'Recovered callers'),
      { hours: cfg?.callback_window_hours ?? 24 },
      { text: 'Callers who gave up waiting in a queue and whom an agent rang back within {{hours}} hours. Counted in people: three abandons and one call back is one caller recovered.',
        formula: 'callers rung back ÷ callers who abandoned' }),
    netAbandon: kpiTip(t, 'analytics.tip.kpi.netAbandon', t('analytics.kpi.netAbandon', 'Net abandon rate'), undefined,
      { text: 'The abandon rate with the calls of the callers we rang back taken out. The abandon rate itself still counts them.',
        formula: '(abandoned − abandoned calls of recovered callers) ÷ offered' }),
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
      // The population behind the figure, and a mark while its window is still open.
      desc: cur.fcr_callers
        ? [
          t('analytics.kpi.fcrCallers', '{{repeat}} of {{callers}} callers came back', {
            repeat: (cur.fcr_repeat_callers ?? 0).toLocaleString(), callers: cur.fcr_callers.toLocaleString(),
          }),
          cur.fcr_provisional ? t('analytics.kpi.provisional', 'provisional') : '',
        ].filter(Boolean).join(' · ')
        : t('analytics.kpi.fcrDesc'),
      delta: delta(cur.fcr_pct, prev?.fcr_pct),
      good: 'up',
      tone: VERDICT_TONE[fcrVerdict(cur.fcr_pct)],
    },
  ];

  // ── 3b. Recovery: the abandoned callers an agent went back and got ──────────
  const recovery: StatCardProps[] = cur.abandoned_callers === undefined ? [] : [
    {
      icon: <Undo2 size={16} />,
      label: t('analytics.kpi.recovered', 'Recovered callers'),
      value: fmtPct(cur.recovery_rate ?? null),
      tip: tips.recovered,
      desc: t('analytics.kpi.recoveredOf', '{{recovered}} of {{abandoned}} callers who gave up', {
        recovered: (cur.recovered_callers ?? 0).toLocaleString(), abandoned: cur.abandoned_callers.toLocaleString(),
      }),
      delta: delta(cur.recovery_rate, prev?.recovery_rate),
      good: 'up',
      tone: VERDICT_TONE[perPersonRateVerdict(cur.recovery_rate)],
    },
    {
      icon: <PhoneCall size={16} />,
      label: t('analytics.kpi.netAbandon', 'Net abandon rate'),
      value: fmtPct(cur.net_abandonment_rate ?? null),
      tip: tips.netAbandon,
      desc: t('metrics.abandonRateOf', { rate: fmtPct(cur.abandonment_rate) }),
      delta: delta(cur.net_abandonment_rate, prev?.net_abandonment_rate),
      good: 'down',
      tone: VERDICT_TONE[abandonVerdict(cur.net_abandonment_rate)],
    },
  ];

  // ── 4. Charts ───────────────────────────────────────────────────────────────
  const inbound = t('direction.inbound', 'Inbound');
  const outbound = t('direction.outbound', 'Outbound');
  const internal = t('direction.internal', 'Internal');
  const byDay = trend.map((p) => ({
    date: p.date.slice(5),
    inbound: p.total_calls,
    outbound: p.outbound_total ?? 0,
    internal: p.internal_total ?? 0,
    answered: p.answered_calls,
    abandoned: p.abandoned_calls,
  }));
  const daily = byDay.length > 1;           // one day has no trend to draw
  const byHour = hourly.map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}:00` }));
  const hasHours = byHour.some((h) => h.inbound + h.outbound + h.internal > 0);

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
        <StatRow>{[...queueService, ...recovery].map((c) => <StatCard key={c.label} {...c} />)}</StatRow>
      </Card>

      {daily && (
        <div className="an-chart-pair">
          <Card icon={BarChart3}
                title={chartTitle(t('analytics.overview.byDirection', 'Calls by direction'),
                  kpiTip(t, 'analytics.tip.overview.byDirection', t('analytics.overview.byDirection', 'Calls by direction'), undefined,
                    { text: 'Inbound, outbound and internal calls per day.' }))}
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
                  <Bar dataKey="outbound" name={outbound} stackId="d" fill="var(--chart-outbound)" {...seg} />
                  <Bar dataKey="internal" name={internal} stackId="d" fill="var(--text-muted)" radius={top} {...seg} />
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

      {hasHours && (
        <Card icon={Clock}
              title={chartTitle(t('analytics.overview.byHour', 'Calls by hour of day'),
                kpiTip(t, 'analytics.tip.overview.byHour', t('analytics.overview.byHour', 'Calls by hour of day'), undefined,
                  { text: 'Every call in the period by the hour it started, inbound, outbound and internal: the busiest hours of the day.' }))}
              description={period}>
          <div className="an-chart-wrap" dir="ltr">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={byHour} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} interval={2} />
                <YAxis tick={axisTick} width={40} axisLine={false} tickLine={false} allowDecimals={false} />
                <ChartTooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }} />
                <Legend wrapperStyle={{ fontSize: 'var(--text-xs)', paddingTop: 8 }} iconType="circle" iconSize={8} />
                <Bar dataKey="inbound" name={inbound} stackId="h" fill="var(--chart-inbound)" {...seg} />
                <Bar dataKey="outbound" name={outbound} stackId="h" fill="var(--chart-outbound)" {...seg} />
                <Bar dataKey="internal" name={internal} stackId="h" fill="var(--text-muted)" radius={top} {...seg} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
    </div>
  );
}
