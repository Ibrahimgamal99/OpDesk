import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Save, Loader2, CheckCircle2, AlertCircle, Users, UserPlus, Pencil, Trash2, Shield, ChevronDown, Group, Plus,
} from 'lucide-react';
import { getAuthHeaders, getUser } from '../auth';
import type { PendingUserFormSnapshot } from '../App';

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
  /** Access via groups (agents/queues come from groups). */
  group_ids?: number[];
  /** Computed from groups for display. */
  agent_extensions?: string[];
  queue_names?: string[];
}

interface GroupOption {
  id: number;
  name: string;
}

export interface UsersPanelProps {
  /** Restored form when returning from Groups tab (create new group flow). */
  pendingUserForm?: PendingUserFormSnapshot | null;
  onClearPendingUserForm?: () => void;
  /** Open Groups tab with create form; pass current form snapshot and optional group name to pre-fill. */
  onOpenCreateGroup?: (formSnapshot: PendingUserFormSnapshot, prefillGroupName?: string) => void;
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

export function UsersPanel(props: UsersPanelProps = {}) {
  const { pendingUserForm = null, onClearPendingUserForm, onOpenCreateGroup } = props;
  const currentUser = getUser();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<OpDeskUser[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingUser, setEditingUser] = useState<OpDeskUser | null>(null);
  const [usersSubTab, setUsersSubTab] = useState<'create' | 'list'>('create');
  const [expandedAccessUserId, setExpandedAccessUserId] = useState<number | null>(null);
  const [newGroupNameForCreate, setNewGroupNameForCreate] = useState('');
  const [form, setForm] = useState({
    username: '',
    password: '',
    name: '',
    extension: '',
    role: 'supervisor' as 'admin' | 'supervisor' | 'agent',
    monitor_modes: ['listen'] as string[],
    group_ids: [] as string[],
  });

  // Restore user form when returning from Groups tab (create new group flow)
  useEffect(() => {
    if (!pendingUserForm || !onClearPendingUserForm) return;
    setForm({
      username: pendingUserForm.username,
      password: pendingUserForm.password,
      name: pendingUserForm.name,
      extension: pendingUserForm.extension,
      role: pendingUserForm.role,
      monitor_modes: pendingUserForm.monitor_modes,
      group_ids: pendingUserForm.group_ids,
    });
    setUsersSubTab('create');
    onClearPendingUserForm();
  }, [pendingUserForm, onClearPendingUserForm]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [usersRes, groupsRes] = await Promise.all([
        fetch('/api/settings/users', { headers: getAuthHeaders() }),
        fetch('/api/settings/groups', { headers: getAuthHeaders() }),
      ]);
      if (usersRes.ok) {
        const d = await usersRes.json();
        setUsers(d.users || []);
      }
      if (groupsRes.ok) {
        const d = await groupsRes.json();
        setGroups((d.groups || []).map((g: { id: number; name: string }) => ({ id: g.id, name: g.name })));
      }
      if (!usersRes.ok && usersRes.status === 403) {
        setMessage({ type: 'error', text: 'Admin access required to manage users.' });
      }
    } catch (e) {
      console.error(e);
      setMessage({ type: 'error', text: 'Failed to load users or groups' });
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
      group_ids: [],
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
      role: (u.role as 'admin' | 'supervisor' | 'agent') || 'supervisor',
      monitor_modes: [...modes],
      group_ids: (u.group_ids || []).map(String),
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
            monitor_modes: form.role === 'agent' ? [] : form.monitor_modes,
            password: form.password || undefined,
            group_ids: form.role === 'agent' ? [] : form.group_ids.map(Number),
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
            monitor_modes: form.role === 'agent' ? [] : (form.monitor_modes.length ? form.monitor_modes : ['listen']),
            group_ids: form.role === 'agent' ? [] : form.group_ids.map(Number),
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

  const groupCount = (u: OpDeskUser) => u.group_ids?.length ?? 0;
  const accessSummary = (u: OpDeskUser) => {
    const n = groupCount(u);
    const groupNames = (u.group_ids || [])
      .map(gid => groups.find(g => g.id === gid)?.name)
      .filter(Boolean) as string[];
    if (n === 0) return { short: 'No groups', title: 'No groups assigned', full: [] as string[] };
    const short = n === 1 ? '1 group' : `${n} groups`;
    const title = groupNames.length ? groupNames.join(', ') : short;
    const full = groupNames.length ? groupNames : [short];
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
                  onChange={e => setForm(f => ({ ...f, role: e.target.value as 'admin' | 'supervisor' | 'agent' }))}
                >
                  <option value="supervisor">Supervisor</option>
                  <option value="agent">Agent</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              {form.role !== 'agent' && (
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
              )}
              {form.role === 'agent' && (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Agent sees only their extension, active call, and call history.</p>
              )}
            </div>

            {form.role !== 'agent' && (
            <>
            <div className="up-form-divider">Access (via groups)</div>
            <div className="up-form-row single">
              <div className="up-form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Users size={14} />
                  Groups (user gets access to agents and queues from selected groups)
                </label>
                <MultiSelectDropdown
                  options={groups.map(g => ({ value: String(g.id), label: g.name }))}
                  value={form.group_ids}
                  onChange={group_ids => setForm(f => ({ ...f, group_ids }))}
                  placeholder="Select groups..."
                  emptyMessage="No groups. Create groups in the Groups tab first."
                />
                {onOpenCreateGroup && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="form-input"
                      value={newGroupNameForCreate}
                      onChange={e => setNewGroupNameForCreate(e.target.value)}
                      placeholder="New group name (optional)"
                      style={{ width: 200, flex: '0 0 auto' }}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        onOpenCreateGroup(
                          {
                            username: form.username,
                            password: form.password,
                            name: form.name,
                            extension: form.extension,
                            role: form.role,
                            monitor_modes: form.monitor_modes,
                            group_ids: form.group_ids,
                          },
                          newGroupNameForCreate.trim() || undefined
                        );
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Plus size={14} />
                      <Group size={14} />
                      Create new group
                    </button>
                  </div>
                )}
              </div>
            </div>
            </>
            )}

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
