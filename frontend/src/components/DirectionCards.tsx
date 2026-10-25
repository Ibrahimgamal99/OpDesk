import type React from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, Minus, PhoneCall, PhoneIncoming, PhoneOutgoing, Radio, TrendingDown, TrendingUp } from 'lucide-react';
import type { CallLogRecord, ExecutiveKPIResponse } from '../types';
import { Tooltip } from './ui';
import { fmtPct, fmtSecs } from './analyticsUtils';
import '../styles/direction-cards.css';

/**
 * Today's traffic as figure cards (modelled on echo's DirectionCards): all calls, inbound
 * and outbound, each with its total and the quality figures OpDesk's backend computes for
 * that direction. Built from /api/analytics/overview for supervisors and admins, and from
 * the agent's own call log for agents.
 */

/** One direction's calls over a period. Optional figures are null when out of reach. */
export interface DirectionFigures {
  calls: number;
  answered: number;
  /** Answered over all calls, as a percentage. */
  answerRate: number | null;
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
  inbound: DirectionFigures;
  outbound: DirectionFigures;
  queue: QueueFigures | null;
}

const rate = (answered: number, total: number) => (total > 0 ? (answered / total) * 100 : null);

/** The overview endpoint's response as the three cards. Total / answered on the All card
 *  are the COMBINED (inbound + outbound) figures, and the answer rate comes from the same
 *  pair so it never contradicts the two numbers beside it. */
export function figuresFromOverview(data: ExecutiveKPIResponse): PeriodFigures {
  const cur = data.current;
  const allTotal = cur.combined?.total_calls ?? cur.total_calls;
  const allAnswered = cur.combined?.answered_calls ?? cur.answered_calls;
  const out = cur.outbound;
  return {
    all: {
      calls: allTotal, answered: allAnswered, answerRate: rate(allAnswered, allTotal),
      ahtSecs: cur.combined?.aht_secs ?? cur.aht_secs, talkSecs: null,
    },
    inbound: {
      calls: cur.total_calls, answered: cur.answered_calls,
      answerRate: rate(cur.answered_calls, cur.total_calls), ahtSecs: cur.aht_secs, talkSecs: null,
    },
    outbound: {
      calls: out?.total_calls ?? 0, answered: out?.answered_calls ?? 0,
      answerRate: out?.answer_rate ?? null, ahtSecs: out?.aht_secs ?? null, talkSecs: out?.sum_billsec ?? null,
    },
    queue: {
      abandoned: cur.abandoned_calls, abandonRate: cur.abandonment_rate, slaPct: cur.sla_pct,
      fcrPct: cur.fcr_pct, avgWaitSecs: cur.avg_wait_secs,
    },
  };
}

function directionFromCalls(calls: CallLogRecord[], withTalk = false): DirectionFigures {
  const answeredRows = calls.filter((c) => (c.disposition || '').toUpperCase() === 'ANSWERED');
  const talk = answeredRows.map((c) => c.talk || 0).filter((x) => x > 0);
  const talkSum = talk.reduce((a, b) => a + b, 0);
  return {
    calls: calls.length,
    answered: answeredRows.length,
    answerRate: rate(answeredRows.length, calls.length),
    ahtSecs: talk.length ? Math.round(talkSum / talk.length) : null,
    talkSecs: withTalk ? talkSum : null,
  };
}

/** An agent's own day from their (extension-scoped) call log. */
export function figuresFromCalls(calls: CallLogRecord[]): PeriodFigures {
  return {
    all: directionFromCalls(calls),
    inbound: directionFromCalls(calls.filter((c) => c.call_type === 'IN')),
    outbound: directionFromCalls(calls.filter((c) => c.call_type === 'OUT'), true),
    queue: null,
  };
}

export type Tone = '' | 'success' | 'warn' | 'danger';

/** Higher-is-better bands: at or above `good` is green, at or above `warn` amber. */
export function bandTone(v: number | null | undefined, good: number, warn: number): Tone {
  if (v === null || v === undefined) return '';
  return v >= good ? 'success' : v >= warn ? 'warn' : 'danger';
}

/** Abandonment, where LOWER is better: 5% healthy, 10% the queue's defining problem. */
function abandonTone(v: number | null | undefined): Tone {
  if (v === null || v === undefined) return '';
  return v <= 5 ? 'success' : v <= 10 ? 'warn' : 'danger';
}

/** Tooltip props: the sentence, its optional formula line, and the icon's name. */
export interface Tip { content: string; formula?: string; label?: string }
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

/** The period total against the previous period of the same length: "+120 vs previous". */
function PeriodDelta({ delta }: { delta: number }) {
  const { t } = useTranslation();
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  return (
    <span className="dcard-delta">
      <Icon size={12} />
      {delta > 0 ? '+' : ''}{delta.toLocaleString()} {t('analytics.delta.vsPrevPeriod', 'vs previous period')}
    </span>
  );
}

/**
 * One card of figures: a title, an optional live count, the period's headline number with
 * its sub-counts, then a grid of quality figures.
 */
export function FigureCard({
  icon, title, tip, live, liveParts = [], periodLabel, period, periodDelta, periodParts = [], metrics, badge,
}: {
  icon: React.ReactNode; title: string; tip?: Tip;
  live?: number; liveParts?: Part[];
  periodLabel: string; period: number | null; periodDelta?: number | null;
  periodParts?: Part[]; metrics: Metric[];
  /** A text flag beside the title. */
  badge?: React.ReactNode;
}) {
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

interface DirectionCardsProps {
  /** The period's figures; null while they load or when they are out of reach. */
  figures: PeriodFigures | null;
  /** What the period is called on the card, e.g. "Today so far". */
  periodLabel: string;
  /** Agents see "Missed" rather than "Abandoned" on the All card (they have no queue figures). */
  isAgent?: boolean;
}

export function DirectionCards({ figures: f, periodLabel, isAgent }: DirectionCardsProps) {
  const { t } = useTranslation();

  const answeredTip = (label: string): Tip => ({
    content: t('dashboard.tip.answered.text', 'Calls that actually connected and had talk time.'), label,
  });
  const answered = (d: DirectionFigures): Metric => {
    const label = t('dashboard.kpi.answered', 'Answered');
    return { key: 'answered', label, value: d.answered.toLocaleString(), tip: answeredTip(label) };
  };
  const answerRate = (d: DirectionFigures): Metric => ({
    key: 'answerRate', label: t('dashboard.kpi.answerRate', 'Answer rate'), value: fmtPct(d.answerRate),
    tone: bandTone(d.answerRate, 80, 50),
  });
  const aht = (d: DirectionFigures): Metric => ({
    key: 'aht', label: t('dashboard.kpi.aht', 'AHT'), value: fmtSecs(d.ahtSecs),
  });

  const q = f?.queue ?? null;
  const allMetrics: Metric[] = f ? [
    answered(f.all),
    answerRate(f.all),
    ...(isAgent ? [{
      key: 'missed', label: t('dashboard.kpi.missed', 'Missed'),
      value: (f.all.calls - f.all.answered).toLocaleString(),
      tone: (f.all.calls - f.all.answered > 0 ? 'danger' : '') as Tone,
    }] : []),
    aht(f.all),
  ] : [];
  const inboundMetrics: Metric[] = f ? [
    answered(f.inbound),
    answerRate(f.inbound),
    ...(q ? [
      { key: 'sla', label: t('dashboard.kpi.sla', 'SLA'), value: fmtPct(q.slaPct), tone: bandTone(q.slaPct, 80, 60) },
      {
        key: 'abandoned', label: t('dashboard.kpi.abandoned', 'Abandoned'), value: q.abandoned.toLocaleString(),
        tone: (q.abandoned > 0 ? 'danger' : '') as Tone,
      },
      {
        key: 'abandonRate', label: t('dashboard.kpi.abandonRate', 'Abandon rate'), value: fmtPct(q.abandonRate),
        tone: abandonTone(q.abandonRate),
      },
      { key: 'fcr', label: t('dashboard.kpi.fcr', 'FCR'), value: fmtPct(q.fcrPct), tone: bandTone(q.fcrPct, 85, 70) },
      { key: 'avgWait', label: t('dashboard.kpi.avgWait', 'Avg wait'), value: fmtSecs(q.avgWaitSecs) },
    ] : []),
    aht(f.inbound),
  ] : [];
  const talkLabel = t('dashboard.kpi.talkTime', 'Talk time');
  const outboundMetrics: Metric[] = f ? [
    answered(f.outbound),
    answerRate(f.outbound),
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
        icon={<PhoneCall size={18} />} title={t('dashboard.direction.all', 'All calls')}
        periodLabel={periodLabel}
        period={f ? f.all.calls : null}
        metrics={allMetrics}
      />
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
