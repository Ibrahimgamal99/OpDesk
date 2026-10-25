import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download, FileSpreadsheet, X, ArrowUpDown, Activity, PhoneCall, PhoneIncoming, PhoneOutgoing, ArrowLeftRight, Layers, User,
} from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { AnalyticsDrilldownFacets, AnalyticsDrilldownRecord } from '../types';
import { fmtSecs, analyticsGet, useAnalyticsFetch, kpiTip } from './analyticsUtils';
import { Alert, Badge, Card, Dropdown, EmptyState, Pagination, Toolbar, Tooltip, type DropdownOption } from './ui';
import { CALL_STATUS_ORDER, callStatusColor, callStatusLabel } from './callStatus';
import { CallStatusBadge } from './CallStatusBadge';
import { presentOptions } from '../lib/filters';
import { downloadWithAuth } from '../lib/download';

type DrilldownResponse = { calls: AnalyticsDrilldownRecord[]; total: number; facets?: AnalyticsDrilldownFacets };

const PAGE_SIZE = 50;
/** The most rows the server writes into one export (DRILLDOWN_EXPORT_CAP). */
const EXPORT_CAP = 100000;

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

/** A call's direction as the same info pill Call History uses. */
function DirectionBadge({ direction }: { direction?: string }) {
  const { t } = useTranslation();
  if (direction === 'IN') return <Badge tone="info" icon={<PhoneIncoming size={14} />}>{t('callLog.typeShort.IN', 'IN')}</Badge>;
  if (direction === 'OUT') return <Badge tone="info" icon={<PhoneOutgoing size={14} />}>{t('callLog.typeShort.OUT', 'OUT')}</Badge>;
  if (direction === 'INTERNAL') return <Badge tone="info" icon={<ArrowLeftRight size={14} />}>{t('callLog.typeShort.INT', 'INT')}</Badge>;
  return direction ? <Badge tone="info">{direction}</Badge> : <>—</>;
}

interface Props { dateRange: DateRange }

export function AnalyticsDrilldown({ dateRange }: Props) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

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
      facets: '1',
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

  // Each filter offers only the values that occur under the other filters, with their
  // counts, and keeps the picked one. Without facets (a failed load) both fall back to
  // every choice. The status values are the ten call statuses (callStatus.ts), the same
  // words Call History shows; the server filters on the call's status, not the raw CDR
  // disposition.
  const facets = error ? undefined : data?.facets;
  const allDirections: DropdownOption[] = [
    { value: 'IN',       label: t('direction.inbound', 'Inbound'),   dot: 'green'   },
    { value: 'OUT',      label: t('direction.outbound', 'Outbound'), dot: 'blue'    },
    { value: 'INTERNAL', label: t('direction.internal', 'Internal'), dot: 'neutral' },
  ];
  const directionOptions = facets?.direction ? presentOptions(allDirections, facets.direction, direction) : allDirections;
  const allStatuses: DropdownOption[] = [...new Set([...CALL_STATUS_ORDER, ...Object.keys(facets?.status ?? {})])]
    .map(s => ({ value: s, label: callStatusLabel(t, s), dotColor: callStatusColor(s) }));
  const statusOptions = facets?.status ? presentOptions(allStatuses, facets.status, disposition) : allStatuses;
  // Queue and agent are exact matches, picked from the values the period holds (in scope,
  // under the other filters), so "80" can never mean every queue that contains it.
  const valueOptions = (counts: Record<string, number> | undefined, selected: string): DropdownOption[] => {
    const values = [...new Set([...Object.keys(counts ?? {}), ...(selected ? [selected] : [])])]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return values.map(v => ({ value: v, label: v, count: counts?.[v] ?? 0 }));
  };
  const queueOptions = valueOptions(facets?.queue, queue);
  const agentOptions = valueOptions(facets?.agent, agent);

  // Both CSV and XLSX go through the backend export endpoint so the export covers
  // ALL filtered records, not just the current page that the table is showing.
  async function downloadExport(format: 'csv' | 'xlsx') {
    setExporting(format);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        format,
        date_from: dateRange.from,
        date_to: dateRange.to,
      });
      if (queue)       params.set('queue', queue);
      if (agent)       params.set('agent', agent);
      if (direction)   params.set('direction', direction);
      if (disposition) params.set('disposition', disposition);
      await downloadWithAuth(`/api/analytics/export?${params}`, `analytics_${dateRange.from}_${dateRange.to}.${format}`);
    } catch {
      setExportError(t('common.exportFailed', 'Export failed. Please try again.'));
    } finally {
      setExporting(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const tip = (key: string, label: string, text: string, formula?: string) =>
    <Tooltip {...kpiTip(t, key, label, undefined, { text, formula })} />;

  return (
    <div className="u-col u-gap-4">
      {/* The Page's toolbar band is shared by every tab, so this tab's filters sit at the
          top of its body in the same Toolbar. */}
      <Toolbar
        filters={
          <>
            <div data-active={queue || undefined}>
              <Dropdown
                value={queue}
                onChange={setQueue}
                icon={Layers}
                size="md"
                minWidth={140}
                ariaLabel={t('fields.queue', 'Queue')}
                options={[{ value: '', label: t('analytics.drilldown.allQueues', 'All queues') }, ...queueOptions]}
              />
            </div>
            <div data-active={agent || undefined}>
              <Dropdown
                value={agent}
                onChange={setAgent}
                icon={User}
                size="md"
                minWidth={140}
                ariaLabel={t('fields.agent', 'Agent')}
                options={[{ value: '', label: t('analytics.drilldown.allAgents', 'All agents') }, ...agentOptions]}
              />
            </div>
            <div data-active={direction || undefined}>
              <Dropdown
                value={direction}
                onChange={setDirection}
                icon={ArrowUpDown}
                size="md"
                minWidth={140}
                ariaLabel={t('fields.direction', 'Direction')}
                options={[{ value: '', label: t('direction.all', 'All Directions') }, ...directionOptions]}
              />
            </div>
            <div data-active={disposition || undefined}>
              <Dropdown
                value={disposition}
                onChange={setDisposition}
                icon={Activity}
                size="md"
                minWidth={156}
                ariaLabel={t('common.status', 'Status')}
                options={[{ value: '', label: t('common.allStatuses') }, ...statusOptions]}
              />
            </div>
            {hasFilters && (
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                <X size={14} />
                {t('common.clear', 'Clear')}
              </button>
            )}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => downloadExport('csv')}
              disabled={exporting !== null || total === 0}
            >
              <Download size={14} />
              {exporting === 'csv' ? t('common.exporting') : t('analytics.drilldown.exportCsv')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => downloadExport('xlsx')}
              disabled={exporting !== null || total === 0}
            >
              <FileSpreadsheet size={14} />
              {exporting === 'xlsx' ? t('common.exporting') : t('analytics.drilldown.exportXlsx')}
            </button>
          </>
        }
      />

      {exportError && <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>}
      {total > EXPORT_CAP && (
        <Alert tone="info">
          {t('analytics.drilldown.exportCapped', {
            cap: EXPORT_CAP.toLocaleString(), total: total.toLocaleString(),
            defaultValue: 'An export holds the first {{cap}} of these {{total}} calls. Narrow the range or the filters to export the rest.',
          })}
        </Alert>
      )}

      <Card
        icon={PhoneCall}
        title={t('analytics.drilldown.title')}
        description={`${loading ? '…' : total.toLocaleString()} ${t('analytics.drilldown.records', 'records')}`}
        footer={<Pagination page={page} totalPages={totalPages} onPage={setPage} />}
        flush
      >
        {loading ? (
          <div className="an-loading"><div className="an-spinner" />{t('analytics.loading')}</div>
        ) : error ? (
          <Alert>{t('analytics.error')}</Alert>
        ) : calls.length === 0 ? (
          <EmptyState size="sm" icon={PhoneCall} title={t('analytics.empty', 'No calls for this period')} />
        ) : (
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  <th className="sticky">{t('analytics.drilldown.date', 'Date')}</th>
                  <th>{t('fields.direction', 'Direction')}</th>
                  <th>{t('analytics.drilldown.src', 'Caller')}</th>
                  <th>{t('analytics.drilldown.dst', 'Destination')}</th>
                  <th>{t('fields.queue', 'Queue')}</th>
                  <th>{t('fields.agent', 'Agent')}</th>
                  <th>
                    {t('fields.duration', 'Duration')}
                    {tip('analytics.tip.drilldown.duration', t('fields.duration', 'Duration'),
                      'How long the whole call lasted, ringing included.')}
                  </th>
                  <th>
                    {t('analytics.drilldown.talk', 'Talk')}
                    {tip('analytics.tip.drilldown.talk', t('analytics.drilldown.talk', 'Talk'),
                      'How long the two people were actually connected.')}
                  </th>
                  <th>
                    {t('analytics.drilldown.waitTime')}
                    {tip('analytics.tip.drilldown.wait', t('analytics.drilldown.waitTime'),
                      'How long the caller waited before someone picked up. Queue calls only.', 'duration − talk')}
                  </th>
                  <th>
                    {t('common.status', 'Status')}
                    {tip('analytics.tip.drilldown.status', t('common.status', 'Status'),
                      'How the call ended, in the same words Call History uses.')}
                  </th>
                  <th>
                    {t('analytics.drilldown.slaMet')}
                    {tip('analytics.tip.drilldown.slaMet', t('analytics.drilldown.slaMet'),
                      'Whether this queue call was picked up in time.')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {calls.map((r, i) => (
                  <tr key={`${r.linkedid}-${i}`}>
                    <td className="sticky muted u-nowrap u-text-sm">
                      {fmtDate(r.calldate)}
                    </td>
                    <td>
                      <DirectionBadge direction={r.direction} />
                    </td>
                    <td className="an-tnum">{r.src}</td>
                    <td className="an-tnum">{r.dst}</td>
                    <td>{r.queue_extension || '—'}</td>
                    <td className={r.agent_extension ? undefined : 'muted'}>
                      {r.agent_extension || '—'}
                    </td>
                    <td className="num">{fmtSecs(r.duration)}</td>
                    <td className="num">{fmtSecs(r.talk)}</td>
                    <td className="num">{fmtSecs(r.wait_secs)}</td>
                    <td>
                      <CallStatusBadge status={r.status || r.disposition} />
                    </td>
                    <td>
                      {/* The SLA applies to an answered queue call and nothing else. */}
                      {r.queue_extension && r.status === 'ANSWERED' ? (
                        <Badge tone={r.sla_met ? 'success' : 'danger'}>
                          {r.sla_met ? t('analytics.drilldown.slaMet') : t('analytics.drilldown.slaFailed')}
                        </Badge>
                      ) : (
                        <Badge>—</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
