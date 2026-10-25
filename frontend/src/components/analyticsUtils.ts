import { useState, useEffect } from 'react';
import type { DependencyList } from 'react';
import type { TFunction } from 'i18next';
import { fetchWithAuth } from '../auth';

// ---------------------------------------------------------------------------
// Shared date range types + helpers (used by Analytics AND Call History)
// ---------------------------------------------------------------------------

export interface DateRange {
  from: string;
  to: string;
}

export type QuickSelect = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's local date, or the local date `offsetDays` from it (negative = the past). Local
 *  on purpose: toISOString() is UTC, which is yesterday for part of every evening east of
 *  Greenwich -- and the backend reads these dates on the PBX's clock. */
export function todayStr(offsetDays = 0): string {
  const d = new Date();
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return toISO(d);
}

export function quickRanges(): Record<QuickSelect, DateRange> {
  const now = new Date();
  const today = toISO(now);
  const yesterday = toISO(new Date(now.getTime() - 86400000));
  const d7 = toISO(new Date(now.getTime() - 6 * 86400000));
  const d30 = toISO(new Date(now.getTime() - 29 * 86400000));
  const monthStart = toISO(new Date(now.getFullYear(), now.getMonth(), 1));
  return {
    today:     { from: today,     to: today },
    yesterday: { from: yesterday, to: yesterday },
    '7d':      { from: d7,        to: today },
    '30d':     { from: d30,       to: today },
    month:     { from: monthStart, to: today },
    custom:    { from: d30,       to: today },
  };
}

export function matchQuick(range: DateRange): QuickSelect | null {
  const ranges = quickRanges();
  for (const [key, r] of Object.entries(ranges) as [QuickSelect, DateRange][]) {
    if (key !== 'custom' && r.from === range.from && r.to === range.to) return key;
  }
  return null;
}

/**
 * The preset list every ui/RangePicker is given. It lives here rather than in the
 * component because ui/ carries no i18n dependency, and here rather than at each
 * call site because three screens offering three different preset lists is the
 * drift this whole layer exists to stop. `t` is passed in so this module stays
 * free of react-i18next.
 */
export function rangePresets(
  t: (key: string) => string,
): { key: QuickSelect; label: string; from: string; to: string }[] {
  const r = quickRanges();
  const keys: { key: QuickSelect; i18n: string }[] = [
    { key: 'today',     i18n: 'common.today' },
    { key: 'yesterday', i18n: 'common.yesterday' },
    { key: '7d',        i18n: 'analytics.period.last7' },
    { key: '30d',       i18n: 'analytics.period.last30' },
    { key: 'month',     i18n: 'analytics.period.thisMonth' },
  ];
  return keys.map(k => ({ key: k.key, label: t(k.i18n), ...r[k.key] }));
}

/**
 * Seconds -> HH:MM:SS, the one duration format on the analytics screens.
 * Fixed-width and always three parts, so a column of them lines up and a shift
 * total (07:42:10) and a handle time (00:04:12) read the same way. Hours are not
 * wrapped at 24: a range of days totals past it and must say so.
 */
export function fmtSecs(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return '—';
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(1)}%`;
}

/**
 * Tooltip props for one KPI, from a `<ns>.tip.<name>` entry holding `text` and
 * an optional `formula`. Every KPI explanation on Analytics goes through here, so
 * they stay one plain sentence with the arithmetic underneath.
 *
 * The usual signature, plus `fallback`: the English text (and formula) used
 * until the key exists in the translation files.
 */
export function kpiTip(
  t: TFunction, key: string, label: string,
  vars?: Record<string, unknown>, fallback?: { text: string; formula?: string },
): { content: string; formula: string | undefined; label: string } {
  const formula = t(`${key}.formula`, { defaultValue: fallback?.formula ?? '', ...vars });
  return {
    content: t(`${key}.text`, { defaultValue: fallback?.text ?? '', ...vars }),
    formula: formula || undefined,
    label,
  };
}

/** The metrics the Dashboard and Analytics both show. Each has one label
 *  (`metrics.<key>`) and one tooltip (`metrics.tip.<key>`), so a figure is named and
 *  explained in the same words wherever it appears. */
export const METRIC_KEYS = [
  'totalCalls', 'answered', 'answerRate', 'contactRate', 'abandoned', 'abandonRate', 'missed',
  'aht', 'sla', 'fcr', 'avgWait', 'talkTime',
] as const;
export type MetricKey = typeof METRIC_KEYS[number];

export function metricTips(t: TFunction): Record<MetricKey, ReturnType<typeof kpiTip>> {
  return Object.fromEntries(
    METRIC_KEYS.map((k) => [k, kpiTip(t, `metrics.tip.${k}`, t(`metrics.${k}`))]),
  ) as Record<MetricKey, ReturnType<typeof kpiTip>>;
}

/** A rate's verdict: drives the good/warn/bad tone of a KPI card or metric. */
export type RateVerdict = 'good' | 'warn' | 'bad' | '';

/** Distinct people reached over people involved: >=50% healthy, >=25% watchable. A
 *  person tried five times who answers once counts once, so this runs above the
 *  per-call rate. */
export function perPersonRateVerdict(v: number | null | undefined): RateVerdict {
  if (v === null || v === undefined) return '';
  return v >= 50 ? 'good' : v >= 25 ? 'warn' : 'bad';
}

/** Answered per call placed: >=40% healthy, >=20% watchable, below that poor.
 *  Outbound answers far less often than an inbound queue picks up. */
export function perCallRateVerdict(v: number | null | undefined): RateVerdict {
  if (v === null || v === undefined) return '';
  return v >= 40 ? 'good' : v >= 20 ? 'warn' : 'bad';
}

/** Service level: 80% is the industry default target, 60% is where a queue is broken. */
export function slaVerdict(v: number | null | undefined): RateVerdict {
  if (v === null || v === undefined) return '';
  return v >= 80 ? 'good' : v >= 60 ? 'warn' : 'bad';
}

/** Abandonment, where LOWER is better: 5% is the usual benchmark, 15% is a problem. */
export function abandonVerdict(v: number | null | undefined): RateVerdict {
  if (v === null || v === undefined) return '';
  return v <= 5 ? 'good' : v <= 15 ? 'warn' : 'bad';
}

/** First contact resolution: 85% good, 70% watchable. */
export function fcrVerdict(v: number | null | undefined): RateVerdict {
  if (v === null || v === undefined) return '';
  return v >= 85 ? 'good' : v >= 70 ? 'warn' : 'bad';
}

/** A percentage judged against an arbitrary target: at or above it is good, within
 *  70% of it is a warning. */
export function targetVerdict(v: number | null | undefined, target: number): RateVerdict {
  if (v === null || v === undefined) return '';
  return v >= target ? 'good' : v >= target * 0.7 ? 'warn' : 'bad';
}

/** A percentage of a part over a whole, one decimal, or null when the whole is empty. */
export function pctOf(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part === null || part === undefined || !whole) return null;
  return parseFloat(((part / whole) * 100).toFixed(1));
}

/** The range as the cards and charts caption it: one date, or "from → to". */
export function rangeLabel(r: DateRange): string {
  return r.from === r.to ? r.from : `${r.from} → ${r.to}`;
}

/** A wait bucket's name, from its edges in seconds: "0–10s", "1–2m", "5m+". */
export function waitBucketLabel(from: number, to: number | null): string {
  const f = (s: number) => (s < 60 ? `${s}s` : `${s / 60}m`);
  if (to === null) return `${f(from)}+`;
  const unit = to <= 60 ? 's' : 'm';
  const n = (s: number) => (unit === 's' ? s : s / 60);
  return `${n(from)}–${n(to)}${unit}`;
}

/**
 * Rows for a "compare" bar chart, best first. `lowerIsBetter` flips the order for a figure
 * where less is the good direction (abandon rate, wait), so the top bar is always the one to
 * copy, whatever the figure. Rows without a value are left out.
 */
export function rankBest<T extends { value: number | null }>(rows: T[], lowerIsBetter = false): (T & { value: number })[] {
  return rows
    .filter((r): r is T & { value: number } => r.value !== null)
    .sort((a, b) => (lowerIsBetter ? a.value - b.value : b.value - a.value));
}

export function slaProgressClass(v: number | null): string {
  if (v === null) return '';
  if (v >= 80) return 'good';
  if (v >= 60) return 'warn';
  return 'bad';
}

export function buildDateParams(from: string, to: string): URLSearchParams {
  return new URLSearchParams({ date_from: from, date_to: to });
}

export async function analyticsGet<T>(url: string): Promise<T> {
  const r = await fetchWithAuth(url);
  if (!r.ok) throw new Error(`Request failed: ${r.status}`);
  return r.json();
}

export function useAnalyticsFetch<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then(d => { if (!cancelled) setData(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error };
}
