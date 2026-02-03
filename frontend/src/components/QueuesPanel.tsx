import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Users, 
  UserPlus, 
  UserMinus, 
  Pause, 
  Play, 
  Phone,
  Clock
} from 'lucide-react';
import type { Queue, QueueMember, QueueEntry, ActionMessage } from '../types';

interface QueuesPanelProps {
  queues: Record<string, Queue>;
  members: Record<string, QueueMember>;
  entries: Record<string, QueueEntry>;
  sendAction: (action: ActionMessage) => void;
}

export function QueuesPanel({ queues, members, entries, sendAction }: QueuesPanelProps) {
  const [showAddMember, setShowAddMember] = useState<string | null>(null);
  const [newMemberInterface, setNewMemberInterface] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [processingPause, setProcessingPause] = useState<Set<string>>(new Set());

  // Clear processing state when members update (state came from server)
  useEffect(() => {
    setProcessingPause(new Set());
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

  const handleRemoveMember = (queueName: string, interfaceName: string) => {
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
    
    setProcessingPause(prev => new Set(prev).add(memberKey));
    
    sendAction({
      action: member.paused ? 'queue_unpause' : 'queue_pause',
      queue: member.queue,
      interface: member.interface,
    });
    
    // Clear processing state after a delay (state update will come from WebSocket)
    setTimeout(() => {
      setProcessingPause(prev => {
        const next = new Set(prev);
        next.delete(memberKey);
        return next;
      });
    }, 1000);
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
          Queues ({queueList.length})
        </h2>
      </div>
      <div className="panel-content">
        {queueList.length === 0 ? (
          <div className="empty-state">
            <Users size={48} className="empty-state-icon" />
            <p className="empty-state-text">No queues configured</p>
          </div>
        ) : (
          <div className="queues-grid">
            <AnimatePresence>
              {queueList.map((queue) => (
                <motion.div
                  key={queue.name}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="queue-card"
                >
                  <div className="queue-header">
                    <span className="queue-name">{queue.name}</span>
                    <span className={`queue-waiting ${queue.calls_waiting === 0 ? 'empty' : ''}`}>
                      <Phone size={14} />
                      {queue.calls_waiting} waiting
                    </span>
                  </div>

                  {/* Queue entries (callers waiting) */}
                  {entriesByQueue[queue.name] && entriesByQueue[queue.name].length > 0 && (
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
                        Callers Waiting
                      </div>
                      {entriesByQueue[queue.name]
                        .sort((a, b) => a.position - b.position)
                        .map((entry, idx) => (
                          <div key={idx} style={{
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
                        Members ({membersByQueue[queue.name]?.length || 0})
                      </span>
                      <button 
                        className="btn btn-icon"
                        onClick={() => setShowAddMember(showAddMember === queue.name ? null : queue.name)}
                        title="Add Member"
                      >
                        <UserPlus size={18} />
                      </button>
                    </div>

                    {/* Add member form */}
                    <AnimatePresence>
                      {showAddMember === queue.name && (
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
                              placeholder="Extension (e.g., 100)"
                              value={newMemberInterface}
                              onChange={(e) => setNewMemberInterface(e.target.value)}
                            />
                          </div>
                          <div className="form-group" style={{ marginBottom: 8 }}>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="Name (optional)"
                              value={newMemberName}
                              onChange={(e) => setNewMemberName(e.target.value)}
                            />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button 
                              className="btn btn-primary"
                              onClick={() => handleAddMember(queue.name)}
                              style={{ flex: 1 }}
                            >
                              Add
                            </button>
                            <button 
                              className="btn"
                              onClick={() => {
                                setShowAddMember(null);
                                setNewMemberInterface('');
                                setNewMemberName('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Members list */}
                    {membersByQueue[queue.name]?.length === 0 && !showAddMember && (
                      <div style={{ 
                        textAlign: 'center', 
                        padding: '20px 0',
                        color: 'var(--text-muted)',
                        fontSize: 13
                      }}>
                        No members in queue
                      </div>
                    )}

                    {membersByQueue[queue.name]?.map((member) => (
                      <div key={member.interface} className="queue-member">
                        <div className="queue-member-info">
                          <div className={`queue-member-status ${
                            member.paused ? 'paused' : 
                            (member.status?.toLowerCase() === 'unavailable' ||
                             member.status?.toLowerCase() === 'invalid' ||
                             member.status === '4' ||
                             member.status === '5') ? 'unavailable' :
                            (member.status?.toLowerCase() === 'in use' || 
                             member.status?.toLowerCase() === 'busy' ||
                             member.status?.toLowerCase() === 'ring+in use' ||
                             member.status === '2' || 
                             member.status === '3') ? 'busy' : ''
                          }`} />
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
                            title={member.paused ? 'Unpause' : 'Pause'}
                            style={processingPause.has(`${member.queue}:${member.interface}`) ? { opacity: 0.6, cursor: 'wait' } : {}}
                          >
                            {member.paused ? <Play size={18} /> : <Pause size={18} />}
                          </button>
                          <button 
                            className="btn btn-icon btn-barge"
                            onClick={() => handleRemoveMember(queue.name, member.interface)}
                            disabled={member.dynamic === false}
                            title={member.dynamic === false 
                              ? "Cannot remove: Member is statically configured in queues.conf. Edit config and reload Asterisk to remove." 
                              : member.dynamic === true
                              ? "Remove from Queue (Dynamic member)"
                              : "Remove from Queue (Will check if removable)"}
                            style={member.dynamic === false ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                          >
                            <UserMinus size={18} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

