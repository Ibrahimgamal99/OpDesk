import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { QueueKPIRow, HeatmapData } from '../types';
import { fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch } from './analyticsUtils';

function slaClass(v: number | null): string {
  if (v === null) return 'neutral';
  if (v >= 80) return 'sla-met';
  return 'sla-fail';
}

type SortKey = keyof QueueKPIRow;
type SortDir = 'asc' | 'desc';

function sortRows(rows: QueueKPIRow[], key: SortKey, dir: SortDir): QueueKPIRow[] {
  return [...rows].sort((a, b) => {
    const va = a[key] ?? -Infinity;
    const vb = b[key] ?? -Infinity;
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

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
              const tip = `${day} ${labels.hours[hr]}: ${count} calls (${abandoned} abandoned)`;
              return (
                <div
                  key={`cell-${dayIdx}-${hr}`}
                  className="an-heatmap-cell"
                  data-tip={tip}
                  style={{
                    background: count === 0
                      ? 'rgba(88,166,255,0.04)'
                      : `rgba(88,166,255,${(0.08 + intensity * 0.72).toFixed(2)})`
                  }}
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

interface Props { dateRange: DateRange }

export function AnalyticsQueues({ dateRange }: Props) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('total_calls');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
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
  const queues = data?.queues ?? [];
  const heatmap = data?.heatmap ?? null;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />;
  }

  if (loading) {
    return <div className="an-loading"><div className="an-spinner" />{t('analytics.loading')}</div>;
  }
  if (error) {
    return <div className="an-empty">{t('analytics.error')}</div>;
  }

  const sorted = sortRows(queues, sortKey, sortDir);
  const columns: { key: SortKey; label: string }[] = [
    { key: 'queue_name',     label: t('analytics.queues.queue') },
    { key: 'total_calls',    label: t('analytics.queues.total') },
    { key: 'answered_calls', label: t('analytics.queues.answered') },
    { key: 'abandoned_calls',label: t('analytics.queues.abandoned') },
    { key: 'sla_pct',        label: t('analytics.queues.sla') },
    { key: 'aht_secs',       label: t('analytics.queues.aht') },
    { key: 'avg_wait_secs',  label: t('analytics.queues.avgWait') },
    { key: 'peak_hour',      label: t('analytics.queues.peakHour') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="an-section">
        <div className="an-section-header">
          <div className="an-section-title">{t('analytics.queues.title')}</div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {queues.length} {t('analytics.queues.queues', 'queues')}
          </span>
        </div>
        {queues.length === 0 ? (
          <div className="an-empty">{t('analytics.empty', 'No data for this period')}</div>
        ) : (
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  {columns.map(({ key, label }) => (
                    <th
                      key={key}
                      className={[
                        sortKey === key ? 'sorted' : '',
                        key === 'queue_name' ? 'sticky' : '',
                        key !== 'queue_name' ? 'num' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => toggleSort(key)}
                    >
                      {label} <SortIcon col={key} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map(q => {
                  const answerRate = q.total_calls > 0
                    ? (q.answered_calls / q.total_calls) * 100
                    : 0;
                  return (
                    <tr key={q.queue_extension}>
                      <td className="sticky" style={{ fontWeight: 500 }}>
                        <div>{q.queue_name}</div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {q.queue_extension}
                        </div>
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>
                        {q.total_calls.toLocaleString()}
                      </td>
                      <td className="num">
                        <div>{q.answered_calls.toLocaleString()}</div>
                        <div className="an-progress" style={{ width: 48, marginLeft: 'auto' }}>
                          <div
                            className={`an-progress-fill${answerRate >= 80 ? ' good' : answerRate >= 60 ? ' warn' : ' bad'}`}
                            style={{ width: `${answerRate}%` }}
                          />
                        </div>
                      </td>
                      <td className="num">
                        <span style={{ color: q.abandoned_calls > 0 ? 'var(--accent-danger)' : 'inherit' }}>
                          {q.abandoned_calls.toLocaleString()}
                        </span>
                      </td>
                      <td>
                        <div className="an-sla-cell">
                          <span className={`an-badge ${slaClass(q.sla_pct)}`}>
                            {fmtPct(q.sla_pct)}
                          </span>
                          <div className="an-progress">
                            <div
                              className={`an-progress-fill ${slaProgressClass(q.sla_pct)}`}
                              style={{ width: `${q.sla_pct ?? 0}%` }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="num">{fmtSecs(q.aht_secs)}</td>
                      <td className="num">{fmtSecs(q.avg_wait_secs)}</td>
                      <td className="num muted">
                        {q.peak_hour !== null
                          ? `${String(q.peak_hour).padStart(2, '0')}:00`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {heatmap && (
        <div className="an-section">
          <div className="an-section-header">
            <div className="an-section-title">{t('analytics.queues.heatmapTitle')}</div>
          </div>
          <Heatmap data={heatmap} />
        </div>
      )}
    </div>
  );
}
