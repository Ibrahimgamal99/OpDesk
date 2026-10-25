import { useTranslation } from 'react-i18next';
import {
  CheckCircle2, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Timer, UserCheck,
} from 'lucide-react';
import type { CallLogRecord, ExecutiveKPIResponse, KpiSummary } from '../types';
import {
  abandonVerdict, fcrVerdict, fmtPct, fmtSecs, metricTips, perCallRateVerdict, perPersonRateVerdict, slaVerdict,
} from './analyticsUtils';
import { FigureCard, StatCard, StatRow, VERDICT_TONE, type Metric, type StatCardProps } from './FigureCards';
import { callStatusLabel } from './callStatus';

/**
 * A period's traffic as cards, the same on the Dashboard (today) and on Analytics (any
 * range): SummaryStats is the headline row for all calls, DirectionCards one card each for
 * inbound and outbound. Figures come from /api/analytics/overview (figuresFromKpis), or for
 * an agent's dashboard from their own call log (figuresFromCalls). Analytics passes the
 * previous period too, for the deltas.
 *
 * Two rates. ANSWER RATE counts people: distinct outside numbers that
 * were answered over distinct outside numbers involved, so ten tries to one person who
 * finally picks up is one person reached. CONTACT RATE counts calls: answered over all.
 */

/** One direction's calls over a period. Optional figures are null when out of reach. */
export interface DirectionFigures {
  calls: number;
  answered: number;
  /** Distinct outside numbers involved, and how many of them were answered. */
  people: number;
  reached: number;
  /** reached ÷ people, as a percentage. */
  answerRate: number | null;
  /** answered ÷ calls, as a percentage. */
  contactRate: number | null;
  ahtSecs: number | null;
  /** Talk time summed over answered calls (outbound only). */
  talkSecs: number | null;
  /** How the unanswered ones ended (outbound only). */
  outcomes?: { noAnswer: number; busy: number; failed: number };
}

/** The queue's own quality figures, where the viewer has them (never an agent's). */
export interface QueueFigures {
  abandoned: number;
  abandonRate: number | null;
  slaPct: number | null;
  fcrPct: number | null;
  avgWaitSecs: number | null;
}

export interface PeriodFigures {
  all: DirectionFigures;
  /** Calls that are neither inbound nor outbound: extension to extension, feature codes and
   *  audio loopback tests. Part of `all`, so in + out + internal is the total. */
  internal: number;
  inbound: DirectionFigures;
  /** Inbound split into calls that entered a queue and direct dials to an extension, where
   *  the source tells them apart (the overview does; an agent's own call log does not). */
  inboundSplit?: { queue: number; direct: number };
  outbound: DirectionFigures;
  queue: QueueFigures | null;
}

const rate = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/** The overview endpoint's response as figures. The All row is the COMBINED block (every
 *  direction, internal included); both rates come from the backend so the dashboard and
 *  Analytics never disagree. Inbound volume is the call history's `inbound` block (queue
 *  and direct calls); the top level is the queue's own figures, which feed `queue`. */
export function figuresFromKpis(cur: KpiSummary): PeriodFigures {
  const all = cur.combined;
  const out = cur.outbound;
  // A backend without the volume blocks reported every inbound call at the top level.
  const inb = cur.inbound ?? cur;
  const allTotal = all?.total_calls ?? cur.total_calls;
  const allAnswered = all?.answered_calls ?? cur.answered_calls;
  const direct = cur.inbound_direct?.total_calls;
  return {
    all: {
      calls: allTotal, answered: allAnswered,
      people: all?.customers ?? 0, reached: all?.customers_answered ?? 0,
      answerRate: all?.answer_rate ?? null,
      contactRate: all?.contact_rate ?? rate(allAnswered, allTotal),
      ahtSecs: all?.aht_secs ?? cur.aht_secs, talkSecs: null,
    },
    internal: all?.internal_calls ?? cur.internal?.total_calls
      ?? Math.max(0, allTotal - inb.total_calls - (out?.total_calls ?? 0)),
    inbound: {
      calls: inb.total_calls, answered: inb.answered_calls,
      people: inb.customers ?? 0, reached: inb.customers_answered ?? 0,
      answerRate: inb.answer_rate ?? null,
      contactRate: inb.contact_rate ?? rate(inb.answered_calls, inb.total_calls),
      ahtSecs: inb.aht_secs, talkSecs: null,
    },
    inboundSplit: direct === undefined ? undefined : { queue: Math.max(0, inb.total_calls - direct), direct },
    outbound: {
      calls: out?.total_calls ?? 0, answered: out?.answered_calls ?? 0,
      people: out?.customers ?? 0, reached: out?.customers_answered ?? 0,
      answerRate: out?.answer_rate ?? null,
      contactRate: out?.contact_rate ?? rate(out?.answered_calls ?? 0, out?.total_calls ?? 0),
      ahtSecs: out?.aht_secs ?? null, talkSecs: out?.sum_billsec ?? null,
      outcomes: out ? { noAnswer: out.no_answer_calls, busy: out.busy_calls, failed: out.failed_calls } : undefined,
    },
    queue: {
      abandoned: cur.abandoned_calls, abandonRate: cur.abandonment_rate, slaPct: cur.sla_pct,
      fcrPct: cur.fcr_pct, avgWaitSecs: cur.avg_wait_secs,
    },
  };
}

export function figuresFromOverview(data: ExecutiveKPIResponse): PeriodFigures {
  return figuresFromKpis(data.current);
}

/** How many trailing digits identify the person on a number, and the floor below which a
 *  number is an extension rather than an outside line. Mirrors _number_key in
 *  backend/analytics.py: '01012345678' and '+201012345678' are one customer. */
const NUMBER_KEY_DIGITS = 9;
const MIN_EXTERNAL_DIGITS = 7;

/** The outside party on one call, as a comparable key; '' when there isn't one. */
function counterpartyKey(c: CallLogRecord): string {
  const digits = String((c.call_type === 'OUT' ? c.dst : c.src) ?? '').replace(/\D/g, '');
  return digits.length < MIN_EXTERNAL_DIGITS ? '' : digits.slice(-NUMBER_KEY_DIGITS);
}

function distinctCounterparties(calls: CallLogRecord[]): number {
  const keys = new Set<string>();
  for (const c of calls) {
    const k = counterpartyKey(c);
    if (k) keys.add(k);
  }
  return keys.size;
}

/** A call-log row's status: the backend's call status (callStatus.ts), or, from a row
 *  that carries none, its CDR disposition in the same words. */
function statusOf(c: CallLogRecord): string {
  const s = (c.status || c.disposition || '').trim().toUpperCase();
  return s === 'NO ANSWER' ? 'UNANSWERED' : s === 'FAILED' ? 'FAILURE' : s;
}

function directionFromCalls(calls: CallLogRecord[], withTalk = false): DirectionFigures {
  const answeredRows = calls.filter((c) => statusOf(c) === 'ANSWERED');
  const talk = answeredRows.map((c) => c.talk || 0).filter((x) => x > 0);
  const talkSum = talk.reduce((a, b) => a + b, 0);
  const people = distinctCounterparties(calls);
  const reached = distinctCounterparties(answeredRows);
  return {
    calls: calls.length,
    answered: answeredRows.length,
    people,
    reached,
    answerRate: rate(reached, people),
    contactRate: rate(answeredRows.length, calls.length),
    ahtSecs: talk.length ? Math.round(talkSum / talk.length) : null,
    talkSecs: withTalk ? talkSum : null,
    outcomes: withTalk ? {
      noAnswer: calls.filter((c) => statusOf(c) === 'UNANSWERED').length,
      busy: calls.filter((c) => statusOf(c) === 'BUSY').length,
      failed: calls.filter((c) => statusOf(c) === 'FAILURE').length,
    } : undefined,
  };
}

/** An agent's own day from their (extension-scoped) call log. */
export function figuresFromCalls(calls: CallLogRecord[]): PeriodFigures {
  return {
    all: directionFromCalls(calls),
    internal: calls.filter((c) => c.call_type !== 'IN' && c.call_type !== 'OUT').length,
    inbound: directionFromCalls(calls.filter((c) => c.call_type === 'IN')),
    outbound: directionFromCalls(calls.filter((c) => c.call_type === 'OUT'), true),
    queue: null,
  };
}

interface CardsProps {
  figures: PeriodFigures;
  /** The period before, of the same length: shown as deltas (Analytics). */
  previous?: PeriodFigures | null;
  /** Agents have no queue figures, so their Abandoned card counts their missed calls. */
  isAgent?: boolean;
}

/** previous → current change, or null when there is nothing to compare. */
function change(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  return Math.round((cur - prev) * 10) / 10;
}

/** The headline row for every call in the period, in and out. */
export function SummaryStats({ figures: f, previous: p, isAgent }: CardsProps) {
  const { t } = useTranslation();
  const tips = metricTips(t);
  const q = f.queue;
  const missed = f.all.calls - f.all.answered;

  const cards: StatCardProps[] = [
    {
      icon: <PhoneCall size={16} />, label: t('metrics.totalCalls'), value: f.all.calls.toLocaleString(),
      tip: tips.totalCalls, delta: change(f.all.calls, p?.all.calls),
      desc: t('dashboard.kpi.totalSplitInternal', {
        in: f.inbound.calls.toLocaleString(), out: f.outbound.calls.toLocaleString(), internal: f.internal.toLocaleString(),
      }),
    },
    {
      icon: <CheckCircle2 size={16} />, label: t('metrics.answered'), value: f.all.answered.toLocaleString(),
      tip: tips.answered, delta: change(f.all.answered, p?.all.answered), good: 'up',
      desc: t('metrics.contactRateOf', { rate: fmtPct(f.all.contactRate) }),
    },
    {
      icon: <UserCheck size={16} />, label: t('metrics.answerRate'), value: fmtPct(f.all.answerRate),
      tip: tips.answerRate, delta: change(f.all.answerRate, p?.all.answerRate), good: 'up',
      desc: t('dashboard.kpi.peopleReached', { reached: f.all.reached.toLocaleString(), people: f.all.people.toLocaleString() }),
      tone: VERDICT_TONE[perPersonRateVerdict(f.all.answerRate)],
    },
    isAgent || !q ? {
      icon: <PhoneMissed size={16} />, label: t('metrics.missed'), value: missed.toLocaleString(),
      tip: tips.missed, tone: missed > 0 ? 'danger' : '',
    } : {
      icon: <PhoneMissed size={16} />, label: t('metrics.abandoned'), value: q.abandoned.toLocaleString(),
      tip: tips.abandoned, delta: change(q.abandoned, p?.queue?.abandoned), good: 'down',
      desc: t('metrics.abandonRateOf', { rate: fmtPct(q.abandonRate) }),
      tone: VERDICT_TONE[abandonVerdict(q.abandonRate)],
    },
    {
      icon: <Timer size={16} />, label: t('metrics.aht'), value: fmtSecs(f.all.ahtSecs),
      tip: tips.aht, delta: change(f.all.ahtSecs, p?.all.ahtSecs), good: 'down',
    },
  ];

  return <StatRow>{cards.map((c) => <StatCard key={c.label} {...c} />)}</StatRow>;
}

/** Inbound and outbound, one figure card each. */
export function DirectionCards({ figures: f, previous: p, periodLabel }: Omit<CardsProps, 'isAgent'> & {
  /** What the period is called on the card: "Today so far", "2026-09-26 → 2026-10-25". */
  periodLabel: string;
}) {
  const { t } = useTranslation();
  const tips = metricTips(t);
  const q = f.queue;

  const answered = (d: DirectionFigures): Metric =>
    ({ key: 'answered', label: t('metrics.answered'), value: d.answered.toLocaleString(), tip: tips.answered });
  const answerRate = (d: DirectionFigures): Metric => ({
    key: 'answerRate', label: t('metrics.answerRate'), value: fmtPct(d.answerRate),
    tone: VERDICT_TONE[perPersonRateVerdict(d.answerRate)], tip: tips.answerRate,
  });
  const contactRate = (d: DirectionFigures): Metric => ({
    key: 'contactRate', label: t('metrics.contactRate'), value: fmtPct(d.contactRate),
    tone: VERDICT_TONE[perCallRateVerdict(d.contactRate)], tip: tips.contactRate,
  });
  const aht = (d: DirectionFigures): Metric =>
    ({ key: 'aht', label: t('metrics.aht'), value: fmtSecs(d.ahtSecs), tip: tips.aht });

  const inboundMetrics: Metric[] = [
    answered(f.inbound),
    answerRate(f.inbound),
    contactRate(f.inbound),
    ...(q ? [
      { key: 'sla', label: t('metrics.sla'), value: fmtPct(q.slaPct), tone: VERDICT_TONE[slaVerdict(q.slaPct)], tip: tips.sla },
      { key: 'abandoned', label: t('metrics.abandoned'), value: q.abandoned.toLocaleString(), tip: tips.abandoned,
        tone: VERDICT_TONE[abandonVerdict(q.abandonRate)] },
      { key: 'abandonRate', label: t('metrics.abandonRate'), value: fmtPct(q.abandonRate),
        tone: VERDICT_TONE[abandonVerdict(q.abandonRate)], tip: tips.abandonRate },
      { key: 'fcr', label: t('metrics.fcr'), value: fmtPct(q.fcrPct), tone: VERDICT_TONE[fcrVerdict(q.fcrPct)], tip: tips.fcr },
      { key: 'avgWait', label: t('metrics.avgWait'), value: fmtSecs(q.avgWaitSecs), tip: tips.avgWait },
    ] : []),
    aht(f.inbound),
  ];
  const outboundMetrics: Metric[] = [
    answered(f.outbound),
    answerRate(f.outbound),
    contactRate(f.outbound),
    aht(f.outbound),
    ...(f.outbound.talkSecs !== null
      ? [{ key: 'talk', label: t('metrics.talkTime'), value: fmtSecs(f.outbound.talkSecs), tip: tips.talkTime }]
      : []),
  ];
  const o = f.outbound.outcomes;

  return (
    <div className="dcards">
      <FigureCard
        icon={<PhoneIncoming size={18} />} title={t('direction.inbound', 'Inbound')}
        periodLabel={periodLabel}
        period={f.inbound.calls}
        periodDelta={change(f.inbound.calls, p?.inbound.calls)}
        periodParts={f.inboundSplit ? [
          { label: t('analytics.overview.viaQueue', 'Queue'), n: f.inboundSplit.queue },
          { label: t('analytics.overview.direct', 'Direct'), n: f.inboundSplit.direct },
        ] : []}
        metrics={inboundMetrics}
      />
      <FigureCard
        icon={<PhoneOutgoing size={18} />} title={t('direction.outbound', 'Outbound')}
        periodLabel={periodLabel}
        period={f.outbound.calls}
        periodDelta={change(f.outbound.calls, p?.outbound.calls)}
        periodParts={o ? [
          { label: callStatusLabel(t, 'UNANSWERED'), n: o.noAnswer },
          { label: callStatusLabel(t, 'BUSY'), n: o.busy },
          { label: callStatusLabel(t, 'FAILURE'), n: o.failed },
        ] : []}
        metrics={outboundMetrics}
      />
    </div>
  );
}
