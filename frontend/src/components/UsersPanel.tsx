import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, Save, Loader2, CheckCircle2, AlertCircle, Users, UserPlus, Pencil, Trash2, Shield, Phone, List, ChevronDown,
} from 'lucide-react';
import { getAuthHeaders, getUser } from '../auth';

export interface OpDeskUser {
  id: number;
  username: string;
  extension?: string | null;
  name?: string | null;
  role: string;
  is_active: number | boolean;
  monitor_mode?: string;
  /** Multiple monitor modes (listen, whisper, barge). */
  monitor_modes?: string[];
  agent_extensions?: string[];
  queue_names?: string[];
}

interface AgentOption {
  extension: string;
  name: string;
}

interface QueueOption {
  id: number;
  queue_name: string;
}

function MultiSelectDropdown({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  emptyMessage = 'No options',
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const filtered = filter.trim()
    ? options.filter(o => o.label.toLowerCase().includes(filter.toLowerCase()) || o.value.toLowerCase().includes(filter.toLowerCase()))
    : options;

  const toggle = (v: string) => {
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
      {open && (
        <div
          role="listbox"
          style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, maxHeight: 220, overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)', zIndex: 50 }}
          onClick={e => e.stopPropagation()}
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
      )}
    </div>
  );
}

export function UsersPanel() {
  const currentUser = getUser();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<OpDeskUser[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [queues, setQueues] = useState<QueueOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingUser, setEditingUser] = useState<OpDeskUser | null>(null);
  const [usersSubTab, setUsersSubTab] = useState<'create' | 'list'>('create');
  const [expandedAccessUserId, setExpandedAccessUserId] = useState<number | null>(null);
  const [form, setForm] = useState({
    username: '',
    password: '',
    name: '',
    extension: '',
    role: 'supervisor' as 'admin' | 'supervisor',
    monitor_modes: ['listen'] as string[],
    agent_extensions: [] as string[],
    queue_names: [] as string[],
  });

  const loadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [usersRes, agentsRes, queuesRes] = await Promise.all([
        fetch('/api/settings/users', { headers: getAuthHeaders() }),
        fetch('/api/settings/agents', { headers: getAuthHeaders() }),
        fetch('/api/settings/queues', { headers: getAuthHeaders() }),
      ]);
      if (usersRes.ok) {
        const d = await usersRes.json();
        setUsers(d.users || []);
      }
      if (agentsRes.ok) {
        const d = await agentsRes.json();
        setAgents(d.agents || []);
      }
      if (queuesRes.ok) {
        const d = await queuesRes.json();
        setQueues(d.queues || []);
      }
      if (!usersRes.ok && usersRes.status === 403) {
        setMessage({ type: 'error', text: 'Admin access required to manage users.' });
      }
    } catch (e) {
      console.error(e);
      setMessage({ type: 'error', text: 'Failed to load users or options' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = useCallback(() => {
    setEditingUser(null);
    setForm({
      username: '',
      password: '',
      name: '',
      extension: '',
      role: 'supervisor',
      monitor_modes: ['listen'],
      agent_extensions: [],
      queue_names: [],
    });
    setUsersSubTab('list');
  }, []);

  const startEdit = (u: OpDeskUser) => {
    setEditingUser(u);
    let modes = u.monitor_modes;
    if (!modes || !modes.length) {
      const single = u.monitor_mode || 'listen';
      modes = single === 'full' ? ['listen', 'whisper', 'barge'] : [single];
    }
    setForm({
      username: u.username,
      password: '',
      name: u.name || '',
      extension: u.extension || '',
      role: (u.role as 'admin' | 'supervisor') || 'supervisor',
      monitor_modes: [...modes],
      agent_extensions: u.agent_extensions || [],
      queue_names: u.queue_names || [],
    });
    setUsersSubTab('create');
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!form.username.trim()) {
      setMessage({ type: 'error', text: 'Username is required' });
      return;
    }
    if (!editingUser && !form.password) {
      setMessage({ type: 'error', text: 'Password is required for new user' });
      return;
    }
    try {
      if (editingUser) {
        const res = await fetch(`/api/settings/users/${editingUser.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            name: form.name || null,
            extension: form.extension || null,
            role: form.role,
            monitor_modes: form.monitor_modes,
            password: form.password || undefined,
            agent_extensions: form.agent_extensions,
            queue_names: form.queue_names,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Update failed');
        }
        setMessage({ type: 'success', text: 'User updated' });
      } else {
        const res = await fetch('/api/settings/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({
            username: form.username.trim(),
            password: form.password,
            name: form.name || null,
            extension: form.extension || null,
            role: form.role,
            monitor_modes: form.monitor_modes.length ? form.monitor_modes : ['listen'],
            agent_extensions: form.agent_extensions,
            queue_names: form.queue_names,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Create failed');
        }
        setMessage({ type: 'success', text: 'User created' });
      }
      resetForm();
      loadData();
      setUsersSubTab('list');
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Request failed' });
    }
  };

  const handleDelete = async (user: OpDeskUser) => {
    if (user.id === currentUser?.id) {
      setMessage({ type: 'error', text: 'You cannot delete yourself' });
      return;
    }
    if (!window.confirm(`Delete user "${user.username}"?`)) return;
    setMessage(null);
    try {
      const res = await fetch(`/api/settings/users/${user.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Delete failed');
      }
      setMessage({ type: 'success', text: 'User deleted' });
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
            <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>Only administrators can manage users.</p>
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
          <p style={{ marginTop: 20, color: 'var(--text-secondary)', fontSize: 14 }}>Loading users...</p>
        </div>
      </div>
    );
  }

  const extCount = (u: OpDeskUser) => u.agent_extensions?.length ?? 0;
  const queueCount = (u: OpDeskUser) => u.queue_names?.length ?? 0;

  const accessSummary = (u: OpDeskUser) => {
    const ext = extCount(u);
    const q = queueCount(u);
    if (ext === 0 && q === 0) return { short: 'All extensions & queues', title: 'All extensions & queues', full: [] as string[] };
    const parts: string[] = [];
    if (ext > 0) parts.push(ext === 1 ? '1 extension' : `${ext} extensions`);
    if (q > 0) parts.push(q === 1 ? '1 queue' : `${q} queues`);
    const short = parts.join(', ');
    const full: string[] = [];
    if (ext > 0) full.push(`Ext: ${(u.agent_extensions || []).join(', ')}`);
    if (q > 0) full.push(`Queues: ${(u.queue_names || []).join(', ')}`);
    const title = full.join(' · ');
    return { short, title, full };
  };

  const initial = (u: OpDeskUser) =>
    (u.username?.[0] || u.name?.[0] || '?').toUpperCase();

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
            className={`up-tab ${usersSubTab === 'create' ? 'active' : ''}`}
            onClick={() => setUsersSubTab('create')}
          >
            <UserPlus size={18} />
            Create / Edit user
          </button>
          <button
            type="button"
            className={`up-tab ${usersSubTab === 'list' ? 'active' : ''}`}
            onClick={() => setUsersSubTab('list')}
          >
            <Users size={18} />
            All users
          </button>
        </div>

        {usersSubTab === 'create' && (
        <div className="up-add-card">
          <div className="up-add-header">
            <div className="up-add-icon">
              {editingUser ? <Pencil size={24} /> : <UserPlus size={24} />}
            </div>
            <div>
              <h2 className="up-add-title">{editingUser ? 'Edit user' : 'Add new user'}</h2>
              <p className="up-add-desc">
                Create or update OpDesk users and assign roles, extensions, and queues.
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateOrUpdate} className="up-add-body">
            <div className="up-form-divider">Account</div>
            <div className="up-form-row">
              <div className="up-form-group">
                <label>Username *</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder="Username"
                  disabled={!!editingUser}
                />
              </div>
              <div className="up-form-group">
                <label>{editingUser ? 'New password (leave blank to keep)' : 'Password *'}</label>
                <input
                  type="password"
                  className="form-input"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editingUser ? 'Leave blank to keep' : 'Password'}
                />
              </div>
            </div>

            <div className="up-form-divider">Profile</div>
            <div className="up-form-row">
              <div className="up-form-group">
                <label>Display name</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Full name"
                />
              </div>
              <div className="up-form-group">
                <label>Extension (optional)</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.extension}
                  onChange={e => setForm(f => ({ ...f, extension: e.target.value }))}
                  placeholder="e.g. 1001"
                />
              </div>
            </div>
            <div className="up-form-row">
              <div className="up-form-group">
                <label>Role</label>
                <select
                  className="form-input"
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value as 'admin' | 'supervisor' }))}
                >
                  <option value="supervisor">Supervisor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="up-form-group">
                <label>Monitor modes (select one or more)</label>
                <MultiSelectDropdown
                  options={[
                    { value: 'listen', label: 'Listen' },
                    { value: 'whisper', label: 'Whisper' },
                    { value: 'barge', label: 'Barge' },
                  ]}
                  value={form.monitor_modes}
                  onChange={monitor_modes => setForm(f => ({ ...f, monitor_modes: monitor_modes.length ? monitor_modes : ['listen'] }))}
                  placeholder="Select modes..."
                  emptyMessage="Select at least one"
                />
              </div>
            </div>

            <div className="up-form-divider">Access</div>
            <div className="up-form-row single">
              <div className="up-form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Phone size={14} />
                  Extensions / agents (select which this user can access)
                </label>
                <MultiSelectDropdown
                  options={agents.map(a => ({
                    value: a.extension,
                    label: `${a.extension} ${a.name !== a.extension ? a.name : ''}`.trim() || a.extension,
                  }))}
                  value={form.agent_extensions}
                  onChange={agent_extensions => setForm(f => ({ ...f, agent_extensions }))}
                  placeholder="Select extension..."
                  emptyMessage="No extensions in system"
                />
              </div>
            </div>
            <div className="up-form-row single">
              <div className="up-form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <List size={14} />
                  Queues (select which this user can access)
                </label>
                <MultiSelectDropdown
                  options={queues.map(q => ({ value: q.queue_name, label: q.queue_name }))}
                  value={form.queue_names}
                  onChange={queue_names => setForm(f => ({ ...f, queue_names }))}
                  placeholder="Select queue..."
                  emptyMessage="No queues in system"
                />
              </div>
            </div>

            <div className="up-actions">
              <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Save size={16} />
                {editingUser ? 'Update user' : 'Add user'}
              </button>
              {editingUser && (
                <button type="button" className="btn" onClick={resetForm}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
        )}

        {usersSubTab === 'list' && (
        <>
        <div className="up-list-header">
          <div className="up-list-icon">
            <Users size={22} />
          </div>
          <div>
            <h2 className="up-list-title">All users</h2>
            <p className="up-list-desc">View and manage OpDesk user accounts, roles, and access.</p>
          </div>
        </div>

        {users.length === 0 ? (
          <div className="up-empty">No users yet. Add one above.</div>
        ) : (
          <div className="up-users-list">
            {users.map(u => {
              const access = accessSummary(u);
              return (
              <div key={u.id} className="up-user-card">
                <div className="up-user-avatar">{initial(u)}</div>
                <div className="up-user-info">
                  <div className="up-user-name">{u.username}</div>
                  {(u.name || u.extension) && (
                    <div className="up-user-meta">{[u.name, u.extension].filter(Boolean).join(' · ')}</div>
                  )}
                  <div className="up-user-badges">
                    <span className={`up-role-badge ${u.role}`}>{u.role}</span>
                    <button
                      type="button"
                      className="up-access-tag up-access-tag-btn"
                      title="Click to show full list"
                      onClick={() => setExpandedAccessUserId(prev => (prev === u.id ? null : u.id))}
                    >
                      {access.short}
                    </button>
                  </div>
                  {expandedAccessUserId === u.id && access.full.length > 0 && (
                    <div className="up-access-expanded">
                      {access.full.map((line, i) => (
                        <div key={i} className="up-access-expanded-line">
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="up-user-actions">
                  <button type="button" className="btn btn-edit" onClick={() => startEdit(u)} title="Edit user">
                    <Pencil size={14} />
                  </button>
                  {u.id !== currentUser?.id && (
                    <button type="button" className="btn btn-delete" onClick={() => handleDelete(u)} title="Delete user">
                      <Trash2 size={14} />
                    </button>
                  )}
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
