import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, ClipboardCheck, Download, FileSpreadsheet } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import type { DateRange } from './analyticsUtils';
import type { AgentAdherenceRow } from '../types';
import { fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip } from './analyticsUtils';
import { Alert, Badge, Card, EmptyState, Tooltip } from './ui';

type SortKey = 'agent' | 'logged_in_secs' | 'ready_secs' | 'on_call_secs' | 'wrap_secs' | 'not_ready_secs' | 'occupancy_pct';
type SortDir = 'asc' | 'desc';

function sortRows(rows: AgentAdherenceRow[], key: SortKey, dir: SortDir): AgentAdherenceRow[] {
  return [...rows].sort((a, b) => {
    const va = (a[key] as number | string) ?? -Infinity;
    const vb = (b[key] as number | string) ?? -Infinity;
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

/** ISO timestamp -> local HH:MM, or a dash. */
function fmtClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface Props { dateRange: DateRange }

/**
 * Agent Adherence report. Login, Logout, Logged In, Ready, On Call, Wrap-up,
 * Not Ready and Occupancy per agent for the selected period, sourced from
 * agent_activity presence segments (GET /api/analytics/agent-adherence).
 * Cloned from AnalyticsAgents (sortable .an-table). Occupancy = handling / available.
 */
export function AnalyticsAdherence({ dateRange }: Props) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('logged_in_secs');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const { data, loading, error } = useAnalyticsFetch(
    () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      return analyticsGet<{ agents: AgentAdherenceRow[] }>(`/api/analytics/agent-adherence?${params}`);
    },
    [dateRange],
  );
  const agents = data?.agents ?? [];

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'agent' ? 'asc' : 'desc');
    }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return null;
    return sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />;
  }

  // Export goes through the backend so the CSV/XLSX is scope-filtered and carries
  // a server-side "Generated at" stamp (in the filename and a header line).
  async function downloadExport(format: 'csv' | 'xlsx') {
    setExporting(format);
    setExportError(null);
    try {
      const params = buildDateParams(dateRange.from, dateRange.to);
      params.set('format', format);
      const resp = await fetchWithAuth(`/api/analytics/agent-adherence/export?${params}`);
      if (!resp.ok) throw new Error('Export failed');
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agent_adherence_${dateRange.from}_${dateRange.to}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch {
      setExportError(t('common.exportFailed', 'Export failed. Please try again.'));
    } finally {
      setExporting(null);
    }
  }

  if (loading) {
    return <div className="an-loading"><div className="an-spinner" />{t('analytics.loading')}</div>;
  }
  if (error) {
    return <Alert>{t('analytics.error')}</Alert>;
  }

  const sorted = sortRows(agents, sortKey, sortDir);

  type Tip = { text: string; formula?: string };
  const columns: { key: SortKey; label: string; tipKey?: string; tip?: Tip }[] = [
    { key: 'agent',          label: t('fields.agent') },
    { key: 'logged_in_secs', label: t('agent.adherence.loggedIn'), tipKey: 'analytics.tip.adherence.loggedInTotal',
      tip: { text: 'Total time the agent was active.', formula: 'ready + on call + wrap-up + not ready' } },
    { key: 'ready_secs',     label: t('agent.state.ready'), tipKey: 'analytics.tip.adherence.ready',
      tip: { text: 'Available: signed in and waiting for a call.' } },
    { key: 'on_call_secs',   label: t('agent.state.onCall'), tipKey: 'analytics.tip.adherence.onCall',
      tip: { text: 'On a call.' } },
    { key: 'wrap_secs',      label: t('agent.state.wrapUp'), tipKey: 'analytics.tip.adherence.wrapUp',
      tip: { text: 'Finishing up after a call.' } },
    { key: 'not_ready_secs', label: t('agent.state.notReady'), tipKey: 'analytics.tip.adherence.notReady',
      tip: { text: 'On a break or otherwise paused. Hover the number for the reasons.' } },
    { key: 'occupancy_pct',  label: t('agent.adherence.occupancy'), tipKey: 'analytics.tip.adherence.occupancy',
      tip: { text: 'Of the time they were available, how much was spent working. Over 85% for long is a burnout sign.',
             formula: '(on call + wrap-up) ÷ (on call + wrap-up + ready)' } },
  ];
  const tip = (key: string, label: string, text: string) => kpiTip(t, key, label, undefined, { text });

  return (
    <Card
      icon={ClipboardCheck}
      title={(
        <span className="u-inline-row u-gap-1h">
          {t('agent.adherence.title')}
          <Tooltip {...tip('analytics.tip.adherence.source', t('agent.adherence.title'),
            'Based on the status agents set themselves, not on their phones.')} />
        </span>
      )}
      description={`${t('agent.adherence.subtitle')} · ${agents.length} ${t('analytics.agents.agents', 'agents')}`}
      actions={(
        <>
          <button
            type="button"
            className="btn"
            onClick={() => downloadExport('csv')}
            disabled={exporting !== null || agents.length === 0}
          >
            <Download size={14} />
            {exporting === 'csv' ? t('common.exporting', 'Exporting…') : t('agent.adherence.exportCsv', 'CSV')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => downloadExport('xlsx')}
            disabled={exporting !== null || agents.length === 0}
          >
            <FileSpreadsheet size={14} />
            {exporting === 'xlsx' ? t('common.exporting', 'Exporting…') : t('agent.adherence.exportXlsx', 'Excel')}
          </button>
        </>
      )}
      flush
    >
      {exportError && (
        <div className="u-p-3">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      {agents.length === 0 ? (
        <EmptyState size="sm" icon={ClipboardCheck} title={t('agent.adherence.empty')} />
      ) : (
        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th
                  className={['sticky', sortKey === 'agent' ? 'sorted' : ''].filter(Boolean).join(' ')}
                  onClick={() => toggleSort('agent')}
                >
                  {t('fields.agent')} <SortIcon col="agent" />
                </th>
                <th className="num">
                  {t('agent.adherence.login')}
                  <Tooltip {...tip('analytics.tip.adherence.login', t('agent.adherence.login'), 'When the agent first went active.')} />
                </th>
                <th className="num">
                  {t('agent.adherence.logout')}
                  <Tooltip {...tip('analytics.tip.adherence.logout', t('agent.adherence.logout'), 'When the agent last went inactive.')} />
                </th>
                {columns.slice(1).map(c => (
                  <th
                    key={c.key}
                    className={['num', sortKey === c.key ? 'sorted' : ''].filter(Boolean).join(' ')}
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label} <SortIcon col={c.key} />
                    {c.tipKey && <Tooltip {...kpiTip(t, c.tipKey, c.label, undefined, c.tip)} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(a => (
                <tr key={a.agent}>
                  <td className="sticky">
                    <div className="an-agent-cell">
                      <div className="an-agent-info">
                        <div className="an-agent-name">{a.name || a.agent}</div>
                        <div className="an-agent-ext">{a.agent}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num">{fmtClock(a.login)}</td>
                  <td className="num">
                    {a.logged_in
                      ? <Badge tone="success">{t('agent.adherence.stillIn')}</Badge>
                      : fmtClock(a.logout)}
                  </td>
                  <td className="num u-semibold">{fmtSecs(a.logged_in_secs)}</td>
                  <td className="num an-fg-ready">{fmtSecs(a.ready_secs)}</td>
                  <td className="num an-fg-on-call">{fmtSecs(a.on_call_secs)}</td>
                  <td className="num an-fg-wrap">{fmtSecs(a.wrap_secs)}</td>
                  <td className="num" title={a.not_ready_breakdown.map(b => `${b.label}: ${fmtSecs(b.secs)}`).join('\n')}>
                    {fmtSecs(a.not_ready_secs)}
                  </td>
                  <td>
                    <div className="an-sla-cell">
                      <Badge tone={a.occupancy_pct >= 70 ? 'success' : a.occupancy_pct >= 40 ? 'neutral' : 'danger'}>
                        {fmtPct(a.occupancy_pct)}
                      </Badge>
                      <div className="an-progress">
                        <div
                          className={`an-progress-fill u-fill-x ${slaProgressClass(a.occupancy_pct)}`}
                          style={{ '--u-fill': `${Math.min(100, a.occupancy_pct)}%` } as React.CSSProperties}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
