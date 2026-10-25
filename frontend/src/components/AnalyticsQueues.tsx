import { Fragment, useMemo, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, LabelList, ResponsiveContainer,
} from 'recharts';
import { BarChart3, Grid3x3, ListOrdered } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { QueueKPIRow, HeatmapData } from '../types';
import {
  fmtSecs, fmtPct, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip, metricTips, pctOf, rangeLabel,
  slaVerdict, abandonVerdict, targetVerdict,
} from './analyticsUtils';
import { Alert, Badge, Card, Dropdown, EmptyState, Tooltip } from './ui';
import { FigureCard, VERDICT_TONE, type Metric } from './FigureCards';
import { AnalyticsExportButton } from './AnalyticsExport';

interface HeatmapProps { data: HeatmapData }

function Heatmap({ data }: HeatmapProps) {
  const { t } = useTranslation();
  const { matrix, abandoned_matrix, labels } = data;

  const allValues = matrix.flat();
  const maxVal = Math.max(...allValues, 1);

  const dayLabels = labels.days;
  const hourLabels = labels.hours.map((h, i) => i % 3 === 0 ? h.slice(0, 2) : '');

  return (
    <div className="an-heatmap">
      <div className="an-heatmap-grid">
        {/* Header row */}
        <div className="an-heatmap-day-label" />
        {hourLabels.map((h, i) => (
          <div key={i} className="an-heatmap-hour-label">{h}</div>
        ))}

        {/* Data rows */}
        {dayLabels.map((day, dayIdx) => (
          <Fragment key={dayIdx}>
            <div className="an-heatmap-day-label">{day}</div>
            {Array.from({ length: 24 }, (_, hr) => {
              const count = matrix[dayIdx]?.[hr] ?? 0;
              const abandoned = abandoned_matrix[dayIdx]?.[hr] ?? 0;
              const intensity = count / maxVal;
              const tip = t('analytics.queues.heatmapCell', '{{day}} {{hour}}: {{count}} calls ({{abandoned}} abandoned)',
                { day, hour: labels.hours[hr], count, abandoned });
              return (
                // The cell's tint is data, so only its alpha travels inline; the colour
                // itself stays in analytics.css (.an-heatmap-cell).
                <div
                  key={`cell-${dayIdx}-${hr}`}
                  className="an-heatmap-cell"
                  data-tip={tip}
                  style={{ '--an-heat': count === 0 ? 0.04 : (0.08 + intensity * 0.72).toFixed(2) } as React.CSSProperties}
                />
              );
            })}
          </Fragment>
        ))}
      </div>

      <div className="an-heatmap-legend">
        <span>{t('analytics.queues.heatmapLow', 'Low')}</span>
        <div className="an-heatmap-legend-bar" />
        <span>{t('analytics.queues.heatmapHigh', 'High')}</span>
      </div>
    </div>
  );
}

/** What the comparison chart ranks the queues by. */
type CompareKey = 'sla' | 'answerRate' | 'contactRate' | 'abandonRate' | 'avgWait' | 'offered';

/** A queue row, plus the per-person answer rate a backend may add (absent: not offered). */
type QueueRow = QueueKPIRow & { answer_rate?: number | null };

interface Props { dateRange: DateRange }

/**
 * Analytics → Queues, for the chosen range:
 *
 *   1. one card per queue: offered, answered, abandoned and the queue's quality figures;
 *   2. the queues side by side on one figure at a time;
 *   3. when the queue calls arrive, by weekday and hour.
 */
export function AnalyticsQueues({ dateRange }: Props) {
  const { t } = useTranslation();
  const [compareBy, setCompareBy] = useState<CompareKey>('sla');

  const { data, loading, error } = useAnalyticsFetch(
    async () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      const [queueResp, heatmap] = await Promise.all([
        analyticsGet<{ queues: QueueKPIRow[] }>(`/api/analytics/queue-performance?${params}`),
        analyticsGet<HeatmapData>(`/api/analytics/heatmap?${params}`),
      ]);
      return { queues: queueResp.queues || [], heatmap };
    },
    [dateRange],
  );

  const queues = useMemo(() => data?.queues ?? [], [data]);
  const heatmap = data?.heatmap ?? null;

  if (loading) {
    return <div className="an-loading"><div className="an-spinner" />{t('analytics.loading')}</div>;
  }
  if (error) {
    return <Alert>{t('analytics.error')}</Alert>;
  }
  if (queues.length === 0) {
    return <EmptyState icon={ListOrdered} title={t('analytics.empty', 'No data for this period')} />;
  }

  const queueName = (q: QueueKPIRow) =>
    q.queue_name && q.queue_name !== q.queue_extension ? `${q.queue_extension} · ${q.queue_name}` : q.queue_extension;
  // Answered ÷ offered counts calls, so on the shared definitions it is the contact rate.
  const contactRate = (q: QueueKPIRow) => pctOf(q.answered_calls, q.total_calls);
  const abandonRate = (q: QueueKPIRow) => pctOf(q.abandoned_calls, q.total_calls);

  const shared = metricTips(t);
  const tips = {
    sla: kpiTip(t, 'analytics.tip.queues.slaAnswered', t('metrics.sla'), undefined,
      { text: 'How often this queue’s answered calls were picked up within its SLA threshold. The goal is 80%.', formula: 'answered in time ÷ answered' }),
    contactRate: shared.contactRate,
    abandon: shared.abandonRate,
    avgWait: kpiTip(t, 'analytics.tip.queues.avgWait', t('metrics.avgWait'), undefined,
      { text: 'How long callers wait in this queue, including those who gave up.', formula: 'total wait ÷ callers' }),
    aht: shared.aht,
    peak: kpiTip(t, 'analytics.tip.queues.peakHour', t('analytics.queues.peakHour'), undefined,
      { text: 'The busiest hour of the day, across the whole date range.' }),
  };

  const metricsOf = (q: QueueKPIRow): Metric[] => [
    { key: 'sla', label: t('metrics.sla'), value: fmtPct(q.sla_pct),
      tone: VERDICT_TONE[slaVerdict(q.sla_pct)], tip: tips.sla },
    { key: 'contactRate', label: t('metrics.contactRate'), value: fmtPct(contactRate(q)),
      tone: VERDICT_TONE[targetVerdict(contactRate(q), 80)], tip: tips.contactRate },
    { key: 'abandon', label: t('metrics.abandonRate'), value: fmtPct(abandonRate(q)),
      tone: VERDICT_TONE[abandonVerdict(abandonRate(q))], tip: tips.abandon },
    { key: 'wait', label: t('metrics.avgWait'), value: fmtSecs(q.avg_wait_secs), tip: tips.avgWait },
    { key: 'aht', label: t('metrics.aht'), value: fmtSecs(q.aht_secs), tip: tips.aht },
    { key: 'peak', label: t('analytics.queues.peakHour'),
      value: q.peak_hour !== null ? `${String(q.peak_hour).padStart(2, '0')}:00` : '—', tip: tips.peak },
  ];

  // ── Comparison: one figure across every queue ──────────────────────────────
  // Answer rate counts people (metrics.tip.answerRate), so it is offered only when the
  // server sends it per queue; answered ÷ offered is the contact rate, always computable.
  const hasAnswerRate = queues.some((q: QueueRow) => q.answer_rate !== undefined && q.answer_rate !== null);
  const compareOptions: { value: CompareKey; label: string; pct: boolean; pick: (q: QueueRow) => number | null }[] = [
    { value: 'sla', label: t('metrics.sla'), pct: true, pick: (q) => q.sla_pct },
    ...(hasAnswerRate
      ? [{ value: 'answerRate' as const, label: t('metrics.answerRate'), pct: true, pick: (q: QueueRow) => q.answer_rate ?? null }]
      : []),
    { value: 'contactRate', label: t('metrics.contactRate'), pct: true, pick: contactRate },
    { value: 'abandonRate', label: t('metrics.abandonRate'), pct: true, pick: abandonRate },
    { value: 'avgWait', label: t('metrics.avgWait'), pct: false, pick: (q) => q.avg_wait_secs },
    { value: 'offered', label: t('analytics.queues.offered', 'Offered'), pct: false, pick: (q) => q.total_calls },
  ];
  const compare = compareOptions.find((o) => o.value === compareBy) ?? compareOptions[0];
  const fmtCompare = (v: number) =>
    compare.pct ? fmtPct(v) : compareBy === 'avgWait' ? fmtSecs(v) : v.toLocaleString();
  const compareRows = queues
    .map((q) => ({ name: queueName(q), value: compare.pick(q) }))
    .filter((r): r is { name: string; value: number } => r.value !== null)
    .sort((a, b) => b.value - a.value);

  const period = rangeLabel(dateRange);
  const tooltipStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-accent)',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-xs)',
    boxShadow: 'var(--shadow-lg)',
  };
  const axisTick = { fontSize: 11, fill: 'var(--text-muted)' };
  const title = (label: string, tip: ReturnType<typeof kpiTip>) => (
    <span className="u-inline-row u-gap-1h">
      {label}
      <Tooltip {...tip} />
    </span>
  );

  return (
    <div className="u-col u-gap-4">
      <div className="an-export-row">
        <AnalyticsExportButton report="queues" dateRange={dateRange}
          title={t('analytics.export.queuesTitle', 'Every queue’s figures as a CSV file')} />
      </div>
      {/* ── 1. One card per queue ── */}
      <div className="dcards">
        {queues.map((q) => (
          <FigureCard
            key={q.queue_extension}
            icon={<ListOrdered size={18} />}
            title={queueName(q)}
            tip={kpiTip(t, 'analytics.tip.queues.card', queueName(q), undefined,
              { text: 'This queue over the period: calls offered to it, how many an agent answered and how many gave up, and how well it served them.' })}
            badge={slaVerdict(q.sla_pct) === 'bad'
              ? <Badge tone="danger">{t('analytics.queues.belowTarget', 'Below SLA target')}</Badge> : undefined}
            periodLabel={t('analytics.queues.offered', 'Offered')}
            period={q.total_calls}
            periodParts={[
              { label: t('metrics.answered'), n: q.answered_calls },
              { label: t('metrics.abandoned'), n: q.abandoned_calls },
            ]}
            metrics={metricsOf(q)}
          />
        ))}
      </div>

      {/* ── 2. The queues side by side ── */}
      {queues.length > 1 && (
        <Card
          icon={BarChart3}
          title={title(t('analytics.queues.compareTitle', 'Compare queues'),
            kpiTip(t, 'analytics.tip.queues.compare', t('analytics.queues.compareTitle', 'Compare queues'), undefined,
              { text: 'Every queue on one figure at a time, best first. Pick the figure from the menu.' }))}
          description={period}
          actions={
            <Dropdown
              value={compareBy}
              onChange={(v) => setCompareBy(v as CompareKey)}
              options={compareOptions.map(({ value, label }) => ({ value, label }))}
              ariaLabel={t('analytics.queues.compareBy', 'Compare by')}
              size="sm"
            />
          }
        >
          <div className="an-chart-wrap" dir="ltr">
            <ResponsiveContainer width="100%" height={Math.max(120, 32 + compareRows.length * 36)}>
              <BarChart data={compareRows} layout="vertical" margin={{ top: 4, right: 56, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false}
                       domain={compare.pct ? [0, 100] : [0, 'auto']}
                       tickFormatter={(v) => (compare.pct ? `${v}%` : compareBy === 'avgWait' ? fmtSecs(v) : String(v))} />
                <YAxis type="category" dataKey="name" tick={axisTick} width={140} axisLine={false} tickLine={false} />
                <ChartTooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }}
                              formatter={(v) => [fmtCompare(Number(v)), compare.label]} />
                <Bar dataKey="value" name={compare.label} fill="var(--chart-inbound)" radius={[0, 4, 4, 0]} barSize={18}>
                  <LabelList dataKey="value" position="right" formatter={(v: unknown) => fmtCompare(Number(v))}
                             className="an-bar-label" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* ── 3. When the calls arrive ── */}
      {heatmap && (
        <Card
          icon={Grid3x3}
          title={title(t('analytics.queues.heatmapTitle'),
            kpiTip(t, 'analytics.tip.queues.heatmap', t('analytics.queues.heatmapTitle'), undefined,
              { text: 'When your calls come in, by day and hour. Darker means busier.' }))}
          description={period}
          actions={<AnalyticsExportButton report="heatmap" dateRange={dateRange}
            title={t('analytics.export.heatmapTitle', 'Calls by weekday and hour as a CSV file')} />}
        >
          <Heatmap data={heatmap} />
        </Card>
      )}
    </div>
  );
}
