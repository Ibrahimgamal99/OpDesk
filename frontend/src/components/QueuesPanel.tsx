import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users,
  UserPlus,
  UserMinus,
  Pause,
  Play,
  Phone,
  Clock,
  RefreshCw,
  UserCheck
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Queue, QueueMember, QueueEntry, Extension, ActionMessage, AgentStateInfo } from '../types';
import { memberBucket, memberExtension, memberState, memberStateClass } from './queueMemberState';
import { AGENT_STATE_META, DEVICE_STATUS_META, StatusBadge, type StatusMeta } from './statusBadge';
import { fmtTimer, parseClock } from '../lib/format';
import { Badge, Dropdown, EmptyState, FormField, Modal, Page, SearchInput, Tabs, Toolbar, useConfirm } from './ui';
import type { DropdownOption } from './ui';
import { countBy, presentOptions, showFilter } from '../lib/filters';
import { getUser } from '../auth';
import { usePauseReasons, WRAPUP_REASON } from '../hooks/usePauseReasons';
import { AgentBoard } from './AgentBoard';
import '../styles/live.css';

interface QueuesPanelProps {
  queues: Record<string, Queue>;
  members: Record<string, QueueMember>;
  entries: Record<string, QueueEntry>;
  /** All monitored extensions, used to populate the Add Member picker. */
  extensions?: Record<string, Extension>;
  /** Agent presence, for the Agents tab. */
  agentStates?: Record<string, AgentStateInfo>;
  sendAction: (action: ActionMessage) => void;
  onSync?: () => void;
}

/**
 * What the Status filter asks of a queue. Not a partition: a queue with callers waiting
 * and nobody ready answers to both, which is exactly the queue a supervisor is hunting.
 *  • waiting — at least one caller in line;
 *  • noReady — no member who could take a call now (all paused, busy or offline);
 *  • idle    — nobody waiting and nobody on a call.
 */
type QueueStatusFilter = 'waiting' | 'noReady' | 'idle';

/** A queue member's live status as a badge: Not Ready (with the reason's label) / Wrap-up /
 *  In Call / Unavailable / Ready, in the same colours the Extensions cards use. The member
 *  carries the reason CODE; `labelFor` names it (a raw code never reaches the screen). */
function memberBadge(
  member: QueueMember,
  t: TFunction,
  labelFor: (code?: string | null) => string | null,
): { meta: StatusMeta; label: string } {
  switch (memberState(member)) {
    case 'paused': {
      if (member.pause_reason === WRAPUP_REASON) {
        return { meta: AGENT_STATE_META.wrap_up, label: t('agent.state.wrapUp', 'Wrap-up') };
      }
      const base = t('agent.state.notReady', 'Not Ready');
      const reason = labelFor(member.pause_reason);
      return { meta: AGENT_STATE_META.not_ready, label: reason ? `${base} · ${reason}` : base };
    }
    case 'unavailable':
      return { meta: DEVICE_STATUS_META.unavailable, label: t('queues.memberUnavailable', 'Unavailable') };
    case 'unknown':
      return { meta: DEVICE_STATUS_META.unavailable, label: t('queues.memberUnknown', 'Unknown') };
    case 'busy':
      return { meta: DEVICE_STATUS_META.in_call, label: t('common.inCall', 'In Call') };
    case 'ringing':
      return { meta: DEVICE_STATUS_META.ringing, label: t(DEVICE_STATUS_META.ringing.key, DEVICE_STATUS_META.ringing.fallback) };
    case 'on_hold':
      return { meta: DEVICE_STATUS_META.on_hold, label: t(DEVICE_STATUS_META.on_hold.key, DEVICE_STATUS_META.on_hold.fallback) };
    default:
      return { meta: AGENT_STATE_META.ready, label: t('agent.state.ready', 'Ready') };
  }
}

export function QueuesPanel({ queues, members, entries, extensions, agentStates, sendAction, onSync }: QueuesPanelProps) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const { selectable, labelFor } = usePauseReasons();
  // Queue membership is a supervisor's tool: the backend refuses add / remove / pause from
  // the agent role, so the controls are not offered there.
  const canManage = getUser()?.role !== 'agent';
  // The member being paused: Not-Ready always names a reason, picked in a small dialog.
  const [pauseTarget, setPauseTarget] = useState<QueueMember | null>(null);
  const [pauseReason, setPauseReason] = useState('');
  // The reason for a member added Not Ready.
  const [newMemberReason, setNewMemberReason] = useState('');
  const [showAddMember, setShowAddMember] = useState<string | null>(null);
  const [newMemberInterface, setNewMemberInterface] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  // Initial login status for the member being added: false = Ready, true = Not Ready (paused).
  const [newMemberPaused, setNewMemberPaused] = useState(false);
  // Map of memberKey -> target paused state of the in-flight pause/unpause action.
  const [processingPause, setProcessingPause] = useState<Map<string, boolean>>(new Map());
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  // The Agents tab is the supervisor's board of the same floor, agent by agent.
  const [tab, setTab] = useState<'queues' | 'agents'>('queues');
  const [agentQuery, setAgentQuery] = useState('');
  const showAgents = canManage && tab === 'agents';

  // When members update from the server, clear processing state only for members
  // that have reached their target paused state — leaves other in-flight actions intact.
  useEffect(() => {
    setProcessingPause(prev => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      let changed = false;
      Object.values(members).forEach(m => {
        const key = `${m.queue}:${m.interface}`;
        if (next.has(key) && m.paused === next.get(key)) {
          next.delete(key);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [members]);

  // The reasons a member may be paused under, each in its colour.
  const reasonOptions: DropdownOption[] = selectable.map(r => ({
    value: r.code,
    label: r.label,
    dotColor: r.color || 'var(--text-muted)',
  }));

  const queueList = Object.values(queues).sort((a, b) => a.name.localeCompare(b.name));

  const resetAddForm = () => {
    setNewMemberInterface('');
    setNewMemberName('');
    setNewMemberPaused(false);
    setNewMemberReason('');
  };

  const handleAddMember = (queueName: string) => {
    if (newMemberPaused && !newMemberReason) return;
    if (newMemberInterface) {
      sendAction({
        action: 'queue_add',
        queue: queueName,
        interface: newMemberInterface,
        membername: newMemberName || undefined,
        // Log the extension into the queue with the chosen status: Ready (unpaused)
        // or Not Ready (paused). Backend maps this to QueueAdd's `paused` flag.
        paused: newMemberPaused,
        // Not Ready always carries a reason, so adherence can split it into work and break.
        ...(newMemberPaused ? { reason: newMemberReason } : {}),
      });
      resetAddForm();
      setShowAddMember(null);
    }
  };

  const handleRemoveMember = async (queueName: string, interfaceName: string, memberLabel: string) => {
    const ok = await confirm({
      title: t('queues.removeTitle', 'Remove member?'),
      message: t('queues.removeConfirm', { member: memberLabel, queue: queueName }),
      confirmLabel: t('common.remove', 'Remove'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (!ok) {
      return;
    }
    sendAction({
      action: 'queue_remove',
      queue: queueName,
      interface: interfaceName,
    });
  };

  const handleTogglePause = (member: QueueMember, reason?: string) => {
    const memberKey = `${member.queue}:${member.interface}`;
    if (processingPause.has(memberKey)) {
      return; // Already processing
    }
    // Pausing needs a reason: ask for one first.
    if (!member.paused && !reason) {
      setPauseReason('');
      setPauseTarget(member);
      return;
    }

    const target = !member.paused;
    setProcessingPause(prev => new Map(prev).set(memberKey, target));

    // Ready / Not Ready is the agent's presence, not one queue's: it applies to every queue
    // the agent is in, exactly as the agent's own status bar does. A per-queue pause left the
    // agent Not Ready while still taking calls from the other queues.
    const agent = memberExtension(member.interface);
    sendAction(member.paused
      ? { action: 'agent_set_status', status: 'ready', agent }
      : { action: 'agent_set_status', status: 'not_ready', reason_code: reason, agent });

    // Fallback: clear processing state if no WebSocket update arrives.
    setTimeout(() => {
      setProcessingPause(prev => {
        if (!prev.has(memberKey)) return prev;
        const next = new Map(prev);
        next.delete(memberKey);
        return next;
      });
    }, 5000);
  };

  // Group entries by queue
  const entriesByQueue: Record<string, QueueEntry[]> = {};
  Object.values(entries).forEach(entry => {
    if (!entriesByQueue[entry.queue]) {
      entriesByQueue[entry.queue] = [];
    }
    entriesByQueue[entry.queue].push(entry);
  });

  // Group members by queue
  const membersByQueue: Record<string, QueueMember[]> = {};
  Object.values(members).forEach(member => {
    if (!membersByQueue[member.queue]) {
      membersByQueue[member.queue] = [];
    }
    membersByQueue[member.queue].push(member);
  });

  // Selectable extensions for the Add Member picker, excluding those already in the queue.
  const extOptions = (queueExt: string) => {
    const already = new Set((membersByQueue[queueExt] || []).map(m => memberExtension(m.interface)));
    return Object.values(extensions || {})
      .filter(e => !already.has(e.extension))
      .map(e => ({ ext: e.extension, name: e.name, status: e.status }))
      .sort((a, b) => a.ext.localeCompare(b.ext, undefined, { numeric: true }));
  };

  // ── Filters (client-side, over the live state this page already has) ──
  // Every member of any queue, once, by extension: the Agent filter's options.
  const agentNames: Record<string, string> = {};
  Object.values(members).forEach(m => {
    const ext = memberExtension(m.interface);
    agentNames[ext] = agentNames[ext] || m.membername || extensions?.[ext]?.name || '';
  });
  const agentOptions = presentOptions(Object.keys(agentNames)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(ext => ({ value: ext, label: agentNames[ext] && agentNames[ext] !== ext ? `${ext} — ${agentNames[ext]}` : ext })),
  countBy(queueList, q => [...new Set((membersByQueue[q.extension ?? q.name] ?? []).map(m => memberExtension(m.interface)))]),
  agentFilter);

  const matchesStatus = (queue: Queue, queueExt: string, filter: string): boolean => {
    const qMembers = membersByQueue[queueExt] ?? [];
    switch (filter as QueueStatusFilter) {
      case 'waiting': return queue.calls_waiting > 0;
      case 'noReady': return !qMembers.some(m => memberState(m) === 'available');
      case 'idle': return queue.calls_waiting === 0 && !qMembers.some(m => memberBucket(m) === 'busy');
      default: return true;
    }
  };

  // Only the statuses some queue is in right now, each with how many queues match.
  const statusOptions = presentOptions(([
    { value: 'waiting', label: t('queues.filter.waiting', 'Has callers waiting'), dot: 'orange' },
    { value: 'noReady', label: t('queues.filter.noReady', 'No agents ready'), dot: 'red' },
    { value: 'idle', label: t('queues.filter.idle', 'Idle'), dot: 'neutral' },
  ] as DropdownOption[]), countBy(queueList, q => (['waiting', 'noReady', 'idle'] as const)
    .filter(f => matchesStatus(q, q.extension ?? q.name, f))), statusFilter);

  const term = query.trim().toLowerCase();
  const shownQueues = queueList.filter(queue => {
    const queueExt = queue.extension ?? queue.name;
    if (term && !queue.name.toLowerCase().includes(term) && !(queue.extension ?? '').toLowerCase().includes(term)) return false;
    if (statusFilter && !matchesStatus(queue, queueExt, statusFilter)) return false;
    if (agentFilter && !(membersByQueue[queueExt] ?? []).some(m => memberExtension(m.interface) === agentFilter)) return false;
    return true;
  });
  const filtering = Boolean(term || statusFilter || agentFilter);
  const clearFilters = () => { setQuery(''); setStatusFilter(''); setAgentFilter(''); };

  return (
    <Page
      icon={Users}
      title={t('nav.queues')}
      count={queueList.length}
      actions={onSync && (
        <button type="button" className="btn btn-ghost" onClick={onSync} title={t('common.syncAll')}>
          <RefreshCw size={14} />
          {t('common.sync')}
        </button>
      )}
      tabs={canManage && (
        <Tabs
          ariaLabel={t('nav.queues')}
          active={tab}
          onChange={(k) => setTab(k as 'queues' | 'agents')}
          tabs={[
            { key: 'queues', label: t('nav.queues'), icon: <Users size={14} />, count: queueList.length },
            { key: 'agents', label: t('agentBoard.tab', 'Agents'), icon: <UserCheck size={14} /> },
          ]}
        />
      )}
      toolbar={showAgents ? (
        <Toolbar
          search={
            <SearchInput
              value={agentQuery}
              onChange={setAgentQuery}
              debounceMs={0}
              label={t('agentBoard.search', 'Search agents')}
              placeholder={t('agentBoard.searchPlaceholder', 'Search by name or extension')}
            />
          }
        />
      ) : (
        <Toolbar
          search={
            <SearchInput
              value={query}
              onChange={setQuery}
              debounceMs={0}
              label={t('queues.search', 'Search queues')}
              placeholder={t('queues.searchPlaceholder', 'Search by queue name or number')}
            />
          }
          filters={
            <>
              {showFilter(statusOptions, statusFilter) && (
                <div data-active={statusFilter || undefined}>
                  <Dropdown
                    value={statusFilter}
                    onChange={setStatusFilter}
                    size="md"
                    ariaLabel={t('common.status')}
                    options={[{ value: '', label: t('common.allStatuses', 'All statuses') }, ...statusOptions]}
                  />
                </div>
              )}
              {showFilter(agentOptions, agentFilter) && (
                <div data-active={agentFilter || undefined}>
                  <Dropdown
                    value={agentFilter}
                    onChange={setAgentFilter}
                    size="md"
                    searchable
                    icon={Users}
                    ariaLabel={t('fields.agent', 'Agent')}
                    searchPlaceholder={t('queues.filter.agentSearch', 'Find an agent')}
                    options={[{ value: '', label: t('queues.filter.allAgents', 'All agents') }, ...agentOptions]}
                  />
                </div>
              )}
            </>
          }
          actions={filtering && (
            <span className="u-text-sm u-fg-muted">
              {t('queues.filter.matches', { shown: shownQueues.length, total: queueList.length, defaultValue: '{{shown}} of {{total}}' })}
            </span>
          )}
        />
      )}
    >
      {showAgents ? (
        <AgentBoard agentStates={agentStates || {}} extensions={extensions || {}} query={agentQuery} sendAction={sendAction} />
      ) : queueList.length === 0 ? (
        <EmptyState icon={Users} title={t('queues.noQueues')} />
      ) : shownQueues.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('queues.noMatchesTitle', 'No matching queues')}
          description={t('queues.noMatches', 'No queues match these filters.')}
          action={<button type="button" className="btn" onClick={clearFilters}>{t('common.clearFilters', 'Clear filters')}</button>}
        />
      ) : (
        <div className="queues-grid">
          <AnimatePresence>
            {shownQueues.map((queue) => {
              const queueExt = queue.extension ?? queue.name;
              const waitingEntries = entriesByQueue[queueExt] ?? [];
              return (
                <motion.div
                  key={queueExt}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="queue-card"
                >
                  <div className="queue-header">
                    <span className="queue-name">
                      {queue.extension != null && queue.extension !== queue.name
                        ? `${queue.extension} ${queue.name}`
                        : queue.name}
                    </span>
                    <Badge tone={queue.calls_waiting === 0 ? 'success' : 'warning'} icon={<Phone size={14} />}>
                      {t('queues.waiting', { count: queue.calls_waiting })}
                    </Badge>
                  </div>

                  {/* Queue entries (callers waiting) */}
                  {waitingEntries.length > 0 && (
                    <div className="queue-callers">
                      <div className="queue-callers-title">
                        <Clock size={14} />
                        {t('queues.callersWaiting')}
                      </div>
                      {waitingEntries
                        .sort((a, b) => a.position - b.position)
                        .map((entry) => (
                          <div key={`${entry.callerid}-${entry.position}`} className="queue-caller u-mono">
                            <span>#{entry.position} {entry.callerid}</span>
                            <span className="u-fg-muted">{entry.wait_time ? fmtTimer(parseClock(entry.wait_time)) : '—'}</span>
                          </div>
                        ))}
                    </div>
                  )}

                  {/* Queue members */}
                  <div className="queue-members">
                    <div className="u-row u-between u-mb-3">
                      <span className="u-text-xs u-upper u-fg-muted">
                        {t('queues.members', { count: membersByQueue[queueExt]?.length || 0 })}
                      </span>
                      {canManage && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => { resetAddForm(); setShowAddMember(queueExt); }}
                          title={t('queues.addMember')}
                          aria-label={t('queues.addMember')}
                        >
                          <UserPlus size={14} />
                        </button>
                      )}
                    </div>

                    {/* Members list */}
                    {(membersByQueue[queueExt]?.length ?? 0) === 0 && (
                      <EmptyState size="sm" icon={Users} title={t('queues.noMembers')} />
                    )}

                    {membersByQueue[queueExt]?.map((member) => {
                      const processing = processingPause.has(`${member.queue}:${member.interface}`);
                      const badge = memberBadge(member, t, labelFor);
                      return (
                        <div key={member.interface} className="queue-member">
                          <div className="queue-member-info">
                            <div className={`queue-member-status ${memberStateClass(member)}`} />
                            <div>
                              <div className="queue-member-name">
                                {member.membername || member.interface}
                                <StatusBadge meta={badge.meta} label={badge.label} className="queue-member-badge" />
                              </div>
                              <div className="queue-member-interface">
                                {member.interface}
                              </div>
                            </div>
                          </div>
                          {canManage && (
                          <div className="queue-member-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm btn-icon"
                              onClick={() => handleTogglePause(member)}
                              disabled={processing}
                              aria-busy={processing}
                              title={member.paused ? t('queues.unpause') : t('common.pause')}
                              aria-label={member.paused ? t('queues.unpause') : t('common.pause')}
                            >
                              {member.paused ? <Play size={14} /> : <Pause size={14} />}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-danger btn-sm btn-icon"
                              aria-label={t('queues.removeMember', 'Remove member')}
                              onClick={() => handleRemoveMember(queueExt, member.interface, member.membername || member.interface)}
                              disabled={member.dynamic === false}
                              title={member.dynamic === false
                                ? t('queues.removeStatic')
                                : member.dynamic === true
                                ? t('queues.removeDynamic')
                                : t('queues.removeCheck')}
                            >
                              <UserMinus size={14} />
                            </button>
                          </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
      {/* Adding a member is creating a record, so it opens the shared Modal like every
          other add flow, instead of unfolding a form inside the queue card. */}
      {showAddMember !== null && (
        <Modal
          open
          onClose={() => { setShowAddMember(null); resetAddForm(); }}
          icon={<UserPlus size={16} />}
          title={t('queues.addMemberTo', { queue: showAddMember, defaultValue: 'Add member to {{queue}}' })}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => { setShowAddMember(null); resetAddForm(); }}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handleAddMember(showAddMember)}
                disabled={!newMemberInterface || (newMemberPaused && !newMemberReason)}
              >
                {t('common.logIn')}
              </button>
            </>
          )}
        >
          <FormField label={t('fields.extension', 'Extension')} required>
            <Dropdown
              size="md"
              searchable
              options={extOptions(showAddMember).map(o => ({
                value: o.ext,
                label: o.name ? `${o.ext} — ${o.name}` : o.ext,
              }))}
              value={newMemberInterface}
              onChange={ext => {
                setNewMemberInterface(ext);
                setNewMemberName(extOptions(showAddMember).find(o => o.ext === ext)?.name || '');
              }}
              placeholder={t('queues.selectExtension')}
              emptyMessage={t('queues.noExtensions')}
              searchPlaceholder={t('queues.selectExtension')}
            />
          </FormField>
          <FormField label={t('fields.name', 'Name')} htmlFor="queue-member-name">
            <input
              id="queue-member-name"
              type="text"
              className="form-input"
              placeholder={t('queues.namePlaceholder')}
              value={newMemberName}
              onChange={(e) => setNewMemberName(e.target.value)}
            />
          </FormField>
          {/* Initial login status: Ready (unpaused) or Not Ready (paused). */}
          <FormField label={t('queues.loginStatus')}>
            <div className="ui-segmented ui-segmented--block" role="group" aria-label={t('queues.loginStatus')}>
              <button
                type="button"
                className={`btn${!newMemberPaused ? ' is-selected' : ''}`}
                aria-pressed={!newMemberPaused}
                onClick={() => setNewMemberPaused(false)}
              >
                <Play size={14} />
                {t('agent.state.ready')}
              </button>
              <button
                type="button"
                className={`btn${newMemberPaused ? ' is-selected' : ''}`}
                aria-pressed={newMemberPaused}
                onClick={() => setNewMemberPaused(true)}
              >
                <Pause size={14} />
                {t('agent.state.notReady')}
              </button>
            </div>
          </FormField>
          {newMemberPaused && (
            <FormField label={t('queues.pauseReason', 'Reason')} required>
              <Dropdown
                size="md"
                options={reasonOptions}
                value={newMemberReason}
                onChange={setNewMemberReason}
                placeholder={t('queues.pickReason', 'Pick a reason')}
                emptyMessage={t('agent.noReasons', 'No reason codes')}
                ariaLabel={t('queues.pauseReason', 'Reason')}
              />
            </FormField>
          )}
        </Modal>
      )}
      {pauseTarget && (
        <Modal
          open
          onClose={() => setPauseTarget(null)}
          icon={<Pause size={16} />}
          title={t('queues.pauseTitle', {
            member: pauseTarget.membername || memberExtension(pauseTarget.interface),
            defaultValue: 'Set {{member}} Not Ready',
          })}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setPauseTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!pauseReason}
                onClick={() => {
                  const member = pauseTarget;
                  setPauseTarget(null);
                  handleTogglePause(member, pauseReason);
                }}
              >
                <Pause size={14} />
                {t('common.pause')}
              </button>
            </>
          )}
        >
          <FormField label={t('queues.pauseReason', 'Reason')} required hint={t('queues.pauseHint', 'Not Ready is always recorded with a reason, so adherence can tell work from breaks.')}>
            <Dropdown
              size="md"
              options={reasonOptions}
              value={pauseReason}
              onChange={setPauseReason}
              placeholder={t('queues.pickReason', 'Pick a reason')}
              emptyMessage={t('agent.noReasons', 'No reason codes')}
              ariaLabel={t('queues.pauseReason', 'Reason')}
            />
          </FormField>
        </Modal>
      )}
      {confirmDialog}
    </Page>
  );
}
