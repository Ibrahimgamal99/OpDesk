import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Headset, LogOut, Pause, Play, PhoneCall, UserCheck } from 'lucide-react';
import type { ActionMessage, AgentStateInfo, Extension } from '../types';
import { StatusBadge, resolveAgentMeta } from './statusBadge';
import { fmtTimer } from '../lib/format';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { EmptyState, Popover, useConfirm } from './ui';

interface AgentBoardProps {
  /** Presence per extension, already scoped to the viewer by the server. */
  agentStates: Record<string, AgentStateInfo>;
  extensions: Record<string, Extension>;
  /** Search term from the page toolbar (name or extension). */
  query: string;
  sendAction: (action: ActionMessage) => void;
}

/** Seconds an agent has been in their current state, as of `now` (ms). */
function elapsedSecs(agent: AgentStateInfo, now: number): number {
  return agent.since ? (now - new Date(agent.since).getTime()) / 1000 : agent.duration_secs;
}

type BoardFilter = 'all' | 'agents' | 'extensions';

/**
 * The supervisor's view of the floor: every extension in scope with its availability (agents
 * and plain/outbound extensions alike), how long it has held it and the break reason, whether
 * it is in its queues, and the forcing actions -- Break with a reason, back to Available, and
 * for an agent in its queues, log out of the queues. Availability itself follows the phone;
 * there is no "force offline".
 */
export function AgentBoard({ agentStates, extensions, query, sendAction }: AgentBoardProps) {
  const { t } = useTranslation();
  const { selectable, labelFor } = usePauseReasons();
  const [confirm, confirmDialog] = useConfirm();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const agents = useMemo(() => Object.values(agentStates)
    .filter((a) => filter === 'all' || (filter === 'agents' ? a.is_agent !== false : a.is_agent === false))
    .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true })), [agentStates, filter]);

  const nameFor = (ext: string) => extensions[ext]?.name || '';
  const term = query.trim().toLowerCase();
  const shown = agents.filter((a) => !term
    || a.extension.toLowerCase().includes(term) || nameFor(a.extension).toLowerCase().includes(term));

  const logOut = async (a: AgentStateInfo) => {
    const who = nameFor(a.extension) || a.extension;
    const ok = await confirm({
      title: t('agentBoard.logoutTitle', { agent: who }),
      message: t('agentBoard.logoutConfirm', { agent: who }),
      confirmLabel: t('agent.queueLogout', 'Log out of queues'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (ok) sendAction({ action: 'agent_logout', agent: a.extension });
  };

  const filterBar = (
    <div className="agent-board-filter u-row u-gap-1" role="tablist">
      {(['all', 'agents', 'extensions'] as BoardFilter[]).map((f) => (
        <button
          key={f}
          type="button"
          role="tab"
          aria-selected={filter === f}
          className={`btn btn-sm${filter === f ? '' : ' btn-ghost'}`}
          onClick={() => setFilter(f)}
        >
          {f === 'all' ? t('agentBoard.filterAll', 'All') : f === 'agents' ? t('agentBoard.filterAgents', 'Queue agents') : t('agentBoard.filterExtensions', 'Extensions')}
        </button>
      ))}
    </div>
  );

  if (agents.length === 0 || shown.length === 0) {
    return (
      <>
        {filterBar}
        <EmptyState
          icon={UserCheck}
          title={agents.length === 0 ? t('agentBoard.empty', 'No agents in your scope') : t('agentBoard.noMatches', 'No agents match this search')}
        />
      </>
    );
  }

  return (
    <>
      {filterBar}
      <div className="agent-board-grid">
        {shown.map((a) => {
          // DND overrides a break and is the status itself while not on a call.
          const shownState = a.dnd && a.state !== 'on_call' && a.state !== 'logged_out' ? 'dnd' : a.state;
          const { meta, asleep } = resolveAgentMeta(shownState, a.reachable_via === 'push' || extensions[a.extension]?.status === 'unavailable');
          const reason = a.state === 'not_ready' ? labelFor(a.reason_code) : null;
          // Offline on a break: say which break it resumes with when the phone is back.
          const label = a.held_break
            ? t('agentBoard.offlineOnBreak', { reason: labelFor(a.held_break) || a.held_break, defaultValue: 'Offline · {{reason}}' })
            : reason || t(meta.key, meta.fallback);
          const online = a.state !== 'logged_out';
          const inQueues = !!a.queue_logged_in;
          return (
            <div key={a.extension} className="agent-board-card" style={{ ['--agent-accent' as string]: `var(${meta.varName})` }}>
              <div className="agent-board-head">
                <div>
                  <div className="agent-board-name">{nameFor(a.extension) || a.extension}</div>
                  <div className="agent-board-ext u-mono">{a.extension}</div>
                </div>
                <StatusBadge meta={meta} label={label} title={asleep ? t('agent.state.deviceAsleep') : undefined} />
              </div>
              <div className="agent-board-meta">
                {online && <span className="agent-board-timer u-mono">{fmtTimer(elapsedSecs(a, now))}</span>}
                {a.queue && a.state === 'on_call' && (
                  <span className="u-row u-gap-1"><PhoneCall size={14} />{t('agent.state.queueLabel', { queue: a.queue })}</span>
                )}
                {inQueues && (
                  <span className="u-row u-gap-1" title={(a.queues || []).join(', ')}><Headset size={14} />{t('agentBoard.inQueues', 'In queues')}</span>
                )}
              </div>
              {(online || inQueues || a.held_break) && (
                <div className="agent-board-actions">
                  {(a.held_break || (online && (a.state === 'not_ready' || a.state === 'wrap_up'))) && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => sendAction({ action: 'agent_set_status', status: 'ready', agent: a.extension })}
                    >
                      <Play size={14} />{t('agentBoard.setAvailable', 'Set Available')}
                    </button>
                  )}
                  {online && (
                    <Popover
                      open={menuFor === a.extension}
                      onOpenChange={(next) => setMenuFor(next ? a.extension : null)}
                      label={t('agentBoard.setBreak', 'Set Break')}
                      minWidth={190}
                      trigger={({ ref, ...triggerProps }) => (
                        <button {...triggerProps} ref={ref} type="button" className="btn btn-sm" disabled={a.state === 'on_call'}>
                          <Pause size={14} />{t('agentBoard.setBreak', 'Set Break')}<ChevronDown size={14} />
                        </button>
                      )}
                    >
                      {selectable.length === 0 && (
                        <div className="agent-bar-menu-empty">{t('agent.noReasons', 'No reason codes')}</div>
                      )}
                      {selectable.map((r) => (
                        <button
                          key={r.code}
                          type="button"
                          className="agent-bar-menu-item"
                          onClick={() => {
                            sendAction({ action: 'agent_set_status', status: 'not_ready', reason_code: r.code, agent: a.extension });
                            setMenuFor(null);
                          }}
                        >
                          {r.label}
                        </button>
                      ))}
                    </Popover>
                  )}
                  {inQueues && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void logOut(a); }}>
                      <LogOut size={14} />{t('agent.queueLogout', 'Log out of queues')}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {confirmDialog}
    </>
  );
}
