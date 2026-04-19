import { useState, useEffect } from 'react';
import type { DependencyList } from 'react';
import { getAuthHeaders } from '../auth';

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

export function todayStr(): string {
  return toISO(new Date());
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

export function fmtSecs(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return '—';
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(1)}%`;
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
  const r = await fetch(url, { headers: getAuthHeaders() });
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
