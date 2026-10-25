import { useTranslation } from 'react-i18next';
import {
  CheckCircle2, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, Timer, UserCheck,
} from 'lucide-react';
import type { CallLogRecord, ExecutiveKPIResponse } from '../types';
import {
  abandonVerdict, fcrVerdict, fmtPct, fmtSecs, kpiTip, perCallRateVerdict, perPersonRateVerdict, slaVerdict,
} from './analyticsUtils';
import {
  FigureCard, StatCard, StatRow, VERDICT_TONE, type Metric, type StatCardProps, type Tip, type Tone,
} from './FigureCards';

/**
 * Today's traffic, modelled on echo's dashboard: a row of headline figures for all calls
 * (TodayKpis), then one figure card each for inbound and outbound (DirectionCards). Built
 * from /api/analytics/overview for supervisors and admins, and from the agent's own call
 * log for agents.
 *
 * Two rates, as echo draws them. ANSWER RATE counts people: distinct outside numbers that
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
   *  echo tests. Part of `all`, so in + out + internal is the total. */
  internal: number;
  inbound: DirectionFigures;
  outbound: DirectionFigures;
  queue: QueueFigures | null;
}

const rate = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/** The overview endpoint's response as figures. The All row is the COMBINED block (every
 *  direction, internal included); both rates come from the backend so the dashboard and
 *  Analytics never disagree. */
export function figuresFromOverview(data: ExecutiveKPIResponse): PeriodFigures {
  const cur = data.current;
  const all = cur.combined;
  const out = cur.outbound;
  const allTotal = all?.total_calls ?? cur.total_calls;
  const allAnswered = all?.answered_calls ?? cur.answered_calls;
  return {
    all: {
      calls: allTotal, answered: allAnswered,
      people: all?.customers ?? 0, reached: all?.customers_answered ?? 0,
      answerRate: all?.answer_rate ?? null,
      contactRate: all?.contact_rate ?? rate(allAnswered, allTotal),
      ahtSecs: all?.aht_secs ?? cur.aht_secs, talkSecs: null,
    },
    internal: all?.internal_calls ?? Math.max(0, allTotal - cur.total_calls - (out?.total_calls ?? 0)),
    inbound: {
      calls: cur.total_calls, answered: cur.answered_calls,
      people: cur.customers ?? 0, reached: cur.customers_answered ?? 0,
      answerRate: cur.answer_rate ?? null,
      contactRate: cur.contact_rate ?? rate(cur.answered_calls, cur.total_calls),
      ahtSecs: cur.aht_secs, talkSecs: null,
    },
    outbound: {
      calls: out?.total_calls ?? 0, answered: out?.answered_calls ?? 0,
      people: out?.customers ?? 0, reached: out?.customers_answered ?? 0,
      answerRate: out?.answer_rate ?? null,
      contactRate: out?.contact_rate ?? rate(out?.answered_calls ?? 0, out?.total_calls ?? 0),
      ahtSecs: out?.aht_secs ?? null, talkSecs: out?.sum_billsec ?? null,
    },
    queue: {
      abandoned: cur.abandoned_calls, abandonRate: cur.abandonment_rate, slaPct: cur.sla_pct,
      fcrPct: cur.fcr_pct, avgWaitSecs: cur.avg_wait_secs,
    },
  };
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

function directionFromCalls(calls: CallLogRecord[], withTalk = false): DirectionFigures {
  const answeredRows = calls.filter((c) => (c.disposition || '').toUpperCase() === 'ANSWERED');
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

type T = ReturnType<typeof useTranslation>['t'];

/** The two rates' tooltips, shared by the headline row and the direction cards. */
function rateTips(t: T) {
  return {
    answerRate: kpiTip(t, 'dashboard.tip.answerRate', t('dashboard.kpi.answerRate', 'Answer rate'), undefined, {
      text: 'Share of the distinct outside numbers involved that were actually spoken to — however many calls each of them took. It counts people, so ten tries to one person who finally picks up is one person reached. Internal calls between extensions are left out.',
      formula: 'numbers that answered ÷ distinct numbers',
    }),
    contactRate: kpiTip(t, 'dashboard.tip.contactRate', t('dashboard.kpi.contactRate', 'Contact rate'), undefined, {
      text: 'Share of the calls that connected — every call counted, so a number tried five times counts five times. Answer rate counts the people behind the calls instead.',
      formula: 'answered ÷ calls',
    }),
  };
}

interface TodayKpisProps {
  figures: PeriodFigures;
  /** Agents have no queue figures, so their Abandoned card counts their missed calls. */
  isAgent?: boolean;
}

/** Today's headline figures for every call, in and out: the row above the direction cards. */
export function TodayKpis({ figures: f, isAgent }: TodayKpisProps) {
  const { t } = useTranslation();
  const tips = rateTips(t);
  const q = f.queue;
  const missed = f.all.calls - f.all.answered;

  const cards: StatCardProps[] = [
    {
      icon: <PhoneCall size={16} />,
      label: t('dashboard.kpi.totalCalls', 'Total calls'),
      value: f.all.calls.toLocaleString(),
      tip: kpiTip(t, 'dashboard.tip.totalCalls', t('dashboard.kpi.totalCalls', 'Total calls'), undefined,
        { text: 'Every call today — inbound, outbound and between extensions, echo tests and feature codes included.' }),
      desc: t('dashboard.kpi.totalSplitInternal', '{{in}} in · {{out}} out · {{internal}} internal',
        { in: f.inbound.calls.toLocaleString(), out: f.outbound.calls.toLocaleString(), internal: f.internal.toLocaleString() }),
    },
    {
      icon: <CheckCircle2 size={16} />,
      label: t('dashboard.kpi.answered', 'Answered'),
      value: f.all.answered.toLocaleString(),
      tip: kpiTip(t, 'dashboard.tip.answered', t('dashboard.kpi.answered', 'Answered'), undefined,
        { text: 'Calls that actually connected and had talk time.' }),
      desc: t('dashboard.kpi.contactRateOf', 'Contact rate {{rate}}', { rate: fmtPct(f.all.contactRate) }),
    },
    {
      icon: <UserCheck size={16} />,
      label: t('dashboard.kpi.answerRate', 'Answer rate'),
      value: fmtPct(f.all.answerRate),
      tip: tips.answerRate,
      desc: t('dashboard.kpi.peopleReached', '{{reached}} of {{people}} numbers reached',
        { reached: f.all.reached, people: f.all.people }),
      tone: VERDICT_TONE[perPersonRateVerdict(f.all.answerRate)],
    },
    isAgent || !q ? {
      icon: <PhoneMissed size={16} />,
      label: t('dashboard.kpi.missed', 'Missed'),
      value: missed.toLocaleString(),
      tip: kpiTip(t, 'dashboard.tip.missed', t('dashboard.kpi.missed', 'Missed'), undefined,
        { text: 'Your calls today that did not connect.', formula: 'calls − answered' }),
      tone: missed > 0 ? 'danger' : '',
    } : {
      icon: <PhoneMissed size={16} />,
      label: t('dashboard.kpi.abandoned', 'Abandoned'),
      value: q.abandoned.toLocaleString(),
      tip: kpiTip(t, 'dashboard.tip.abandoned', t('dashboard.kpi.abandoned', 'Abandoned'), undefined,
        { text: 'Inbound callers who hung up before anyone answered.', formula: 'inbound calls not answered' }),
      desc: t('dashboard.kpi.abandonRateOf', 'Abandon rate {{rate}}', { rate: fmtPct(q.abandonRate) }),
      tone: VERDICT_TONE[abandonVerdict(q.abandonRate)],
    },
    {
      icon: <Timer size={16} />,
      label: t('dashboard.kpi.aht', 'AHT'),
      value: fmtSecs(f.all.ahtSecs),
      tip: kpiTip(t, 'dashboard.tip.aht', t('dashboard.kpi.aht', 'AHT'), undefined,
        { text: 'Average talk time of an answered call.', formula: 'talk time ÷ answered' }),
    },
  ];

  return <StatRow>{cards.map((c) => <StatCard key={c.label} {...c} />)}</StatRow>;
}

interface DirectionCardsProps {
  /** The period's figures; null while they load or when they are out of reach. */
  figures: PeriodFigures | null;
  /** What the period is called on the card, e.g. "Today so far". */
  periodLabel: string;
}

/** Inbound and outbound, one figure card each (all calls are the TodayKpis row above). */
export function DirectionCards({ figures: f, periodLabel }: DirectionCardsProps) {
  const { t } = useTranslation();
  const tips = rateTips(t);

  const answeredTip = (label: string): Tip => ({
    content: t('dashboard.tip.answered.text', 'Calls that actually connected and had talk time.'), label,
  });
  const answered = (d: DirectionFigures): Metric => {
    const label = t('dashboard.kpi.answered', 'Answered');
    return { key: 'answered', label, value: d.answered.toLocaleString(), tip: answeredTip(label) };
  };
  const answerRate = (d: DirectionFigures): Metric => ({
    key: 'answerRate', label: t('dashboard.kpi.answerRate', 'Answer rate'), value: fmtPct(d.answerRate),
    tone: VERDICT_TONE[perPersonRateVerdict(d.answerRate)], tip: tips.answerRate,
  });
  const contactRate = (d: DirectionFigures): Metric => ({
    key: 'contactRate', label: t('dashboard.kpi.contactRate', 'Contact rate'), value: fmtPct(d.contactRate),
    tone: VERDICT_TONE[perCallRateVerdict(d.contactRate)], tip: tips.contactRate,
  });
  const aht = (d: DirectionFigures): Metric => ({
    key: 'aht', label: t('dashboard.kpi.aht', 'AHT'), value: fmtSecs(d.ahtSecs),
  });

  const q = f?.queue ?? null;
  const inboundMetrics: Metric[] = f ? [
    answered(f.inbound),
    answerRate(f.inbound),
    contactRate(f.inbound),
    ...(q ? [
      { key: 'sla', label: t('dashboard.kpi.sla', 'SLA'), value: fmtPct(q.slaPct), tone: VERDICT_TONE[slaVerdict(q.slaPct)] },
      {
        key: 'abandoned', label: t('dashboard.kpi.abandoned', 'Abandoned'), value: q.abandoned.toLocaleString(),
        tone: (q.abandoned > 0 ? 'danger' : '') as Tone,
      },
      {
        key: 'abandonRate', label: t('dashboard.kpi.abandonRate', 'Abandon rate'), value: fmtPct(q.abandonRate),
        tone: VERDICT_TONE[abandonVerdict(q.abandonRate)],
      },
      { key: 'fcr', label: t('dashboard.kpi.fcr', 'FCR'), value: fmtPct(q.fcrPct), tone: VERDICT_TONE[fcrVerdict(q.fcrPct)] },
      { key: 'avgWait', label: t('dashboard.kpi.avgWait', 'Avg wait'), value: fmtSecs(q.avgWaitSecs) },
    ] : []),
    aht(f.inbound),
  ] : [];
  const talkLabel = t('dashboard.kpi.talkTime', 'Talk time');
  const outboundMetrics: Metric[] = f ? [
    answered(f.outbound),
    answerRate(f.outbound),
    contactRate(f.outbound),
    aht(f.outbound),
    ...(f.outbound.talkSecs !== null ? [{
      key: 'talk', label: talkLabel, value: fmtSecs(f.outbound.talkSecs),
      tip: {
        content: t('dashboard.tip.talkTime.text', 'Total time outbound calls spent with a customer on the line, wrap-up excluded.'),
        formula: t('dashboard.tip.talkTime.formula', 'sum of talk time'),
        label: talkLabel,
      },
    }] : []),
  ] : [];

  return (
    <div className="dcards">
      <FigureCard
        icon={<PhoneIncoming size={18} />} title={t('dashboard.direction.inbound', 'Inbound')}
        periodLabel={periodLabel}
        period={f ? f.inbound.calls : null}
        metrics={inboundMetrics}
      />
      <FigureCard
        icon={<PhoneOutgoing size={18} />} title={t('dashboard.direction.outbound', 'Outbound')}
        periodLabel={periodLabel}
        period={f ? f.outbound.calls : null}
        metrics={outboundMetrics}
      />
    </div>
  );
}
