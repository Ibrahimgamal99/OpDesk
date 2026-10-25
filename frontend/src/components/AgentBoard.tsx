import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, LogOut, Pause, Play, PhoneCall, UserCheck } from 'lucide-react';
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

/**
 * The supervisor's view of the floor: every queue agent in scope with their presence, how
 * long they have been in it and the reason, and the forcing actions -- Not Ready with a
 * reason, back to Ready, log out of the queues. Each acts on the agent as a whole (every
 * queue they are in), the way the agent's own status bar does, so presence never disagrees
 * with the queues.
 */
export function AgentBoard({ agentStates, extensions, query, sendAction }: AgentBoardProps) {
  const { t } = useTranslation();
  const { selectable, labelFor } = usePauseReasons();
  const [confirm, confirmDialog] = useConfirm();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Plain extensions (Available / DND / Offline) live in agent_states too, for their own
  // status bar; the board is about queue agents.
  const agents = useMemo(() => Object.values(agentStates)
    .filter((a) => a.is_agent !== false)
    .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true })), [agentStates]);

  const nameFor = (ext: string) => extensions[ext]?.name || '';
  const term = query.trim().toLowerCase();
  const shown = agents.filter((a) => !term
    || a.extension.toLowerCase().includes(term) || nameFor(a.extension).toLowerCase().includes(term));

  const logOut = async (a: AgentStateInfo) => {
    const who = nameFor(a.extension) || a.extension;
    const ok = await confirm({
      title: t('agentBoard.logoutTitle', { agent: who }),
      message: t('agentBoard.logoutConfirm', { agent: who }),
      confirmLabel: t('agent.logout', 'Log out'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (ok) sendAction({ action: 'agent_logout', agent: a.extension });
  };

  if (agents.length === 0) {
    return <EmptyState icon={UserCheck} title={t('agentBoard.empty', 'No agents in your scope')} />;
  }
  if (shown.length === 0) {
    return <EmptyState icon={UserCheck} title={t('agentBoard.noMatches', 'No agents match this search')} />;
  }

  return (
    <>
      <div className="agent-board-grid">
        {shown.map((a) => {
          const { meta, asleep } = resolveAgentMeta(a.state, extensions[a.extension]?.status === 'unavailable');
          const reason = a.state === 'not_ready' ? labelFor(a.reason_code) : null;
          const label = reason || t(meta.key, meta.fallback);
          const loggedIn = a.state !== 'logged_out' && a.state !== 'dnd';
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
                <span className="agent-board-timer u-mono">{fmtTimer(elapsedSecs(a, now))}</span>
                {a.queue && a.state === 'on_call' && (
                  <span className="u-row u-gap-1"><PhoneCall size={14} />{t('agent.state.queueLabel', { queue: a.queue })}</span>
                )}
              </div>
              {loggedIn && (
                <div className="agent-board-actions">
                  {(a.state === 'not_ready' || a.state === 'wrap_up') && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => sendAction({ action: 'agent_set_status', status: 'ready', agent: a.extension })}
                    >
                      <Play size={14} />{t('agentBoard.setReady', 'Set Ready')}
                    </button>
                  )}
                  <Popover
                    open={menuFor === a.extension}
                    onOpenChange={(next) => setMenuFor(next ? a.extension : null)}
                    label={t('agentBoard.setNotReady', 'Set Not Ready')}
                    minWidth={190}
                    trigger={({ ref, ...triggerProps }) => (
                      <button {...triggerProps} ref={ref} type="button" className="btn btn-sm" disabled={a.state === 'on_call'}>
                        <Pause size={14} />{t('agentBoard.setNotReady', 'Set Not Ready')}<ChevronDown size={14} />
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
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void logOut(a); }}>
                    <LogOut size={14} />{t('agent.logout', 'Log out')}
                  </button>
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
