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

type SortKey = 'agent' | 'sessions' | 'registered_secs' | 'queue_login_secs' | 'available_secs' | 'idle_secs'
  | 'on_call_secs' | 'wrap_secs' | 'break_secs' | 'not_ready_secs' | 'dnd_secs'
  | 'outbound_calls' | 'occupancy_pct';
type SortDir = 'asc' | 'desc';
type TypeFilter = 'all' | 'agents' | 'extensions';

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
 * Agent Adherence report, for queue agents AND plain/outbound extensions: First online,
 * Last offline, Sessions, Registered (online), Logged in (= queue login), Available, Idle
 * (and its DND part), On Call, Wrap-up, Break, Not Ready, DND, Outbound calls/talk and
 * Occupancy for the period
 * (GET /api/analytics/agent-adherence). Sortable .an-table, like Agent Performance.
 *
 * Availability follows the phone's registration, so being online IS being registered;
 * "logged in" means the queues. Occupancy = handling / available: Break sits
 * outside that denominator, since an agent on lunch was never available to be given a call.
 *
 * A row opens that extension's state-change trace (AgentTimelineModal).
 */
export function AnalyticsAdherence({ dateRange }: Props) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('registered_secs');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [traceFor, setTraceFor] = useState<AgentAdherenceRow | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const { data, loading, error } = useAnalyticsFetch(
    () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      return analyticsGet<{ agents: AgentAdherenceRow[] }>(`/api/analytics/agent-adherence?${params}`);
    },
    [dateRange],
  );
  const allRows = data?.agents ?? [];
  const agents = allRows.filter((a) => typeFilter === 'all'
    || (typeFilter === 'agents' ? a.is_agent !== false : a.is_agent === false));

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
      tip: { text: 'How many times the extension became available. The phone going offline, or the daily shift reset, ends a session.' } },
    { key: 'registered_secs', label: t('agent.adherence.registered', 'Registered'), tipKey: 'agent.adherence.tip.registered',
      tip: { text: 'Time online: the phone was registered, or asleep but able to be woken by push.' } },
    { key: 'queue_login_secs', label: t('agent.adherence.loggedInQueue', 'Logged in'), tipKey: 'agent.adherence.tip.loggedInQueue',
      tip: { text: 'Time logged into the queues. Separate from being online; plain extensions have none.' } },
    { key: 'available_secs', label: t('agent.adherence.available', 'Available'), tipKey: 'agent.adherence.tip.available',
      tip: { text: 'Ready to work: idle, on a call, or wrapping up.', formula: 'idle + on call + wrap-up' } },
    { key: 'idle_secs',      label: t('agent.adherence.idle', 'Idle'), tipKey: 'agent.adherence.tip.idle',
      tip: { text: 'Available with no call. Hover the number for the part spent with DND on.' } },
    { key: 'on_call_secs',   label: t('agent.state.onCall'), tipKey: 'agent.adherence.tip.onCall',
      tip: { text: 'On any answered call: inbound, outbound or internal.' } },
    { key: 'wrap_secs',      label: t('agent.state.wrapUp'), tipKey: 'agent.adherence.tip.wrapUp',
      tip: { text: 'Finishing up after a queue call.' } },
    { key: 'break_secs',     label: t('agent.adherence.break', 'Break'), tipKey: 'agent.adherence.tip.break',
      tip: { text: 'The unpaid part of Not Ready: reasons not marked productive, such as lunch. Hover the number for the reasons.' } },
    { key: 'not_ready_secs', label: t('agent.state.notReady'), tipKey: 'agent.adherence.tip.notReady',
      tip: { text: 'On a break with any reason, productive or not. Hover the number for the reasons.' } },
    { key: 'dnd_secs',       label: t('agent.adherence.dnd', 'DND'), tipKey: 'agent.adherence.tip.dnd',
      tip: { text: 'Do Not Disturb was on: inbound calls blocked, out of the queues, any break ended. Counts as Idle while registered. Outbound calls still work.' } },
    { key: 'outbound_calls', label: t('agent.adherence.outbound', 'Outbound'), tipKey: 'agent.adherence.tip.outbound',
      tip: { text: 'Outbound calls placed, with the talk time of the answered ones.' } },
    { key: 'occupancy_pct',  label: t('agent.adherence.occupancy'), tipKey: 'agent.adherence.tip.occupancy',
      tip: { text: 'Of the time they were available, how much was spent working. Over 85% for long is a burnout sign.',
             formula: '(on call + wrap-up) ÷ (on call + wrap-up + idle)' } },
  ];
  const tip = (key: string, label: string, text: string) => kpiTip(t, key, label, undefined, { text });

  return (
    <Card
      icon={ClipboardCheck}
      title={(
        <span className="u-inline-row u-gap-1h">
          {t('agent.adherence.title')}
          <Tooltip {...tip('agent.adherence.tip.source', t('agent.adherence.title'),
            'Availability follows the phone registration; breaks are the status agents set themselves.')} />
        </span>
      )}
      description={`${t('agent.adherence.subtitle')} · ${agents.length} ${t('analytics.agents.agents', 'agents')}`}
      actions={(
        <>
          <div className="u-row u-gap-1" role="tablist" aria-label={t('agent.adherence.typeFilter', 'Show')}>
            {(['all', 'agents', 'extensions'] as TypeFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={typeFilter === f}
                className={`btn btn-sm${typeFilter === f ? '' : ' btn-ghost'}`}
                onClick={() => setTypeFilter(f)}
              >
                {f === 'all' ? t('agentBoard.filterAll', 'All') : f === 'agents' ? t('agentBoard.filterAgents', 'Queue agents') : t('agentBoard.filterExtensions', 'Extensions')}
              </button>
            ))}
          </div>
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
      {allRows.length === 0 || agents.length === 0 ? (
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
                  {t('agent.adherence.firstOnline', 'First online')}
                  <Tooltip {...tip('agent.adherence.tip.firstOnline', t('agent.adherence.firstOnline', 'First online'), 'When the phone first came online in the period.')} />
                </th>
                <th className="num">
                  {t('agent.adherence.lastOffline', 'Last offline')}
                  <Tooltip {...tip('agent.adherence.tip.lastOffline', t('agent.adherence.lastOffline', 'Last offline'), 'When the phone last went offline. "Online" while it still is.')} />
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
                        <div className="an-agent-ext">
                          {a.agent}
                          {a.is_agent === false && <> · {t('agent.adherence.extensionTag', 'extension')}</>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num">{fmtClock(a.login)}</td>
                  <td className="num">
                    {a.logged_in
                      ? <Badge tone="success">{t('agent.adherence.onlineNow', 'Online')}</Badge>
                      : fmtClock(a.logout)}
                  </td>
                  <td className="num">{a.sessions ?? '—'}</td>
                  <td className="num u-semibold">{fmtSecs(a.registered_secs ?? 0)}</td>
                  <td className="num">{a.is_agent === false ? '—' : fmtSecs(a.queue_login_secs ?? 0)}</td>
                  <td className="num an-fg-ready">{fmtSecs(a.available_secs ?? a.ready_secs + a.on_call_secs + a.wrap_secs)}</td>
                  <td
                    className="num"
                    title={a.idle_dnd_secs ? `${t('agent.adherence.idleOnDnd', 'Idle on DND')}: ${fmtSecs(a.idle_dnd_secs)}` : undefined}
                  >
                    {fmtSecs(a.idle_secs ?? a.ready_secs)}
                    {!!a.idle_dnd_secs && <span className="u-fg-danger"> · {fmtSecs(a.idle_dnd_secs)}</span>}
                  </td>
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
                  <td className="num" title={`${t('agent.adherence.outboundTalk', 'Talk')}: ${fmtSecs(a.outbound_talk_secs ?? 0)}`}>
                    {a.outbound_calls ?? 0}
                    {!!a.outbound_talk_secs && <span className="an-agent-ext"> · {fmtSecs(a.outbound_talk_secs)}</span>}
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
