import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, Download, FileSpreadsheet } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import type { DateRange } from './analyticsUtils';
import type { AgentAdherenceRow } from '../types';
import { fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch } from './analyticsUtils';

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
      setExportError(t('agent.adherence.exportFailed', 'Export failed. Please try again.'));
    } finally {
      setExporting(null);
    }
  }

  if (loading) {
    return <div className="an-loading"><div className="an-spinner" />{t('analytics.loading')}</div>;
  }
  if (error) {
    return <div className="an-empty">{t('analytics.error')}</div>;
  }

  const sorted = sortRows(agents, sortKey, sortDir);

  const columns: { key: SortKey; label: string; num?: boolean }[] = [
    { key: 'agent',          label: t('agent.adherence.agent') },
    { key: 'logged_in_secs', label: t('agent.adherence.loggedIn'), num: true },
    { key: 'ready_secs',     label: t('agent.adherence.ready'), num: true },
    { key: 'on_call_secs',   label: t('agent.adherence.onCall'), num: true },
    { key: 'wrap_secs',      label: t('agent.adherence.wrapUp'), num: true },
    { key: 'not_ready_secs', label: t('agent.adherence.notReady'), num: true },
    { key: 'occupancy_pct',  label: t('agent.adherence.occupancy'), num: true },
  ];

  return (
    <div className="an-section">
      <div className="an-section-header">
        <div>
          <div className="an-section-title">{t('agent.adherence.title')}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>
            {t('agent.adherence.subtitle')}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {exportError && (
            <span style={{ color: 'var(--accent-danger, #f85149)', fontSize: '0.78rem' }}>
              {exportError}
            </span>
          )}
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {agents.length} {t('analytics.agents.agents', 'agents')}
          </span>
          <button
            className="an-export-btn"
            onClick={() => downloadExport('csv')}
            disabled={exporting !== null || agents.length === 0}
          >
            <Download size={13} />
            {exporting === 'csv' ? t('agent.adherence.exporting', 'Exporting…') : t('agent.adherence.exportCsv', 'CSV')}
          </button>
          <button
            className="an-export-btn"
            onClick={() => downloadExport('xlsx')}
            disabled={exporting !== null || agents.length === 0}
          >
            <FileSpreadsheet size={13} />
            {exporting === 'xlsx' ? t('agent.adherence.exporting', 'Exporting…') : t('agent.adherence.exportXlsx', 'Excel')}
          </button>
        </div>
      </div>
      {agents.length === 0 ? (
        <div className="an-empty">{t('agent.adherence.empty')}</div>
      ) : (
        <div className="an-table-wrap">
          <table className="an-table">
            <thead>
              <tr>
                <th
                  className={['sticky', sortKey === 'agent' ? 'sorted' : ''].filter(Boolean).join(' ')}
                  onClick={() => toggleSort('agent')}
                >
                  {t('agent.adherence.agent')} <SortIcon col="agent" />
                </th>
                <th className="num">{t('agent.adherence.login')}</th>
                <th className="num">{t('agent.adherence.logout')}</th>
                {columns.slice(1).map(c => (
                  <th
                    key={c.key}
                    className={['num', sortKey === c.key ? 'sorted' : ''].filter(Boolean).join(' ')}
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label} <SortIcon col={c.key} />
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
                      ? <span className="an-badge sla-met">{t('agent.adherence.stillIn')}</span>
                      : fmtClock(a.logout)}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmtSecs(a.logged_in_secs)}</td>
                  <td className="num" style={{ color: 'var(--status-idle)' }}>{fmtSecs(a.ready_secs)}</td>
                  <td className="num" style={{ color: 'var(--status-call)' }}>{fmtSecs(a.on_call_secs)}</td>
                  <td className="num" style={{ color: 'var(--status-hold)' }}>{fmtSecs(a.wrap_secs)}</td>
                  <td className="num" title={a.not_ready_breakdown.map(b => `${b.label}: ${fmtSecs(b.secs)}`).join('\n')}>
                    {fmtSecs(a.not_ready_secs)}
                  </td>
                  <td>
                    <div className="an-sla-cell">
                      <span className={`an-badge ${a.occupancy_pct >= 70 ? 'sla-met' : a.occupancy_pct >= 40 ? 'neutral' : 'sla-fail'}`}>
                        {fmtPct(a.occupancy_pct)}
                      </span>
                      <div className="an-progress">
                        <div
                          className={`an-progress-fill ${slaProgressClass(a.occupancy_pct)}`}
                          style={{ width: `${Math.min(100, a.occupancy_pct)}%` }}
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
    </div>
  );
}
