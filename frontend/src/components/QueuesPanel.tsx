import { useState, useEffect, useRef } from 'react';
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
  Search,
  Check
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Queue, QueueMember, QueueEntry, Extension, ActionMessage } from '../types';

interface QueuesPanelProps {
  queues: Record<string, Queue>;
  members: Record<string, QueueMember>;
  entries: Record<string, QueueEntry>;
  /** All monitored extensions, used to populate the Add Member picker. */
  extensions?: Record<string, Extension>;
  sendAction: (action: ActionMessage) => void;
  onSync?: () => void;
}

/** Searchable extension picker for the Add Member form. Filters by extension
 *  number or name; picking one fills in the interface + member name upstream. */
function ExtensionPicker({
  options,
  selected,
  onPick,
  placeholder,
  emptyText,
}: {
  options: { ext: string; name?: string; status?: string }[];
  selected: string;
  onPick: (ext: string, name?: string) => void;
  placeholder: string;
  emptyText: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = options
    .filter(o => !q || o.ext.toLowerCase().includes(q) || (o.name || '').toLowerCase().includes(q))
    .slice(0, 50);

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search
          size={14}
          style={{ position: 'absolute', top: '50%', insetInlineStart: 10, transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}
        />
        <input
          type="text"
          className="form-input"
          style={{ paddingInlineStart: 30 }}
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            insetInlineStart: 0,
            insetInlineEnd: 0,
            maxHeight: 200,
            overflowY: 'auto',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            zIndex: 'var(--z-dropdown)',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)' }}>{emptyText}</div>
          ) : (
            filtered.map(o => (
              <div
                key={o.ext}
                onClick={() => { onPick(o.ext, o.name); setQuery(o.name ? `${o.ext} — ${o.name}` : o.ext); setOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 12px',
                  fontSize: 13,
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  background: selected === o.ext ? 'var(--bg-tertiary)' : 'transparent',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = selected === o.ext ? 'var(--bg-tertiary)' : 'transparent')}
              >
                <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {o.ext}
                  {o.name && <span style={{ color: 'var(--text-muted)', marginInlineStart: 8, fontFamily: 'inherit' }}>{o.name}</span>}
                </span>
                {selected === o.ext && <Check size={14} style={{ color: 'var(--status-success, var(--accent-primary))' }} />}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Map a queue member's status/paused state to a CSS modifier class.
 *  Asterisk reports status either as a name ("In Use") or a numeric device-state code. */
function memberStatusClass(member: QueueMember): string {
  if (member.paused) return 'paused';
  const s = member.status?.toLowerCase();
  if (s === 'unavailable' || s === 'invalid' || member.status === '4' || member.status === '5') {
    return 'unavailable';
  }
  if (s === 'in use' || s === 'busy' || s === 'ring+in use' || member.status === '2' || member.status === '3') {
    return 'busy';
  }
  return '';
}

/** Readable status label for a queue member — mirrors the extension-card status
 *  effect: Not-Ready (with reason) / In Call / Unavailable / Ready. */
function memberStatusLabel(
  member: QueueMember,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  if (member.paused) {
    const base = t('queues.notReady', { defaultValue: 'Not Ready' });
    return member.pause_reason ? `${base} · ${member.pause_reason}` : base;
  }
  const cls = memberStatusClass(member);
  if (cls === 'unavailable') return t('queues.memberUnavailable', { defaultValue: 'Unavailable' });
  if (cls === 'busy') return t('queues.memberInCall', { defaultValue: 'In Call' });
  return t('queues.memberReady', { defaultValue: 'Ready' });
}

export function QueuesPanel({ queues, members, entries, extensions, sendAction, onSync }: QueuesPanelProps) {
  const { t } = useTranslation();
  const [showAddMember, setShowAddMember] = useState<string | null>(null);
  const [newMemberInterface, setNewMemberInterface] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  // Initial login status for the member being added: false = Ready, true = Not Ready (paused).
  const [newMemberPaused, setNewMemberPaused] = useState(false);
  // Map of memberKey -> target paused state of the in-flight pause/unpause action.
  const [processingPause, setProcessingPause] = useState<Map<string, boolean>>(new Map());

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

  const handleRemoveMember = (queueName: string, interfaceName: string, memberLabel: string) => {
    if (!window.confirm(t('queues.removeConfirm', { member: memberLabel, queue: queueName }))) {
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

  // Bare extension number for a member interface, e.g. "PJSIP/100" -> "100".
  const memberExt = (iface: string) => (iface.includes('/') ? iface.split('/').pop() || iface : iface);

  // Selectable extensions for the Add Member picker, excluding those already in the queue.
  const extOptions = (queueExt: string) => {
    const already = new Set((membersByQueue[queueExt] || []).map(m => memberExt(m.interface)));
    return Object.values(extensions || {})
      .filter(e => !already.has(e.extension))
      .map(e => ({ ext: e.extension, name: e.name, status: e.status }))
      .sort((a, b) => a.ext.localeCompare(b.ext, undefined, { numeric: true }));
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <Users size={18} className="panel-title-icon" />
          {t('queues.title')} ({queueList.length})
        </h2>
        {onSync && (
          <button type="button" className="btn btn-panel-sync" onClick={onSync} title={t('queues.syncAll')}>
            <RefreshCw size={14} />
            {t('queues.sync')}
          </button>
        )}
      </div>
      <div className="panel-content">
        {queueList.length === 0 ? (
          <div className="empty-state">
            <Users size={48} className="empty-state-icon" />
            <p className="empty-state-text">{t('queues.noQueues')}</p>
          </div>
        ) : (
          <div className="queues-grid">
            <AnimatePresence>
              {queueList.map((queue) => {
              const queueExt = queue.extension ?? queue.name;
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
                    <span className={`queue-waiting ${queue.calls_waiting === 0 ? 'empty' : ''}`}>
                      <Phone size={14} />
                      {t('queues.waiting', { count: queue.calls_waiting })}
                    </span>
                  </div>

                  {/* Queue entries (callers waiting) */}
                  {entriesByQueue[queueExt] && entriesByQueue[queueExt].length > 0 && (
                    <div style={{
                      padding: '12px 16px',
                      borderBottom: '1px solid var(--border-primary)',
                      background: 'rgba(245, 158, 11, 0.05)'
                    }}>
                      <div style={{
                        fontSize: 11,
                        color: 'var(--status-ringing)',
                        fontWeight: 600,
                        marginBottom: 8,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6
                      }}>
                        <Clock size={14} />
                        {t('queues.callersWaiting')}
                      </div>
                      {entriesByQueue[queueExt]
                        .sort((a, b) => a.position - b.position)
                        .map((entry) => (
                          <div key={`${entry.callerid}-${entry.position}`} style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '6px 0',
                            fontSize: 12,
                            color: 'var(--text-secondary)',
                            fontFamily: 'JetBrains Mono, monospace'
                          }}>
                            <span>#{entry.position} {entry.callerid}</span>
                            <span style={{ color: 'var(--text-muted)' }}>{entry.wait_time || '—'}</span>
                          </div>
                        ))}
                    </div>
                  )}

                  {/* Queue members */}
                  <div className="queue-members">
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 12
                    }}>
                      <span style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                      }}>
                        {t('queues.members', { count: membersByQueue[queueExt]?.length || 0 })}
                      </span>
                      <button
                        className="btn btn-icon"
                        onClick={() => setShowAddMember(showAddMember === queueExt ? null : queueExt)}
                        title={t('queues.addMember')}
                      >
                        <UserPlus size={18} />
                      </button>
                    </div>

                    {/* Add member form */}
                    <AnimatePresence>
                      {showAddMember === queueExt && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          style={{
                            marginBottom: 12,
                            padding: 12,
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-sm)',
                            overflow: 'hidden'
                          }}
                        >
                          <div className="form-group" style={{ marginBottom: 8 }}>
                            <ExtensionPicker
                              options={extOptions(queueExt)}
                              selected={newMemberInterface}
                              onPick={(ext, name) => {
                                setNewMemberInterface(ext);
                                setNewMemberName(name || '');
                              }}
                              placeholder={t('queues.selectExtension')}
                              emptyText={t('queues.noExtensions')}
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: 8 }}>
                            <input
                              type="text"
                              className="form-input"
                              placeholder={t('queues.namePlaceholder')}
                              value={newMemberName}
                              onChange={(e) => setNewMemberName(e.target.value)}
                            />
                          </div>
                          {/* Initial login status for the extension being added. */}
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                              {t('queues.loginStatus')}
                            </div>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                className={`btn ${!newMemberPaused ? 'btn-primary' : ''}`}
                                onClick={() => setNewMemberPaused(false)}
                                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                              >
                                <Play size={14} />
                                {t('queues.statusReady')}
                              </button>
                              <button
                                type="button"
                                className={`btn ${newMemberPaused ? 'btn-listen' : ''}`}
                                onClick={() => setNewMemberPaused(true)}
                                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                              >
                                <Pause size={14} />
                                {t('queues.statusNotReady')}
                              </button>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              className="btn btn-primary"
                              onClick={() => handleAddMember(queueExt)}
                              disabled={!newMemberInterface}
                              style={{ flex: 1, ...(newMemberInterface ? {} : { opacity: 0.5, cursor: 'not-allowed' }) }}
                            >
                              {t('queues.login')}
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                setShowAddMember(null);
                                resetAddForm();
                              }}
                            >
                              {t('queues.cancel')}
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Members list */}
                    {membersByQueue[queueExt]?.length === 0 && !showAddMember && (
                      <div style={{
                        textAlign: 'center',
                        padding: '20px 0',
                        color: 'var(--text-muted)',
                        fontSize: 13
                      }}>
                        {t('queues.noMembers')}
                      </div>
                    )}

                    {membersByQueue[queueExt]?.map((member) => (
                      <div key={member.interface} className="queue-member">
                        <div className="queue-member-info">
                          <div className={`queue-member-status ${memberStatusClass(member)}`} />
                          <div>
                            <div className="queue-member-name">
                              {member.membername || member.interface}
                              <span className={`queue-member-badge ${memberStatusClass(member) || 'ready'}`}>
                                {memberStatusLabel(member, t)}
                              </span>
                            </div>
                            <div className="queue-member-interface">
                              {member.interface}
                            </div>
                          </div>
                        </div>
                        <div className="queue-member-actions">
                          <button
                            className={`btn btn-icon ${member.paused ? 'btn-listen' : ''}`}
                            onClick={() => handleTogglePause(member)}
                            disabled={processingPause.has(`${member.queue}:${member.interface}`)}
                            title={member.paused ? t('queues.unpause') : t('queues.pause')}
                            style={processingPause.has(`${member.queue}:${member.interface}`) ? { opacity: 0.6, cursor: 'wait' } : {}}
                          >
                            {member.paused ? <Play size={18} /> : <Pause size={18} />}
                          </button>
                          <button
                            className="btn btn-icon btn-barge"
                            onClick={() => handleRemoveMember(queueExt, member.interface, member.membername || member.interface)}
                            disabled={member.dynamic === false}
                            title={member.dynamic === false
                              ? t('queues.removeStatic')
                              : member.dynamic === true
                              ? t('queues.removeDynamic')
                              : t('queues.removeCheck')}
                            style={member.dynamic === false ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                          >
                            <UserMinus size={18} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              );
            })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
