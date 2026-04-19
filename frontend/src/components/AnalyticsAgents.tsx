import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import type { AgentKPIRow } from '../types';
import { fmtSecs, fmtPct, slaProgressClass, buildDateParams, analyticsGet, useAnalyticsFetch } from './analyticsUtils';

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
    return <div className="an-empty">{t('analytics.error')}</div>;
  }

  const sorted = sortRows(agents, sortKey, sortDir);

  const columns: { key: SortKey; label: string }[] = [
    { key: 'rank',                 label: t('analytics.agents.rank') },
    { key: 'agent_name',           label: t('analytics.agents.agent') },
    { key: 'total_calls',          label: t('analytics.queues.total') },
    { key: 'answered_calls',       label: t('analytics.agents.answered') },
    { key: 'inbound_calls',        label: '📥 ' + t('analytics.directions.inbound', 'Inbound') },
    { key: 'outbound_calls',       label: '📤 ' + t('analytics.directions.outbound', 'Outbound') },
    { key: 'aht_secs',             label: t('analytics.agents.aht') },
    { key: 'sla_contribution_pct', label: t('analytics.agents.slaContrib') },
  ];

  return (
    <div className="an-section">
      <div className="an-section-header">
        <div className="an-section-title">{t('analytics.agents.title')}</div>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {agents.length} {t('analytics.agents.agents', 'agents')}
        </span>
      </div>
      {agents.length === 0 ? (
        <div className="an-empty">{t('analytics.empty', 'No data for this period')}</div>
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
                  </th>
                ))}
                <th style={{ whiteSpace: 'nowrap' }}>{t('analytics.agents.trend7d')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(a => (
                <tr key={a.agent_extension}>
                  <td style={{ width: 40 }}>
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
                  <td className="num" style={{ fontWeight: 600 }}>
                    {a.total_calls.toLocaleString()}
                  </td>
                  <td className="num">{a.answered_calls.toLocaleString()}</td>
                  <td className="num" style={{ color: 'var(--accent-primary)' }}>{(a.inbound_calls ?? 0).toLocaleString()}</td>
                  <td className="num" style={{ color: 'var(--warning)' }}>{(a.outbound_calls ?? 0).toLocaleString()}</td>
                  <td className="num">{fmtSecs(a.aht_secs)}</td>
                  <td>
                    {a.sla_contribution_pct !== null ? (
                      <div className="an-sla-cell">
                        <span className={`an-badge ${a.sla_contribution_pct >= 80 ? 'sla-met' : 'sla-fail'}`}>
                          {fmtPct(a.sla_contribution_pct)}
                        </span>
                        <div className="an-progress">
                          <div
                            className={`an-progress-fill ${slaProgressClass(a.sla_contribution_pct)}`}
                            style={{ width: `${a.sla_contribution_pct}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <span className="an-badge neutral">—</span>
                    )}
                  </td>
                  <td style={{ width: 96 }}>
                    {a.daily_trend.length > 1 && <TinySparkline data={a.daily_trend} />}
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
