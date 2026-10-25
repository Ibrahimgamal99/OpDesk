import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import {
  LineChart, Line, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as ChartTooltip, CartesianGrid, LabelList,
} from 'recharts';
import { BarChart3, ChevronUp, ChevronDown, Users } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { AgentKPIRow } from '../types';
import {
  fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip, pctOf, rangeLabel,
} from './analyticsUtils';
import { Alert, Badge, Card, Dropdown, EmptyState, Tooltip } from './ui';
import { AnalyticsExportButton } from './AnalyticsExport';
import { AgentCallsModal } from './AgentCallsModal';

type SortKey = 'rank' | 'agent_name' | 'total_calls' | 'answered_calls' | 'inbound_calls' | 'outbound_calls'
  | 'internal_calls' | 'aht_secs' | 'sla_contribution_pct';
type SortDir = 'asc' | 'desc';

function sortRows(rows: AgentKPIRow[], key: SortKey, dir: SortDir): AgentKPIRow[] {
  return [...rows].sort((a, b) => {
    const va = (a[key] as number | string) ?? -Infinity;
    const vb = (b[key] as number | string) ?? -Infinity;
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function RankBadge({ rank }: { rank: number }) {
  const cls = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
  return <span className={`an-rank ${cls}`}>{rank}</span>;
}

interface TinySparklineProps { data: number[] }
function TinySparkline({ data }: TinySparklineProps) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const hasVariance = max > min;
  const chartData = data.map((v, i) => ({ i, v }));

  return (
    <div dir="ltr">
      <ResponsiveContainer width={88} height={30}>
        <LineChart data={chartData} margin={{ top: 3, right: 3, bottom: 3, left: 3 }}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={hasVariance ? 'var(--accent-primary)' : 'var(--text-muted)'}
            dot={false}
            strokeWidth={1.5}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** An agent row, plus the figures a backend may add per agent. Each is read when present
 *  and derived from the base row when not. */
type AgentRow = AgentKPIRow & {
  /** Distinct outside numbers this agent reached ÷ involved (counts people). */
  answer_rate?: number | null;
  /** Total talk time of the agent's answered calls, seconds. */
  talk_secs?: number | null;
  /** Calls that rang this agent and were not answered. */
  missed_calls?: number | null;
};

/** What the comparison chart ranks the agents by. */
type CompareKey = 'answered' | 'aht' | 'answerRate' | 'contactRate' | 'talkTime' | 'missed';
type CompareFormat = 'count' | 'pct' | 'secs';

interface Props { dateRange: DateRange }

/**
 * Analytics → Agents: one ranked row per agent on customer work (inbound + outbound;
 * internal calls are counted in their own column and never ranked), and the agents side
 * by side on one figure. A row opens that agent's calls by direction (AgentCallsModal).
 */
export function AnalyticsAgents({ dateRange }: Props) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [compareBy, setCompareBy] = useState<CompareKey>('answered');
  const [callsFor, setCallsFor] = useState<AgentRow | null>(null);
  const { data, loading, error } = useAnalyticsFetch(
    () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      return analyticsGet<{ agents: AgentRow[] }>(`/api/analytics/agent-performance?${params}`);
    },
    [dateRange],
  );
  const agents = data?.agents ?? [];

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'rank' ? 'asc' : 'desc');
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
    return <Alert>{t('analytics.error')}</Alert>;
  }

  const sorted = sortRows(agents, sortKey, sortDir);

  type Tip = { text: string; formula?: string };
  const columns: { key: SortKey; label: string; tipKey?: string; tip?: Tip }[] = [
    { key: 'rank',                 label: t('analytics.agents.rank'),     tipKey: 'analytics.tip.agents.rank',
      tip: { text: 'Position by calls answered.' } },
    { key: 'agent_name',           label: t('fields.agent') },
    { key: 'total_calls',          label: t('analytics.queues.total'),    tipKey: 'analytics.tip.agents.totalAll',
      tip: { text: 'Every customer call this agent handled, inbound and outbound. Internal calls are counted apart.' } },
    { key: 'answered_calls',       label: t('metrics.answered'), tipKey: 'analytics.tip.agents.answered',
      tip: { text: 'Customer calls this agent connected: the rank orders by this.' } },
    { key: 'inbound_calls',        label: t('direction.inbound', 'Inbound'),   tipKey: 'analytics.tip.agents.inbound',
      tip: { text: 'Calls that came in to this agent.' } },
    { key: 'outbound_calls',       label: t('direction.outbound', 'Outbound'), tipKey: 'analytics.tip.agents.outbound',
      tip: { text: 'Calls this agent placed.' } },
    { key: 'internal_calls',       label: t('direction.internal', 'Internal'), tipKey: 'analytics.tip.agents.internal',
      tip: { text: 'Calls between extensions. Shown for the time they take, but not customer work: they are not in the total and do not count towards the rank.' } },
    { key: 'aht_secs',             label: t('metrics.aht'),      tipKey: 'metrics.tip.aht' },
    { key: 'sla_contribution_pct', label: t('analytics.agents.slaContrib'), tipKey: 'analytics.tip.agents.slaContribution',
      tip: { text: 'How often this agent picked up queue calls in time. Blank if they take no queue calls.', formula: 'answered in time ÷ queue calls answered' } },
  ];

  // ── Comparison: one figure across every agent ──────────────────────────────
  // Answer rate counts people, so it is offered only when the server sends it per agent;
  // answered ÷ calls (the contact rate) is always computable. Talk time and missed calls
  // come from the row when the server sends them, else from the figures it always sends.
  const hasAnswerRate = agents.some((a) => a.answer_rate !== undefined && a.answer_rate !== null);
  const compareOptions: { value: CompareKey; label: string; format: CompareFormat; pick: (a: AgentRow) => number | null }[] = [
    { value: 'answered', label: t('metrics.answered'), format: 'count', pick: (a) => a.answered_calls },
    { value: 'aht', label: t('metrics.aht'), format: 'secs', pick: (a) => a.aht_secs },
    ...(hasAnswerRate
      ? [{ value: 'answerRate' as const, label: t('metrics.answerRate'), format: 'pct' as const, pick: (a: AgentRow) => a.answer_rate ?? null }]
      : []),
    { value: 'contactRate', label: t('metrics.contactRate'), format: 'pct', pick: (a) => pctOf(a.answered_calls, a.total_calls) },
    { value: 'talkTime', label: t('metrics.talkTime'), format: 'secs',
      pick: (a) => a.talk_secs ?? (a.aht_secs !== null ? Math.round(a.aht_secs * a.answered_calls) : null) },
    { value: 'missed', label: t('metrics.missed'), format: 'count',
      pick: (a) => a.missed_calls ?? Math.max(0, a.total_calls - a.answered_calls) },
  ];
  const compare = compareOptions.find((o) => o.value === compareBy) ?? compareOptions[0];
  const fmtCompare = (v: number) =>
    compare.format === 'pct' ? fmtPct(v) : compare.format === 'secs' ? fmtSecs(v) : v.toLocaleString();
  const compareRows = agents
    .map((a) => ({
      name: a.agent_name && a.agent_name !== a.agent_extension ? `${a.agent_extension} · ${a.agent_name}` : a.agent_extension,
      value: compare.pick(a),
    }))
    .filter((r): r is { name: string; value: number } => r.value !== null)
    .sort((a, b) => b.value - a.value);
  const tooltipStyle = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-accent)',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-xs)',
    boxShadow: 'var(--shadow-lg)',
  };
  const axisTick = { fontSize: 11, fill: 'var(--text-muted)' };
  const compareTitle = t('analytics.agents.compareTitle', 'Compare agents');

  return (
    <div className="u-col u-gap-4">
      <Card
        icon={Users}
        title={t('analytics.nav.agents')}
        description={`${agents.length} ${t('analytics.agents.agents', 'agents')}`}
        actions={agents.length > 0 ? (
          <AnalyticsExportButton report="agents" dateRange={dateRange}
            title={t('analytics.export.agentsTitle', 'Every agent’s figures as a CSV file')} />
        ) : undefined}
        flush
      >
        {agents.length === 0 ? (
          <EmptyState size="sm" icon={Users} title={t('analytics.empty', 'No data for this period')} />
        ) : (
          <div className="an-table-wrap">
            <table className="an-table">
              <thead>
                <tr>
                  {columns.map(c => (
                    <th
                      key={c.key}
                      className={[
                        sortKey === c.key ? 'sorted' : '',
                        c.key === 'agent_name' ? 'sticky' : '',
                        c.key !== 'agent_name' ? 'num' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label} <SortIcon col={c.key} />
                      {c.tipKey && <Tooltip {...kpiTip(t, c.tipKey, c.label, undefined, c.tip)} />}
                    </th>
                  ))}
                  <th className="u-nowrap">
                    {t('analytics.agents.trend7d')}
                    <Tooltip {...kpiTip(t, 'analytics.tip.agents.trend', t('analytics.agents.trend7d'), undefined,
                      { text: 'Calls answered per day, last 7 days.' })} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(a => (
                  <tr key={a.agent_extension} className="an-row-clickable" onClick={() => setCallsFor(a)}>
                    <td className="an-col-fit">
                      <RankBadge rank={a.rank} />
                    </td>
                    <td className="sticky">
                      <div className="an-agent-cell">
                        <div className="an-agent-info">
                          {/* The name is the control, not the row: a role="button" on the <tr>
                              would strip every cell of its column for a screen reader. */}
                          <button
                            type="button"
                            className="an-agent-name an-tl-open"
                            onClick={e => { e.stopPropagation(); setCallsFor(a); }}
                            title={t('analytics.agentCalls.open', 'Show this agent’s calls')}
                          >
                            {a.agent_name}
                          </button>
                          <div className="an-agent-ext">{a.agent_extension}</div>
                        </div>
                      </div>
                    </td>
                    <td className="num u-semibold">
                      {a.total_calls.toLocaleString()}
                    </td>
                    <td className="num">{a.answered_calls.toLocaleString()}</td>
                    <td className="num u-fg-accent">{(a.inbound_calls ?? 0).toLocaleString()}</td>
                    <td className="num u-fg-warning">{(a.outbound_calls ?? 0).toLocaleString()}</td>
                    <td className="num muted">{(a.internal_calls ?? 0).toLocaleString()}</td>
                    <td className="num">{fmtSecs(a.aht_secs)}</td>
                    <td>
                      {a.sla_contribution_pct !== null ? (
                        <div className="an-sla-cell">
                          <Badge tone={a.sla_contribution_pct >= 80 ? 'success' : 'danger'}>
                            {fmtPct(a.sla_contribution_pct)}
                          </Badge>
                          <div className="an-progress">
                            <div
                              className={`an-progress-fill u-fill-x ${slaProgressClass(a.sla_contribution_pct)}`}
                              style={{ '--u-fill': `${a.sla_contribution_pct}%` } as React.CSSProperties}
                            />
                          </div>
                        </div>
                      ) : (
                        <Badge tone="neutral">—</Badge>
                      )}
                    </td>
                    <td className="an-col-fit">
                      {a.daily_trend.length > 1 && <TinySparkline data={a.daily_trend} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── The agents side by side, one figure at a time ── */}
      {agents.length > 1 && (
        <Card
          icon={BarChart3}
          title={
            <span className="u-inline-row u-gap-1h">
              {compareTitle}
              <Tooltip {...kpiTip(t, 'analytics.tip.agents.compare', compareTitle, undefined,
                { text: 'Every agent on one figure at a time, highest first. Pick the figure from the menu.' })} />
            </span>
          }
          description={rangeLabel(dateRange)}
          actions={
            <Dropdown
              value={compareBy}
              onChange={(v) => setCompareBy(v as CompareKey)}
              options={compareOptions.map(({ value, label }) => ({ value, label }))}
              ariaLabel={t('analytics.agents.compareBy', 'Compare by')}
              size="sm"
            />
          }
        >
          {compareRows.length === 0 ? (
            <EmptyState size="sm" icon={BarChart3} title={t('analytics.empty', 'No data for this period')} />
          ) : (
            <div className="an-chart-wrap" dir="ltr">
              <ResponsiveContainer width="100%" height={Math.max(120, 32 + compareRows.length * 36)}>
                <BarChart data={compareRows} layout="vertical" margin={{ top: 4, right: 72, bottom: 0, left: 8 }}>
                  <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false}
                         domain={compare.format === 'pct' ? [0, 100] : [0, 'auto']}
                         allowDecimals={compare.format !== 'count'}
                         tickFormatter={(v) => (compare.format === 'pct' ? `${v}%` : compare.format === 'secs' ? fmtSecs(v) : String(v))} />
                  <YAxis type="category" dataKey="name" tick={axisTick} width={140} axisLine={false} tickLine={false} />
                  <ChartTooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }}
                                formatter={(v) => [fmtCompare(Number(v)), compare.label]} />
                  <Bar dataKey="value" name={compare.label} fill="var(--chart-inbound)" radius={[0, 4, 4, 0]} barSize={18}>
                    <LabelList dataKey="value" position="right" formatter={(v: unknown) => fmtCompare(Number(v))}
                               className="an-bar-label" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      )}
      {callsFor && (
        <AgentCallsModal
          agent={callsFor.agent_extension}
          name={callsFor.agent_name}
          dateRange={dateRange}
          onClose={() => setCallsFor(null)}
        />
      )}
    </div>
  );
}
