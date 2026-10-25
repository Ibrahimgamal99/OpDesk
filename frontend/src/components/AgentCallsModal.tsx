import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowUpDown, PhoneCall, Users } from 'lucide-react';
import type { AgentCallRecord, AgentCallsDirection, AgentCallsResponse } from '../types';
import type { DateRange } from './analyticsUtils';
import { fmtSecs, buildDateParams, analyticsGet, useAnalyticsFetch } from './analyticsUtils';
import { fmtDateTime } from '../lib/format';
import { presentOptions, showFilter } from '../lib/filters';
import { CALL_STATUS_ORDER, callStatusColor, callStatusLabel } from './callStatus';
import { CallStatusBadge } from './CallStatusBadge';
import {
  Alert, Dropdown, EmptyState, Loading, Modal, Pagination, Table, Toolbar, type Column, type DropdownOption,
} from './ui';

const PAGE_SIZE = 25;

type Direction = AgentCallsDirection['direction'];

interface Props {
  agent: string;
  name: string;
  dateRange: DateRange;
  onClose: () => void;
}

/**
 * Agent Performance row click: how one agent's calls for the period split by direction
 * (inbound, outbound, internal), and the calls behind each figure. Picking a direction row
 * filters the list to it.
 *
 * A call that rang this agent while a colleague answered (or nobody did) counts as Missed
 * here, so the totals can exceed the table row, which credits each call to the one agent
 * who took it.
 */
export function AgentCallsModal({ agent, name, dateRange, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [direction, setDirection] = useState<Direction | ''>('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const { data, loading, error } = useAnalyticsFetch<AgentCallsResponse>(
    () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      params.set('agent', agent);
      if (direction) params.set('direction', direction);
      if (status) params.set('status', status);
      params.set('page', String(page));
      params.set('page_size', String(PAGE_SIZE));
      return analyticsGet<AgentCallsResponse>(`/api/analytics/agent-calls?${params}`);
    },
    [agent, dateRange, direction, status, page],
  );

  const directions = data?.directions ?? [];
  const calls = data?.calls ?? [];
  const total = data?.total ?? 0;
  const totalCalls = directions.reduce((n, d) => n + d.calls, 0);

  const directionLabel = (d: Direction) =>
    d === 'IN' ? t('direction.inbound', 'Inbound') : d === 'OUT' ? t('direction.outbound', 'Outbound') : t('direction.internal', 'Internal');

  const pickDirection = (d: Direction | '') => {
    setDirection(cur => (cur === d ? '' : d));
    setStatus('');
    setPage(1);
  };
  const pickStatus = (s: string) => {
    setStatus(s);
    setPage(1);
  };

  const directionOptions: DropdownOption[] = directions
    .filter(d => d.calls > 0 || d.direction === direction)
    .map(d => ({ value: d.direction, label: directionLabel(d.direction), count: d.calls }));
  const allStatuses: DropdownOption[] = [...new Set([...CALL_STATUS_ORDER, ...Object.keys(data?.status_counts ?? {})])]
    .map(s => ({ value: s, label: callStatusLabel(t, s), dotColor: callStatusColor(s) }));
  const statusOptions = presentOptions(allStatuses, data?.status_counts ?? {}, status);

  const callColumns: Column<AgentCallRecord>[] = [
    {
      key: 'calldate', header: t('analytics.drilldown.date', 'Date'), primary: true,
      cell: c => <span className="u-nowrap">{fmtDateTime(c.calldate, i18n.language)}</span>,
    },
    {
      key: 'direction', header: t('fields.direction', 'Direction'), hideOnMobile: true,
      cell: c => directionLabel(c.direction),
    },
    {
      key: 'number', header: t('analytics.agentCalls.number', 'Number'),
      cell: c => <span className="an-tnum">{(c.direction === 'OUT' ? c.dst : c.src) || '—'}</span>,
    },
    {
      key: 'queue', header: t('fields.queue', 'Queue'), hideOnMobile: true,
      cell: c => c.queue_extension || '—',
    },
    {
      key: 'status', header: t('common.status', 'Status'),
      cell: c => (
        <>
          <CallStatusBadge status={c.agent_status} />
          {/* Rang this agent, taken by a colleague: say who, or the Missed reads as if
              the customer was lost. */}
          {!c.is_handled && c.agent_extension && c.status === 'ANSWERED' && (
            <div className="an-agent-ext">
              {t('analytics.agentCalls.takenBy', { id: c.agent_extension, defaultValue: 'Taken by {{id}}' })}
            </div>
          )}
        </>
      ),
    },
    {
      key: 'talk', header: t('analytics.drilldown.talk', 'Talk'), align: 'end',
      cell: c => <span className="an-tnum">{c.is_handled && c.talk > 0 ? fmtSecs(c.talk) : '—'}</span>,
    },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      className="an-tl-modal"
      icon={<Users size={16} />}
      title={name && name !== agent ? `${name} · ${agent}` : agent}
      headerAside={
        <span className="an-tl-period">
          {dateRange.from === dateRange.to
            ? dateRange.from
            : t('agent.timeline.period', '{{from}} to {{to}}', { from: dateRange.from, to: dateRange.to })}
        </span>
      }
      footer={<button type="button" className="btn" onClick={onClose}>{t('common.close', 'Close')}</button>}
    >
      <div className="an-ac-body">
        {loading && !data && <Loading size="sm" label={t('analytics.loading')} />}
        {error && <Alert>{t('analytics.error')}</Alert>}
        {data && !error && totalCalls === 0 && (
          <EmptyState icon={PhoneCall} size="sm" title={t('analytics.empty', 'No data for this period')} />
        )}

        {data && !error && totalCalls > 0 && (
          <>
            <div className="an-table-wrap">
              <table className="an-table an-ac-summary">
                <thead>
                  <tr>
                    <th className="sticky">{t('fields.direction', 'Direction')}</th>
                    <th className="num">{t('analytics.agentCalls.calls', 'Calls')}</th>
                    <th className="num">{t('metrics.answered')}</th>
                    <th className="num" title={t('analytics.agentCalls.missedHint', 'Rang this agent and they did not take it, including calls a colleague answered')}>
                      {t('metrics.missed')}
                    </th>
                    <th className="num" title={t('analytics.agentCalls.otherHint', 'The other end never picked up, was busy or unreachable, or the line failed')}>
                      {t('analytics.agentCalls.other', 'Not connected')}
                    </th>
                    <th className="num">{t('metrics.talkTime')}</th>
                  </tr>
                </thead>
                <tbody>
                  {directions.map(d => {
                    const selected = direction === d.direction;
                    return (
                      <tr
                        key={d.direction}
                        className={['an-row-clickable', selected ? 'an-ac-selected' : '', d.calls === 0 ? 'an-ac-empty' : '']
                          .filter(Boolean).join(' ')}
                        onClick={() => pickDirection(d.direction)}
                      >
                        <td className="sticky">
                          <button
                            type="button"
                            className="an-tl-open an-ac-route"
                            aria-pressed={selected}
                            onClick={e => { e.stopPropagation(); pickDirection(d.direction); }}
                          >
                            {directionLabel(d.direction)}
                          </button>
                        </td>
                        <td className="num u-semibold">{d.calls.toLocaleString()}</td>
                        <td className="num u-fg-success">{d.answered.toLocaleString()}</td>
                        <td className="num u-fg-danger">{d.missed.toLocaleString()}</td>
                        <td className="num muted">{d.not_connected.toLocaleString()}</td>
                        <td className="num">{d.answered ? fmtSecs(d.talk_secs) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Toolbar
              filters={
                <>
                  {showFilter(directionOptions, direction) && (
                    <div data-active={direction || undefined}>
                      <Dropdown
                        value={direction}
                        onChange={v => pickDirection(v as Direction | '')}
                        icon={ArrowUpDown}
                        size="sm"
                        minWidth={156}
                        ariaLabel={t('fields.direction', 'Direction')}
                        options={[{ value: '', label: t('direction.all', 'All Directions') }, ...directionOptions]}
                      />
                    </div>
                  )}
                  {showFilter(statusOptions, status) && (
                    <div data-active={status || undefined}>
                      <Dropdown
                        value={status}
                        onChange={pickStatus}
                        icon={Activity}
                        size="sm"
                        minWidth={156}
                        ariaLabel={t('common.status', 'Status')}
                        options={[{ value: '', label: t('common.allStatuses') }, ...statusOptions]}
                      />
                    </div>
                  )}
                </>
              }
              actions={
                <span className="an-ac-count" aria-live="polite">
                  {t('analytics.agentCalls.callCount', { count: total, defaultValue: '{{count}} calls' })}
                </span>
              }
            />

            <div className="an-ac-list" aria-busy={loading}>
              <Table
                columns={callColumns}
                rows={calls}
                rowKey={(c, i) => `${c.linkedid}-${i}`}
                density="compact"
                empty={<EmptyState icon={PhoneCall} size="sm" title={t('analytics.empty', 'No data for this period')} />}
              />
            </div>
            {total > PAGE_SIZE && (
              <Pagination page={page} totalPages={Math.ceil(total / PAGE_SIZE)} onPage={setPage} />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
