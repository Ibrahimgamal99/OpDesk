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
import type { Queue, QueueMember, QueueEntry, ActionMessage } from '../types';

interface QueuesPanelProps {
  queues: Record<string, Queue>;
  members: Record<string, QueueMember>;
  entries: Record<string, QueueEntry>;
  sendAction: (action: ActionMessage) => void;
  onSync?: () => void;
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

export function QueuesPanel({ queues, members, entries, sendAction, onSync }: QueuesPanelProps) {
  const { t } = useTranslation();
  const [showAddMember, setShowAddMember] = useState<string | null>(null);
  const [newMemberInterface, setNewMemberInterface] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
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

  const handleAddMember = (queueName: string) => {
    if (newMemberInterface) {
      sendAction({
        action: 'queue_add',
        queue: queueName,
        interface: newMemberInterface,
        membername: newMemberName || undefined,
      });
      setNewMemberInterface('');
      setNewMemberName('');
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
                            <input
                              type="text"
                              className="form-input"
                              placeholder={t('queues.extensionPlaceholder')}
                              value={newMemberInterface}
                              onChange={(e) => setNewMemberInterface(e.target.value)}
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
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              className="btn btn-primary"
                              onClick={() => handleAddMember(queueExt)}
                              style={{ flex: 1 }}
                            >
                              {t('queues.add')}
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                setShowAddMember(null);
                                setNewMemberInterface('');
                                setNewMemberName('');
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
