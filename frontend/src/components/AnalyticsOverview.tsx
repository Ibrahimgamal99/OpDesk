import { useTranslation } from 'react-i18next';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, Legend, ResponsiveContainer,
} from 'recharts';
import {
  BarChart3, Gauge, Headset, Hourglass, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing,
  RefreshCcw, Timer, UserCheck,
} from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { ExecutiveKPIResponse, VolumeTrendPoint } from '../types';
import {
  fmtSecs, fmtPct, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip, pctOf, rangeLabel,
  slaVerdict, abandonVerdict, fcrVerdict, perCallRateVerdict, perPersonRateVerdict,
} from './analyticsUtils';
import { Alert, Card, Tooltip } from './ui';
import { FigureCard, StatCard, StatRow, VERDICT_TONE, type Metric, type StatCardProps } from './FigureCards';

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
  const all = cur.combined;
  const prevAll = prev?.combined;
  const out = cur.outbound;
  const prevOut = prev?.outbound;

  const allTotal = all?.total_calls ?? cur.total_calls;
  const allAnswered = all?.answered_calls ?? cur.answered_calls;
  // Answer rate counts people (distinct outside numbers reached ÷ involved), contact rate
  // counts calls (answered ÷ all). Both come from the backend, the same as the Dashboard.
  const allRate = all?.answer_rate ?? null;
  const prevAllRate = prevAll?.answer_rate ?? null;
  const allContact = all?.contact_rate ?? pctOf(allAnswered, allTotal);
  const inRate = cur.answer_rate ?? null;
  const inContact = cur.contact_rate ?? pctOf(cur.answered_calls, cur.total_calls);
  const outContact = out ? out.contact_rate ?? pctOf(out.answered_calls, out.total_calls) : null;

  // ── Tips. OpDesk's own formulas, so they carry their own English. ───────────
  const tips = {
    volume: kpiTip(t, 'analytics.tip.kpi.volume', t('analytics.kpi.volume'), undefined,
      { text: 'Every call in this period — in, out and internal.' }),
    answerRate: kpiTip(t, 'analytics.tip.kpi.answerRate', t('analytics.kpi.answerRate'), undefined,
      { text: 'Share of the distinct outside numbers in the period that were actually spoken to, in and out together — however many calls each took. It counts people, not calls.', formula: 'numbers that answered ÷ distinct numbers' }),
    contactRate: kpiTip(t, 'analytics.tip.kpi.contactRate', t('analytics.kpi.contactRate', 'Contact rate'), undefined,
      { text: 'Share of the calls that connected — every call counted, retries included. Answer rate counts the people behind the calls instead.', formula: 'answered ÷ calls' }),
    sla: kpiTip(t, 'analytics.tip.kpi.slaAnswered', t('analytics.kpi.sla'), undefined,
      { text: 'How often answered inbound calls were picked up within the queue’s SLA threshold.', formula: 'answered in time ÷ answered' }),
    aht: kpiTip(t, 'analytics.tip.kpi.ahtTalk', t('analytics.kpi.aht'), undefined,
      { text: 'Average talk time of an answered call.', formula: 'talk time ÷ answered' }),
    abandonment: kpiTip(t, 'analytics.tip.kpi.abandonRate', t('analytics.kpi.abandonment'), undefined,
      { text: 'How many inbound callers hung up before anyone answered.', formula: 'not answered ÷ offered' }),
    shortAbandon: kpiTip(t, 'analytics.tip.kpi.shortAbandonShare', t('analytics.kpi.shortAbandon'), undefined,
      { text: 'Inbound callers who hung up within the short-abandon threshold — usually misdials.', formula: 'quick hang-ups ÷ offered' }),
    avgWait: kpiTip(t, 'analytics.tip.kpi.avgWait', t('analytics.kpi.avgWait'), undefined,
      { text: 'How long queue callers wait before someone picks up.', formula: 'total wait ÷ callers' }),
    fcr: kpiTip(t, 'analytics.tip.kpi.fcrRepeat', t('analytics.kpi.fcr'), undefined,
      { text: 'Answered queue callers who did not call a queue again within the FCR window.', formula: 'callers with no repeat call ÷ answered callers' }),
    inboundRate: kpiTip(t, 'analytics.tip.kpi.inboundPeopleRate', t('analytics.kpi.inboundAnswerRate'), undefined,
      { text: 'Share of the distinct numbers that called in whose call was answered — however many times each called.', formula: 'callers answered ÷ distinct callers' }),
    outboundRate: kpiTip(t, 'analytics.tip.kpi.outboundPeopleRate', t('analytics.kpi.outboundAnswerRate'), undefined,
      { text: 'Share of the distinct numbers dialled that picked up at least once — however many tries each took.', formula: 'numbers that answered ÷ distinct numbers dialled' }),
    market: kpiTip(t, 'analytics.tip.kpi.market', t('analytics.kpi.market'), undefined,
      { text: 'Total talk time on answered outbound calls.' }),
  };

  // ── 1. Headline: what a stakeholder reads first ─────────────────────────────
  const headline: StatCardProps[] = [
    {
      icon: <PhoneCall size={16} />,
      label: t('analytics.kpi.volume'),
      value: allTotal.toLocaleString(),
      tip: tips.volume,
      desc: t('dashboard.kpi.totalSplitInternal', '{{in}} in · {{out}} out · {{internal}} internal', {
        in: cur.total_calls.toLocaleString(), out: (out?.total_calls ?? 0).toLocaleString(),
        internal: (all?.internal_calls ?? Math.max(0, allTotal - cur.total_calls - (out?.total_calls ?? 0))).toLocaleString(),
      }),
      delta: delta(allTotal, prevAll?.total_calls ?? prev?.total_calls),
    },
    {
      icon: <UserCheck size={16} />,
      label: t('analytics.kpi.answerRate'),
      value: fmtPct(allRate),
      tip: tips.answerRate,
      desc: t('analytics.kpi.contactRateOf', 'Contact rate {{rate}}', { rate: fmtPct(allContact) }),
      delta: delta(allRate, prevAllRate),
      good: 'up',
      tone: VERDICT_TONE[perPersonRateVerdict(allRate)],
    },
    {
      icon: <Gauge size={16} />,
      label: t('analytics.kpi.sla'),
      value: fmtPct(cur.sla_pct),
      tip: tips.sla,
      delta: delta(cur.sla_pct, prev?.sla_pct),
      good: 'up',
      tone: VERDICT_TONE[slaVerdict(cur.sla_pct)],
    },
    {
      icon: <Timer size={16} />,
      label: t('analytics.kpi.aht'),
      value: fmtSecs(all?.aht_secs ?? cur.aht_secs),
      tip: tips.aht,
      delta: delta(all?.aht_secs ?? cur.aht_secs, prevAll?.aht_secs ?? prev?.aht_secs),
      good: 'down',
    },
  ];

  // ── 2. Directions ───────────────────────────────────────────────────────────
  const period = rangeLabel(dateRange);
  const inboundMetrics: Metric[] = [
    { key: 'answerRate', label: t('analytics.kpi.inboundAnswerRate'), value: fmtPct(inRate),
      tone: VERDICT_TONE[perPersonRateVerdict(inRate)], tip: tips.inboundRate },
    { key: 'contactRate', label: t('analytics.kpi.contactRate', 'Contact rate'), value: fmtPct(inContact),
      tone: VERDICT_TONE[perCallRateVerdict(inContact)], tip: tips.contactRate },
    { key: 'sla', label: t('analytics.kpi.sla'), value: fmtPct(cur.sla_pct),
      tone: VERDICT_TONE[slaVerdict(cur.sla_pct)], tip: tips.sla },
    { key: 'abandon', label: t('analytics.kpi.abandonment'), value: fmtPct(cur.abandonment_rate),
      tone: VERDICT_TONE[abandonVerdict(cur.abandonment_rate)], tip: tips.abandonment },
    { key: 'aht', label: t('analytics.kpi.aht'), value: fmtSecs(cur.aht_secs), tip: tips.aht },
    { key: 'wait', label: t('analytics.kpi.avgWait'), value: fmtSecs(cur.avg_wait_secs), tip: tips.avgWait },
  ];
  const outboundMetrics: Metric[] = out ? [
    { key: 'answerRate', label: t('analytics.kpi.outboundAnswerRate'), value: fmtPct(out.answer_rate),
      tone: VERDICT_TONE[perPersonRateVerdict(out.answer_rate)], tip: tips.outboundRate },
    { key: 'contactRate', label: t('analytics.kpi.contactRate', 'Contact rate'), value: fmtPct(outContact),
      tone: VERDICT_TONE[perCallRateVerdict(outContact)], tip: tips.contactRate },
    { key: 'aht', label: t('analytics.kpi.outboundAht'), value: fmtSecs(out.aht_secs), tip: tips.aht },
    { key: 'talk', label: t('analytics.kpi.market'), value: fmtSecs(out.sum_billsec), tip: tips.market },
  ] : [];

  // ── 3. Queue service: how the queue treated the people who waited in it ─────
  const queueService: StatCardProps[] = [
    {
      icon: <Gauge size={16} />,
      label: t('analytics.kpi.sla'),
      value: fmtPct(cur.sla_pct),
      tip: tips.sla,
      desc: t('analytics.kpi.slaDesc'),
      delta: delta(cur.sla_pct, prev?.sla_pct),
      good: 'up',
      tone: VERDICT_TONE[slaVerdict(cur.sla_pct)],
    },
    {
      icon: <PhoneMissed size={16} />,
      label: t('analytics.kpi.abandonment'),
      value: fmtPct(cur.abandonment_rate),
      tip: tips.abandonment,
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
      label: t('analytics.kpi.avgWaitKpi'),
      value: fmtSecs(cur.avg_wait_secs),
      tip: tips.avgWait,
      desc: t('analytics.kpi.avgWaitDesc'),
      delta: delta(cur.avg_wait_secs, prev?.avg_wait_secs),
      good: 'down',
    },
    {
      icon: <RefreshCcw size={16} />,
      label: t('analytics.kpi.fcr'),
      value: fmtPct(cur.fcr_pct),
      tip: tips.fcr,
      desc: t('analytics.kpi.fcrDesc'),
      delta: delta(cur.fcr_pct, prev?.fcr_pct),
      good: 'up',
      tone: VERDICT_TONE[fcrVerdict(cur.fcr_pct)],
    },
  ];

  // ── 4. Charts ───────────────────────────────────────────────────────────────
  const inbound = t('analytics.directions.inbound', 'Inbound');
  const outbound = t('analytics.directions.outbound', 'Outbound');
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
      <StatRow>{headline.map((c) => <StatCard key={c.label} {...c} />)}</StatRow>

      <div className="dcards">
        <FigureCard
          icon={<PhoneIncoming size={18} />}
          title={inbound}
          tip={kpiTip(t, 'analytics.tip.overview.inbound', inbound, undefined,
            { text: 'Calls that came in from outside over the period, and how they were handled.' })}
          periodLabel={period}
          period={cur.total_calls}
          periodDelta={prev ? cur.total_calls - prev.total_calls : null}
          periodParts={[
            { label: t('analytics.kpi.answeredCalls'), n: cur.answered_calls },
            { label: t('analytics.kpi.abandonedCalls'), n: cur.abandoned_calls },
          ]}
          metrics={inboundMetrics}
        />
        <FigureCard
          icon={<PhoneOutgoing size={18} />}
          title={outbound}
          tip={kpiTip(t, 'analytics.tip.overview.outbound', outbound, undefined,
            { text: 'Calls placed to outside numbers over the period, and how many were answered.' })}
          periodLabel={period}
          period={out ? out.total_calls : null}
          periodDelta={out && prevOut ? out.total_calls - prevOut.total_calls : null}
          periodParts={out ? [
            { label: t('analytics.kpi.answeredCalls'), n: out.answered_calls },
            { label: t('analytics.drilldown.noAnswer', 'No Answer'), n: out.no_answer_calls },
            { label: t('analytics.drilldown.busy', 'Busy'), n: out.busy_calls },
            { label: t('analytics.drilldown.failed', 'Failed'), n: out.failed_calls },
          ] : []}
          metrics={outboundMetrics}
        />
      </div>

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
                  <Bar dataKey="answered" name={t('analytics.kpi.answeredCalls')} stackId="o" fill="var(--chart-inbound)" {...seg} />
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
