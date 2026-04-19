import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileSpreadsheet, Search, X, ArrowUpDown, Activity } from 'lucide-react';
import { getAuthHeaders } from '../auth';
import type { DateRange } from './analyticsUtils';
import type { AnalyticsDrilldownRecord } from '../types';
import { fmtSecs, analyticsGet, useAnalyticsFetch } from './analyticsUtils';
import { FilterSelect } from './FilterSelect';

type DrilldownResponse = { calls: AnalyticsDrilldownRecord[]; total: number };

const PAGE_SIZE = 50;

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

interface Props { dateRange: DateRange }

export function AnalyticsDrilldown({ dateRange }: Props) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  // Filters
  const [queue, setQueue] = useState('');
  const [agent, setAgent] = useState('');
  const [direction, setDirection] = useState('');
  const [disposition, setDisposition] = useState('');

  const hasFilters = !!(queue || agent || direction || disposition);

  function clearFilters() {
    setQueue('');
    setAgent('');
    setDirection('');
    setDisposition('');
  }

  const buildParams = useCallback((p: number) => {
    const params = new URLSearchParams({
      date_from: dateRange.from,
      date_to: dateRange.to,
      page: String(p),
      page_size: String(PAGE_SIZE),
    });
    if (queue)       params.set('queue', queue);
    if (agent)       params.set('agent', agent);
    if (direction)   params.set('direction', direction);
    if (disposition) params.set('disposition', disposition);
    return params;
  }, [dateRange, queue, agent, direction, disposition]);

  useEffect(() => {
    setPage(1);
  }, [dateRange, queue, agent, direction, disposition]);

  const { data, loading, error } = useAnalyticsFetch(
    () => analyticsGet<DrilldownResponse>(`/api/analytics/drilldown?${buildParams(page)}`),
    [page, buildParams],
  );
  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;

  function exportCsv() {
    if (!calls.length) return;
    const headers = ['Date', 'Src', 'Queue', 'Agent', 'Duration(s)', 'Talk(s)', 'Wait(s)', 'Disposition', 'SLA Met'];
    const rows = calls.map(r => [
      r.calldate || '',
      r.src,
      r.queue_extension,
      r.agent_extension,
      r.duration,
      r.talk,
      r.wait_secs,
      r.disposition,
      r.sla_met ? 'Yes' : 'No',
    ]);
    const bom = '\uFEFF';
    const csv = bom + [headers, ...rows].map(row =>
      row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics_${dateRange.from}_${dateRange.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportXlsx() {
    setExporting(true);
    try {
      const params = new URLSearchParams({
        format: 'xlsx',
        date_from: dateRange.from,
        date_to: dateRange.to,
      });
      if (queue)       params.set('queue', queue);
      if (agent)       params.set('agent', agent);
      if (direction)   params.set('direction', direction);
      if (disposition) params.set('disposition', disposition);
      const resp = await fetch(`/api/analytics/export?${params}`, { headers: getAuthHeaders() });
      if (!resp.ok) throw new Error('Export failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `analytics_${dateRange.from}_${dateRange.to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Export failed. Try CSV instead.');
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Filter bar */}
      <div className="an-filters">
        {/* Queue filter */}
        <div className="an-filter-group">
          <Search size={13} className="an-filter-icon" />
          <input
            className="an-filter-input"
            placeholder={t('analytics.drilldown.filterQueue')}
            value={queue}
            onChange={e => setQueue(e.target.value)}
            style={{ width: 130 }}
          />
        </div>

        {/* Agent filter */}
        <div className="an-filter-group">
          <Search size={13} className="an-filter-icon" />
          <input
            className="an-filter-input"
            placeholder={t('analytics.drilldown.filterAgent')}
            value={agent}
            onChange={e => setAgent(e.target.value)}
            style={{ width: 120 }}
          />
        </div>

        {/* Direction */}
        <FilterSelect
          value={direction}
          onChange={setDirection}
          icon={ArrowUpDown}
          minWidth={140}
          options={[
            { value: '', label: t('analytics.drilldown.allDirections', 'All Directions') },
            { value: 'IN',       label: t('analytics.drilldown.dirIn',       'Inbound'),  dot: 'green'   },
            { value: 'OUT',      label: t('analytics.drilldown.dirOut',      'Outbound'), dot: 'blue'    },
            { value: 'INTERNAL', label: t('analytics.drilldown.dirInternal', 'Internal'), dot: 'neutral' },
          ]}
        />

        {/* Disposition */}
        <FilterSelect
          value={disposition}
          onChange={setDisposition}
          icon={Activity}
          minWidth={156}
          options={[
            { value: '',          label: t('analytics.drilldown.allDispositions', 'All Statuses') },
            { value: 'ANSWERED',  label: t('analytics.drilldown.answered',  'Answered'),  dot: 'green'  },
            { value: 'NO ANSWER', label: t('analytics.drilldown.noAnswer',  'No Answer'), dot: 'orange' },
            { value: 'BUSY',      label: t('analytics.drilldown.busy',      'Busy'),      dot: 'orange' },
            { value: 'FAILED',    label: t('analytics.drilldown.failed',    'Failed'),    dot: 'red'    },
          ]}
        />

        {/* Clear filters */}
        {hasFilters && (
          <button className="an-filter-clear" onClick={clearFilters}>
            <X size={12} />
            {t('analytics.drilldown.clearFilters', 'Clear')}
          </button>
        )}

        {/* Record count */}
        <span className="an-filter-count">
          {loading ? '…' : total.toLocaleString()} {t('analytics.drilldown.records', 'records')}
        </span>
      </div>

      {/* Table */}
      <div className="an-section" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="an-loading"><div className="an-spinner" />{t('analytics.loading')}</div>
        ) : error ? (
          <div className="an-empty">{t('analytics.error')}</div>
        ) : calls.length === 0 ? (
          <div className="an-empty">{t('analytics.empty', 'No calls for this period')}</div>
        ) : (
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th className="sticky">{t('analytics.drilldown.date', 'Date')}</th>
                  <th>{t('analytics.drilldown.direction', 'Direction')}</th>
                  <th>{t('analytics.drilldown.src', 'Caller')}</th>
                  <th>{t('analytics.drilldown.dst', 'Destination')}</th>
                  <th>{t('analytics.drilldown.queue', 'Queue')}</th>
                  <th>{t('analytics.drilldown.agent', 'Agent')}</th>
                  <th>{t('analytics.drilldown.duration', 'Duration')}</th>
                  <th>{t('analytics.drilldown.talk', 'Talk')}</th>
                  <th>{t('analytics.drilldown.waitTime')}</th>
                  <th>{t('analytics.drilldown.disposition', 'Disposition')}</th>
                  <th>{t('analytics.drilldown.slaMet')}</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((r, i) => (
                  <tr key={`${r.linkedid}-${i}`}>
                    <td className="sticky muted" style={{ whiteSpace: 'nowrap', fontSize: '0.77rem' }}>
                      {fmtDate(r.calldate)}
                    </td>
                    <td>
                      <span className={`cl-direction cl-direction-${(r.direction || '').toLowerCase()}`}>
                        {r.direction === 'IN' ? '📥 IN' :
                         r.direction === 'OUT' ? '📤 OUT' :
                         r.direction === 'INTERNAL' ? '🔄 INT' :
                         r.direction || '—'}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.src}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.dst}</td>
                    <td>{r.queue_extension || '—'}</td>
                    <td style={{ color: r.agent_extension ? 'inherit' : 'var(--text-muted)' }}>
                      {r.agent_extension || '—'}
                    </td>
                    <td className="num">{fmtSecs(r.duration)}</td>
                    <td className="num">{fmtSecs(r.talk)}</td>
                    <td className="num">{fmtSecs(r.wait_secs)}</td>
                    <td>
                      <span className={`an-badge ${r.disposition === 'ANSWERED' ? 'sla-met' : 'sla-fail'}`}>
                        {r.disposition}
                      </span>
                    </td>
                    <td>
                      {r.disposition === 'ANSWERED' ? (
                        <span className={`an-badge ${r.sla_met ? 'sla-met' : 'sla-fail'}`}>
                          {r.sla_met ? t('analytics.drilldown.slaMet') : t('analytics.drilldown.slaFailed')}
                        </span>
                      ) : (
                        <span className="an-badge neutral">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination + Export */}
      <div className="an-drilldown-footer">
        <div className="an-pagination">
          <button
            className="an-page-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="an-page-info">
            {t('analytics.drilldown.page', 'Page')} {page} / {totalPages}
          </span>
          <button
            className="an-page-btn"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            aria-label="Next page"
          >
            ›
          </button>
        </div>

        <div className="an-export-bar">
          <button className="an-export-btn" onClick={exportCsv} disabled={calls.length === 0}>
            <Download size={13} />
            {t('analytics.drilldown.exportCsv')}
          </button>
          <button className="an-export-btn" onClick={exportXlsx} disabled={exporting || calls.length === 0}>
            <FileSpreadsheet size={13} />
            {exporting ? t('analytics.drilldown.exporting') : t('analytics.drilldown.exportXlsx')}
          </button>
        </div>
      </div>
    </div>
  );
}
