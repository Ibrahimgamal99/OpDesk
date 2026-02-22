import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Save, Loader2, CheckCircle2, AlertCircle, Users, UserPlus, Pencil, Trash2, Shield,
  Phone, List, ChevronDown, Group,
} from 'lucide-react';
import { getAuthHeaders, getUser } from '../auth';

export interface OpDeskGroup {
  id: number;
  name: string;
  agent_extensions: string[];
  queues: { extension: string; queue_name: string }[];
  user_ids: number[];
}

interface AgentOption {
  extension: string;
  name: string;
}

interface QueueOption {
  extension: string;
  queue_name: string;
}

interface UserOption {
  id: number;
  username: string;
}

function MultiSelectDropdown<T extends string>({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  emptyMessage = 'No options',
}: {
  options: { value: T; label: string }[];
  value: T[];
  onChange: (value: T[]) => void;
  placeholder?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [listStyle, setListStyle] = useState<React.CSSProperties | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const updateListPosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setListStyle({
      position: 'fixed' as const,
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxHeight: 220,
      overflowY: 'auto' as const,
      overflowX: 'hidden' as const,
      overscrollBehavior: 'contain',
      WebkitOverflowScrolling: 'touch',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      zIndex: 10000,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setListStyle(null);
      return;
    }
    updateListPosition();
    const onScrollOrResize = () => updateListPosition();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, updateListPosition]);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      const el = e.target as Node;
      if (containerRef.current?.contains(el) || listRef.current?.contains(el)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const filtered = filter.trim()
    ? options.filter(o => o.label.toLowerCase().includes(filter.toLowerCase()) || o.value.toLowerCase().includes(filter.toLowerCase()))
    : options;

  const toggle = (v: T) => {
    if (value.includes(v)) onChange(value.filter(x => x !== v));
    else onChange([...value, v]);
  };

  const clearAll = () => {
    onChange([]);
    setFilter('');
  };

  const boxStyle: React.CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    minHeight: 38,
    padding: '6px 8px 6px 10px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    position: 'relative',
  };

  const tagStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-accent)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    color: 'var(--text-primary)',
  };

  const selectedLabels = value.map(v => options.find(o => o.value === v)?.label ?? v);

  const listbox = open && listStyle ? (
    <div
      ref={listRef}
      role="listbox"
      style={listStyle}
      onClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {filtered.length === 0 ? (
        <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13 }}>{emptyMessage}</div>
      ) : (
        filtered.map(opt => (
          <div
            key={opt.value}
            role="option"
            aria-selected={value.includes(opt.value)}
            onClick={() => toggle(opt.value)}
            style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, background: value.includes(opt.value) ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-primary)' }}
          >
            {opt.label}
          </div>
        ))
      )}
    </div>
  ) : null;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        style={boxStyle}
        onClick={() => setOpen(o => !o)}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          {selectedLabels.map((label, i) => (
            <span key={value[i]} style={tagStyle} onClick={e => e.stopPropagation()}>
              {label}
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-muted)', lineHeight: 1, display: 'flex' }}
                aria-label="Remove"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {open && (
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              onClick={e => e.stopPropagation()}
              placeholder={placeholder}
              style={{ flex: 1, minWidth: 80, border: 'none', background: 'transparent', color: 'var(--text-primary)', outline: 'none', fontSize: 13 }}
              autoFocus
            />
          )}
          {!open && value.length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{placeholder}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {value.length > 0 && (
            <button type="button" onClick={e => { e.stopPropagation(); clearAll(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-muted)', display: 'flex' }} aria-label="Clear all">
              <X size={14} />
            </button>
          )}
          <ChevronDown size={16} style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
      </div>
      {listbox && createPortal(listbox, document.body)}
    </div>
  );
}

export interface GroupsPanelProps {
  /** When set, open create form and pre-fill group name (e.g. from Users "Create new group" flow). */
  initialGroupName?: string;
  /** Called after applying initialGroupName so parent can clear the intent. */
  onConsumeIntent?: () => void;
}

export function GroupsPanel(props: GroupsPanelProps) {
  const { initialGroupName, onConsumeIntent } = props;
  const currentUser = getUser();
  const isAdmin = currentUser?.role === 'admin';
  const [groups, setGroups] = useState<OpDeskGroup[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [queues, setQueues] = useState<QueueOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingGroup, setEditingGroup] = useState<OpDeskGroup | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<number | null>(null);
  const [groupsSubTab, setGroupsSubTab] = useState<'create' | 'list'>('create');
  const [form, setForm] = useState({
    name: '',
    agent_extensions: [] as string[],
    queue_extensions: [] as string[],
    user_ids: [] as string[],
  });

  // Open create form with name pre-filled when arriving from Users "Create new group"
  useEffect(() => {
    if (initialGroupName === undefined || !onConsumeIntent) return;
    setGroupsSubTab('create');
    setEditingGroup(null);
    setForm(prev => ({ ...prev, name: initialGroupName }));
    onConsumeIntent();
  }, [initialGroupName, onConsumeIntent]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [groupsRes, agentsRes, queuesRes, usersRes] = await Promise.all([
        fetch('/api/settings/groups', { headers: getAuthHeaders() }),
        fetch('/api/settings/agents', { headers: getAuthHeaders() }),
        fetch('/api/settings/queues', { headers: getAuthHeaders() }),
        fetch('/api/settings/users', { headers: getAuthHeaders() }),
      ]);
      if (groupsRes.ok) {
        const d = await groupsRes.json();
        setGroups(d.groups || []);
      }
      if (agentsRes.ok) {
        const d = await agentsRes.json();
        setAgents(d.agents || []);
      }
      if (queuesRes.ok) {
        const d = await queuesRes.json();
        setQueues(d.queues || []);
      }
      if (usersRes.ok) {
        const d = await usersRes.json();
        setUsers((d.users || []).map((u: { id: number; username: string }) => ({ id: u.id, username: u.username })));
      }
      if (!groupsRes.ok && groupsRes.status === 403) {
        setMessage({ type: 'error', text: 'Admin access required to manage groups.' });
      }
    } catch (e) {
      console.error(e);
      setMessage({ type: 'error', text: 'Failed to load groups or options' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = useCallback(() => {
    setEditingGroup(null);
    setForm({
      name: '',
      agent_extensions: [],
      queue_extensions: [],
      user_ids: [],
    });
    setGroupsSubTab('list');
  }, []);

  const startEdit = (g: OpDeskGroup) => {
    setExpandedGroupId(null);
    setEditingGroup(g);
    setForm({
      name: g.name,
      agent_extensions: g.agent_extensions || [],
      queue_extensions: (g.queues || []).map(q => q.extension),
      user_ids: (g.user_ids || []).map(String),
    });
    setGroupsSubTab('create');
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: 'Group name is required' });
      return;
    }
    try {
      if (editingGroup) {
        const res = await fetch(`/api/settings/groups/${editingGroup.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            name: form.name,
            agent_extensions: form.agent_extensions,
            queue_extensions: form.queue_extensions,
            user_ids: form.user_ids.map(Number),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Update failed');
        }
        setMessage({ type: 'success', text: 'Group updated' });
      } else {
        const res = await fetch('/api/settings/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            name: form.name.trim(),
            agent_extensions: form.agent_extensions,
            queue_extensions: form.queue_extensions,
            user_ids: form.user_ids.map(Number),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Create failed');
        }
        setMessage({ type: 'success', text: 'Group created' });
      }
      resetForm();
      loadData();
      setGroupsSubTab('list');
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Request failed' });
    }
  };

  const handleDelete = async (g: OpDeskGroup) => {
    if (!window.confirm(`Delete group "${g.name}"? Users will lose access to this group's agents and queues.`)) return;
    setMessage(null);
    try {
      const res = await fetch(`/api/settings/groups/${g.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Delete failed');
      }
      setMessage({ type: 'success', text: 'Group deleted' });
      resetForm();
      loadData();
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
    }
  };

  if (!isAdmin) {
    return (
      <div className="panel">
        <div className="panel-content">
          <div className="settings-section" style={{ textAlign: 'center', padding: 48 }}>
            <Shield size={48} style={{ marginBottom: 20, opacity: 0.6, color: 'var(--text-muted)' }} />
            <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>Only administrators can manage groups.</p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="panel">
        <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 64 }}>
          <Loader2 size={32} className="spinner" />
          <p style={{ marginTop: 20, color: 'var(--text-secondary)', fontSize: 14 }}>Loading groups...</p>
        </div>
      </div>
    );
  }

  const agentOptions = agents.map(a => ({
    value: a.extension,
    label: `${a.extension} ${a.name !== a.extension ? a.name : ''}`.trim() || a.extension,
  }));
  const queueOptions = queues.map(q => ({
    value: q.extension,
    label: `${q.extension} ${q.queue_name !== q.extension ? q.queue_name : ''}`.trim() || q.extension,
  }));
  const userOptions = users.map(u => ({ value: String(u.id), label: u.username }));

  return (
    <div className="panel">
      <div className="panel-content up-root">
        {message && (
          <div className={`up-alert ${message.type === 'success' ? 'success' : 'error'}`}>
            {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span>{message.text}</span>
          </div>
        )}

        <div className="up-tabs">
          <button
            type="button"
            className={`up-tab ${groupsSubTab === 'create' ? 'active' : ''}`}
            onClick={() => setGroupsSubTab('create')}
          >
            <UserPlus size={18} />
            Create / Edit group
          </button>
          <button
            type="button"
            className={`up-tab ${groupsSubTab === 'list' ? 'active' : ''}`}
            onClick={() => setGroupsSubTab('list')}
          >
            <Group size={18} />
            All groups
          </button>
        </div>

        {groupsSubTab === 'create' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon">
                {editingGroup ? <Pencil size={24} /> : <Group size={24} />}
              </div>
              <div>
                <h2 className="up-add-title">{editingGroup ? 'Edit group' : 'Add new group'}</h2>
                <p className="up-add-desc">
                  Create access groups: name, agents (extensions), queues, and assign users. User access is derived from their groups.
                </p>
              </div>
            </div>

            <form onSubmit={handleCreateOrUpdate} className="up-add-body">
              <div className="up-form-divider">Group</div>
              <div className="up-form-row">
                <div className="up-form-group">
                  <label>Group name *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Sales, Support"
                  />
                </div>
              </div>

              <div className="up-form-divider">Agents &amp; Queues</div>
              <div className="up-form-row single">
                <div className="up-form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Phone size={14} />
                    Agents (extensions this group can access)
                  </label>
                  <MultiSelectDropdown
                    options={agentOptions}
                    value={form.agent_extensions}
                    onChange={agent_extensions => setForm(f => ({ ...f, agent_extensions }))}
                    placeholder="Select agents..."
                    emptyMessage="No agents in system"
                  />
                </div>
              </div>
              <div className="up-form-row single">
                <div className="up-form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <List size={14} />
                    Queues (queues this group can access)
                  </label>
                  <MultiSelectDropdown
                    options={queueOptions}
                    value={form.queue_extensions}
                    onChange={queue_extensions => setForm(f => ({ ...f, queue_extensions }))}
                    placeholder="Select queues..."
                    emptyMessage="No queues in system"
                  />
                </div>
              </div>

              <div className="up-form-divider">Users</div>
              <div className="up-form-row single">
                <div className="up-form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Users size={14} />
                    Users in this group (they get access to the agents and queues above)
                  </label>
                  <MultiSelectDropdown
                    options={userOptions}
                    value={form.user_ids}
                    onChange={user_ids => setForm(f => ({ ...f, user_ids }))}
                    placeholder="Select users..."
                    emptyMessage="No users"
                  />
                </div>
              </div>

              <div className="up-actions">
                <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Save size={16} />
                  {editingGroup ? 'Update group' : 'Add group'}
                </button>
                {editingGroup && (
                  <button type="button" className="btn" onClick={resetForm}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>
        )}

        {groupsSubTab === 'list' && (
          <>
            <div className="up-list-header">
              <div className="up-list-icon">
                <Group size={22} />
              </div>
              <div>
                <h2 className="up-list-title">All groups</h2>
                <p className="up-list-desc">Manage access groups: agents, queues, and users.</p>
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="up-empty">No groups yet. Create one above.</div>
            ) : (
              <div className="up-users-list">
                {groups.map(g => {
                  const isExpanded = expandedGroupId === g.id;
                  const agentLabels = (g.agent_extensions || []).map(ext => {
                    const a = agents.find(x => x.extension === ext);
                    return a ? `${a.extension}${a.name && a.name !== a.extension ? ` (${a.name})` : ''}`.trim() || ext : ext;
                  });
                  const queueLabels = (g.queues || []).map(q => q.queue_name || q.extension);
                  const userLabels = (g.user_ids || []).map(uid => users.find(x => x.id === uid)?.username ?? String(uid));
                  return (
                    <div key={g.id} className="up-user-card">
                      <div
                        className="up-user-info"
                        style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                        onClick={() => setExpandedGroupId(prev => (prev === g.id ? null : g.id))}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedGroupId(prev => (prev === g.id ? null : g.id)); } }}
                        aria-expanded={isExpanded}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div className="up-user-avatar" style={{ background: 'var(--accent-teal)', color: 'var(--bg-primary)', flexShrink: 0 }}>
                            <Group size={20} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="up-user-name">{g.name}</span>
                              <ChevronDown
                                size={18}
                                style={{
                                  color: 'var(--text-muted)',
                                  flexShrink: 0,
                                  transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                  transition: 'transform 0.2s ease',
                                }}
                              />
                            </div>
                            <div className="up-user-badges">
                              <span className="up-access-tag">{g.agent_extensions?.length ?? 0} agents</span>
                              <span className="up-access-tag">{g.queues?.length ?? 0} queues</span>
                              <span className="up-access-tag">{g.user_ids?.length ?? 0} users</span>
                            </div>
                            {isExpanded && (
                              <div className="gp-expanded">
                                <div className="gp-detail-grid">
                                  <div className="gp-detail-section">
                                    <div className="gp-detail-label">
                                      <Phone size={12} />
                                      Agents <span>({agentLabels.length})</span>
                                    </div>
                                    <div className="gp-chips">
                                      {agentLabels.length ? agentLabels.map((label, i) => (
                                        <span key={i} className="gp-chip gp-chip-agent" title={label}>{label}</span>
                                      )) : <span className="gp-empty-hint">None</span>}
                                    </div>
                                  </div>
                                  <div className="gp-detail-section">
                                    <div className="gp-detail-label">
                                      <List size={12} />
                                      Queues <span>({queueLabels.length})</span>
                                    </div>
                                    <div className="gp-chips">
                                      {queueLabels.length ? queueLabels.map((label, i) => (
                                        <span key={i} className="gp-chip gp-chip-queue" title={label}>{label}</span>
                                      )) : <span className="gp-empty-hint">None</span>}
                                    </div>
                                  </div>
                                  <div className="gp-detail-section">
                                    <div className="gp-detail-label">
                                      <Users size={12} />
                                      Users <span>({userLabels.length})</span>
                                    </div>
                                    <div className="gp-chips">
                                      {userLabels.length ? userLabels.map((label, i) => (
                                        <span key={i} className="gp-chip gp-chip-user" title={label}>{label}</span>
                                      )) : <span className="gp-empty-hint">None</span>}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="up-user-actions">
                        <button type="button" className="btn btn-edit" onClick={e => { e.stopPropagation(); startEdit(g); }} title="Edit group">
                          <Pencil size={14} />
                        </button>
                        <button type="button" className="btn btn-delete" onClick={e => { e.stopPropagation(); handleDelete(g); }} title="Delete group">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
