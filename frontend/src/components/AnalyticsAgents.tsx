import { useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { ChevronUp, ChevronDown, Users } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { AgentKPIRow } from '../types';
import { fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch, kpiTip } from './analyticsUtils';
import { Alert, Badge, Card, EmptyState, Tooltip } from './ui';

type SortKey = 'rank' | 'agent_name' | 'total_calls' | 'answered_calls' | 'inbound_calls' | 'outbound_calls' | 'aht_secs' | 'sla_contribution_pct';
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

interface Props { dateRange: DateRange }

export function AnalyticsAgents({ dateRange }: Props) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const { data, loading, error } = useAnalyticsFetch(
    () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      return analyticsGet<{ agents: AgentKPIRow[] }>(`/api/analytics/agent-performance?${params}`);
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
    { key: 'agent_name',           label: t('analytics.agents.agent') },
    { key: 'total_calls',          label: t('analytics.queues.total'),    tipKey: 'analytics.tip.agents.totalAll',
      tip: { text: 'Every call this agent handled: inbound, outbound and internal.' } },
    { key: 'answered_calls',       label: t('analytics.agents.answered'), tipKey: 'analytics.tip.agents.answered',
      tip: { text: 'Calls this agent picked up.' } },
    { key: 'inbound_calls',        label: t('analytics.directions.inbound', 'Inbound'),   tipKey: 'analytics.tip.agents.inbound',
      tip: { text: 'Calls that came in to this agent.' } },
    { key: 'outbound_calls',       label: t('analytics.directions.outbound', 'Outbound'), tipKey: 'analytics.tip.agents.outbound',
      tip: { text: 'Calls this agent placed.' } },
    { key: 'aht_secs',             label: t('analytics.agents.aht'),      tipKey: 'analytics.tip.kpi.ahtTalk',
      tip: { text: 'Average talk time of an answered call.', formula: 'talk time ÷ answered' } },
    { key: 'sla_contribution_pct', label: t('analytics.agents.slaContrib'), tipKey: 'analytics.tip.agents.slaContribution',
      tip: { text: 'How often this agent picked up queue calls in time. Blank if they take no queue calls.', formula: 'answered in time ÷ queue calls answered' } },
  ];

  return (
    <Card
      icon={Users}
      title={t('analytics.agents.title')}
      description={`${agents.length} ${t('analytics.agents.agents', 'agents')}`}
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
                <tr key={a.agent_extension}>
                  <td className="an-col-fit">
                    <RankBadge rank={a.rank} />
                  </td>
                  <td className="sticky">
                    <div className="an-agent-cell">
                      <div className="an-agent-info">
                        <div className="an-agent-name">{a.agent_name}</div>
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
  );
}
