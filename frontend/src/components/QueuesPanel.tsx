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
  RefreshCw
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Queue, QueueMember, QueueEntry, Extension, ActionMessage } from '../types';
import { memberExtension, memberState, memberStateClass } from './queueMemberState';
import { AGENT_STATE_META, DEVICE_STATUS_META, StatusBadge, type StatusMeta } from './statusBadge';
import { fmtTimer, parseClock } from '../lib/format';
import { Badge, Dropdown, EmptyState, FormField, Modal, Page, SearchInput, Toolbar, useConfirm } from './ui';
import type { DropdownOption } from './ui';
import { countBy, presentOptions, showFilter } from '../lib/filters';
import '../styles/live.css';

interface QueuesPanelProps {
  queues: Record<string, Queue>;
  members: Record<string, QueueMember>;
  entries: Record<string, QueueEntry>;
  /** All monitored extensions, used to populate the Add Member picker. */
  extensions?: Record<string, Extension>;
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

/** A queue member's live status as a badge: Not Ready (with reason) / In Call / Unavailable /
 *  Ready, in the same colours the Extensions cards use for the same states. */
function memberBadge(member: QueueMember, t: TFunction): { meta: StatusMeta; label: string } {
  switch (memberState(member)) {
    case 'paused': {
      const base = t('agent.state.notReady', 'Not Ready');
      return { meta: AGENT_STATE_META.not_ready, label: member.pause_reason ? `${base} · ${member.pause_reason}` : base };
    }
    case 'unavailable':
      return { meta: DEVICE_STATUS_META.unavailable, label: t('queues.memberUnavailable', 'Unavailable') };
    case 'busy':
      return { meta: DEVICE_STATUS_META.in_call, label: t('common.inCall', 'In Call') };
    default:
      return { meta: AGENT_STATE_META.ready, label: t('agent.state.ready', 'Ready') };
  }
}

export function QueuesPanel({ queues, members, entries, extensions, sendAction, onSync }: QueuesPanelProps) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
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

  const queueList = Object.values(queues).sort((a, b) => a.name.localeCompare(b.name));

  const resetAddForm = () => {
    setNewMemberInterface('');
    setNewMemberName('');
    setNewMemberPaused(false);
  };

  const handleAddMember = (queueName: string) => {
    if (newMemberInterface) {
      sendAction({
        action: 'queue_add',
        queue: queueName,
        interface: newMemberInterface,
        membername: newMemberName || undefined,
        // Log the extension into the queue with the chosen status: Ready (unpaused)
        // or Not Ready (paused). Backend maps this to QueueAdd's `paused` flag.
        paused: newMemberPaused,
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

  const handleTogglePause = (member: QueueMember) => {
    const memberKey = `${member.queue}:${member.interface}`;
    if (processingPause.has(memberKey)) {
      return; // Already processing
    }

    const target = !member.paused;
    setProcessingPause(prev => new Map(prev).set(memberKey, target));

    sendAction({
      action: member.paused ? 'queue_unpause' : 'queue_pause',
      queue: member.queue,
      interface: member.interface,
    });

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
      case 'idle': return queue.calls_waiting === 0 && !qMembers.some(m => memberState(m) === 'busy');
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
      toolbar={
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
      }
    >
      {queueList.length === 0 ? (
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
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm btn-icon"
                        onClick={() => { resetAddForm(); setShowAddMember(queueExt); }}
                        title={t('queues.addMember')}
                        aria-label={t('queues.addMember')}
                      >
                        <UserPlus size={14} />
                      </button>
                    </div>

                    {/* Members list */}
                    {(membersByQueue[queueExt]?.length ?? 0) === 0 && (
                      <EmptyState size="sm" icon={Users} title={t('queues.noMembers')} />
                    )}

                    {membersByQueue[queueExt]?.map((member) => {
                      const processing = processingPause.has(`${member.queue}:${member.interface}`);
                      const badge = memberBadge(member, t);
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
                disabled={!newMemberInterface}
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
        </Modal>
      )}
      {confirmDialog}
    </Page>
  );
}
