import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, ClipboardCheck, Download, FileSpreadsheet } from 'lucide-react';
import { downloadWithAuth } from '../lib/download';
import { messageOf } from '../lib/api';
import type { DateRange } from './analyticsUtils';
import type { AgentAdherenceRow } from '../types';
import { fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip } from './analyticsUtils';
import { AgentTimelineModal } from './AgentTimelineModal';
import { Alert, Badge, Card, EmptyState, Tooltip } from './ui';

type SortKey = 'agent' | 'sessions' | 'logged_in_secs' | 'ready_secs' | 'on_call_secs'
  | 'wrap_secs' | 'break_secs' | 'not_ready_secs' | 'dnd_secs' | 'occupancy_pct';
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
 * Agent Adherence report. Login, Logout, Sessions, Logged In, Ready, On Call, Wrap-up,
 * Break, Not Ready, DND and Occupancy per agent for the selected period, sourced from
 * agent_activity presence segments (GET /api/analytics/agent-adherence). Sortable .an-table,
 * like Agent Performance.
 *
 * Logged In is the whole signed-in shift (ready + on call + wrap-up + not ready + DND).
 * Occupancy = handling / available: Break and DND sit outside that denominator, since an
 * agent on lunch was never available to be given a call.
 *
 * A row opens that agent's state-change trace (AgentTimelineModal): every move they made,
 * including the DND and the logout/login the summary row can only total.
 */
export function AnalyticsAdherence({ dateRange }: Props) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('logged_in_secs');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [traceFor, setTraceFor] = useState<AgentAdherenceRow | null>(null);
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
      await downloadWithAuth(
        `/api/analytics/agent-adherence/export?${params}`,
        `agent_adherence_${dateRange.from}_${dateRange.to}.${format}`,
      );
    } catch (e) {
      setExportError(messageOf(e, t('common.exportFailed', 'Export failed. Please try again.')));
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
    { key: 'sessions',       label: t('agent.adherence.sessions', 'Sessions'), tipKey: 'agent.adherence.tip.sessions',
      tip: { text: 'How many times the agent logged in. A logout, or the daily shift reset, ends a session.' } },
    { key: 'logged_in_secs', label: t('agent.adherence.loggedIn'), tipKey: 'agent.adherence.tip.loggedInTotal',
      tip: { text: 'Total time the agent was signed in.', formula: 'ready + on call + wrap-up + not ready + DND' } },
    { key: 'ready_secs',     label: t('agent.state.ready'), tipKey: 'agent.adherence.tip.ready',
      tip: { text: 'Available: signed in and waiting for a call.' } },
    { key: 'on_call_secs',   label: t('agent.state.onCall'), tipKey: 'agent.adherence.tip.onCall',
      tip: { text: 'On a call.' } },
    { key: 'wrap_secs',      label: t('agent.state.wrapUp'), tipKey: 'agent.adherence.tip.wrapUp',
      tip: { text: 'Finishing up after a call.' } },
    { key: 'break_secs',     label: t('agent.adherence.break', 'Break'), tipKey: 'agent.adherence.tip.break',
      tip: { text: 'The unpaid part of Not Ready: reasons not marked productive, such as lunch. Hover the number for the reasons.' } },
    { key: 'not_ready_secs', label: t('agent.state.notReady'), tipKey: 'agent.adherence.tip.notReady',
      tip: { text: 'Paused with any reason, productive or not. Hover the number for the reasons.' } },
    { key: 'dnd_secs',       label: t('agent.adherence.dnd', 'DND'), tipKey: 'agent.adherence.tip.dnd',
      tip: { text: 'Signed in but on Do Not Disturb: no queue or direct calls reach the agent.' } },
    { key: 'occupancy_pct',  label: t('agent.adherence.occupancy'), tipKey: 'agent.adherence.tip.occupancy',
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
          <Tooltip {...tip('agent.adherence.tip.source', t('agent.adherence.title'),
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
                  <Tooltip {...tip('agent.adherence.tip.login', t('agent.adherence.login'), 'When the agent first went active.')} />
                </th>
                <th className="num">
                  {t('agent.adherence.logout')}
                  <Tooltip {...tip('agent.adherence.tip.logout', t('agent.adherence.logout'), 'When the agent last logged out. "In" while still signed in.')} />
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
                <tr key={a.agent} className="an-row-clickable" onClick={() => setTraceFor(a)}>
                  <td className="sticky">
                    <div className="an-agent-cell">
                      <div className="an-agent-info">
                        {/* The name is the control, not the row: a role="button" on the <tr>
                            would strip every cell of its column for a screen reader. */}
                        <button
                          type="button"
                          className="an-agent-name an-tl-open"
                          onClick={e => { e.stopPropagation(); setTraceFor(a); }}
                          title={t('agent.timeline.open', 'Show every status change')}
                        >
                          {a.name || a.agent}
                        </button>
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
                  <td className="num">{a.sessions ?? '—'}</td>
                  <td className="num u-semibold">{fmtSecs(a.logged_in_secs)}</td>
                  <td className="num an-fg-ready">{fmtSecs(a.ready_secs)}</td>
                  <td className="num an-fg-on-call">{fmtSecs(a.on_call_secs)}</td>
                  <td className="num an-fg-wrap">{fmtSecs(a.wrap_secs)}</td>
                  <td
                    className="num u-fg-warning"
                    title={a.not_ready_breakdown.filter(b => !b.productive)
                      .map(b => `${b.label}: ${fmtSecs(b.secs)}`).join('\n')}
                  >
                    {fmtSecs(a.break_secs ?? 0)}
                  </td>
                  <td className="num" title={a.not_ready_breakdown.map(b => `${b.label}: ${fmtSecs(b.secs)}`).join('\n')}>
                    {fmtSecs(a.not_ready_secs)}
                  </td>
                  <td className="num u-fg-danger">{fmtSecs(a.dnd_secs ?? 0)}</td>
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
      {traceFor && (
        <AgentTimelineModal
          agent={traceFor.agent}
          name={traceFor.name}
          dateRange={dateRange}
          onClose={() => setTraceFor(null)}
        />
      )}
    </Card>
  );
}
