import { useState, useEffect, useCallback } from 'react';
import {
  Save, Loader2, CheckCircle2, AlertCircle, Users, UserPlus, Pencil, Trash2, Shield, Group, Plus, Phone, Eye, EyeOff, Radio,
} from 'lucide-react';
import { FilterSelect } from './FilterSelect';
import { MultiSelectDropdown } from './MultiSelectDropdown';
import { Toggle } from './ui/Toggle';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
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

interface AgentOption {
  extension: string;
  name: string;
}

export interface UsersPanelProps {
  /** Restored form when returning from Groups tab (create new group flow). */
  pendingUserForm?: PendingUserFormSnapshot | null;
  onClearPendingUserForm?: () => void;
  /** Open Groups tab with create form; pass current form snapshot and optional group name to pre-fill. */
  onOpenCreateGroup?: (formSnapshot: PendingUserFormSnapshot, prefillGroupName?: string) => void;
}

export function UsersPanel(props: UsersPanelProps = {}) {
  const { t } = useTranslation();
  const { pendingUserForm = null, onClearPendingUserForm, onOpenCreateGroup } = props;
  const currentUser = getUser();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<OpDeskUser[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingUser, setEditingUser] = useState<OpDeskUser | null>(null);
  const [usersSubTab, setUsersSubTab] = useState<'create' | 'list'>('list');
  const [expandedAccessUserId, setExpandedAccessUserId] = useState<number | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [newGroupNameForCreate, setNewGroupNameForCreate] = useState('');
  const [form, setForm] = useState({
    username: '',
    password: '',
    name: '',
    extension: '',
    role: 'supervisor' as 'admin' | 'supervisor' | 'agent',
    monitor_modes: ['listen'] as string[],
    group_ids: [] as string[],
    webrtc: false,
  });

  const handleExtensionSelect = useCallback(async (ext: string) => {
    setForm(f => ({ ...f, extension: ext, webrtc: ext ? f.webrtc : false }));
    if (!ext) return;
    try {
      const res = await fetchWithAuth(`/api/settings/extensions/${ext}/credentials`);
      if (res.ok) {
        const data = await res.json();
        setForm(f => ({
          ...f,
          ...(editingUser ? {} : { username: data.username || ext, password: data.password || '' }),
          name: data.name || f.name,
          webrtc: data.webrtc === 'yes',
        }));
      }
    } catch { /* ignore */ }
  }, [editingUser]);

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
      webrtc: false,
    });
    setUsersSubTab('create');
    onClearPendingUserForm();
  }, [pendingUserForm, onClearPendingUserForm]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [usersRes, groupsRes, agentsRes] = await Promise.all([
        fetchWithAuth('/api/settings/users'),
        fetchWithAuth('/api/settings/groups'),
        fetchWithAuth('/api/settings/agents'),
      ]);
      if (usersRes.ok) {
        const d = await usersRes.json();
        setUsers(d.users || []);
      }
      if (groupsRes.ok) {
        const d = await groupsRes.json();
        setGroups((d.groups || []).map((g: { id: number; name: string }) => ({ id: g.id, name: g.name })));
      }
      if (agentsRes.ok) {
        const d = await agentsRes.json();
        setAgents(d.agents || []);
      }
      if (!usersRes.ok && usersRes.status === 403) {
        setMessage({ type: 'error', text: t('users.adminRequired') });
      }
    } catch (e) {
      console.error(e);
      setMessage({ type: 'error', text: t('users.loadError') });
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
      webrtc: false,
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
      webrtc: false,
    });
    setUsersSubTab('create');
    // Load the current WebRTC state for this user's extension (async).
    if (u.extension) {
      fetchWithAuth(`/api/settings/extensions/${u.extension}/credentials`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) setForm(f => ({ ...f, webrtc: data.webrtc === 'yes' })); })
        .catch(() => { /* ignore */ });
    }
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!form.username.trim()) {
      setMessage({ type: 'error', text: t('users.usernameRequired') });
      return;
    }
    if (!editingUser && !form.password) {
      setMessage({ type: 'error', text: t('users.passwordRequired') });
      return;
    }
    try {
      if (editingUser) {
        const res = await fetchWithAuth(`/api/settings/users/${editingUser.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name || null,
            extension: form.extension,
            role: form.role,
            monitor_modes: form.role === 'agent' ? [] : form.role === 'admin' ? ['listen', 'whisper', 'barge'] : form.monitor_modes,
            password: form.password || undefined,
            group_ids: form.role === 'agent' ? [] : form.group_ids.map(Number),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Update failed');
        }
        setMessage({ type: 'success', text: t('users.userUpdated') });
      } else {
        const res = await fetchWithAuth('/api/settings/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username.trim(),
            password: form.password,
            name: form.name || null,
            extension: form.extension || null,
            role: form.role,
            monitor_modes: form.role === 'agent' ? [] : form.role === 'admin' ? ['listen', 'whisper', 'barge'] : (form.monitor_modes.length ? form.monitor_modes : ['listen']),
            group_ids: form.role === 'agent' ? [] : form.group_ids.map(Number),
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Create failed');
        }
        setMessage({ type: 'success', text: t('users.userCreated') });
      }
      // Persist WebRTC toggle for the linked extension (best-effort; user save already succeeded).
      if (form.extension) {
        try {
          const wr = await fetchWithAuth(`/api/settings/extensions/${form.extension}/webrtc`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: form.webrtc }),
          });
          if (!wr.ok) {
            setMessage({ type: 'error', text: t('users.webrtcSaveFailed') });
          }
        } catch {
          setMessage({ type: 'error', text: t('users.webrtcSaveFailed') });
        }
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
      setMessage({ type: 'error', text: t('users.cannotDeleteSelf') });
      return;
    }
    if (!window.confirm(t('users.deleteConfirm', { username: user.username }))) return;
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/settings/users/${user.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Delete failed');
      }
      setMessage({ type: 'success', text: t('users.userDeleted') });
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
            <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>{t('users.adminOnly')}</p>
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
          <p style={{ marginTop: 20, color: 'var(--text-secondary)', fontSize: 14 }}>{t('users.loading')}</p>
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
    if (n === 0) return { short: t('users.noGroups'), title: t('users.noGroups'), full: [] as string[] };
    const short = n === 1 ? t('users.oneGroup') : t('users.manyGroups', { count: n });
    const title = groupNames.length ? groupNames.join(', ') : short;
    const full = groupNames.length ? groupNames : [short];
    return { short, title, full };
  };

  const initial = (u: OpDeskUser) =>
    (u.username?.[0] || u.name?.[0] || '?').toUpperCase();

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <Users size={16} className="panel-title-icon" />
          {t('users.title')}
        </h2>
        <div className="panel-header-actions">
          <div className="up-tabs up-tabs-inline">
            <button
              type="button"
              className={`up-tab ${usersSubTab === 'create' ? 'active' : ''}`}
              onClick={() => setUsersSubTab('create')}
            >
              <UserPlus size={14} />
              {t('users.createEdit')}
            </button>
            <button
              type="button"
              className={`up-tab ${usersSubTab === 'list' ? 'active' : ''}`}
              onClick={() => setUsersSubTab('list')}
            >
              <Users size={14} />
              {t('users.title')}
            </button>
          </div>
        </div>
      </div>

      <div className="panel-content">
        {message && (
          <div className={`up-alert ${message.type === 'success' ? 'success' : 'error'}`}>
            {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span>{message.text}</span>
          </div>
        )}

        {usersSubTab === 'create' && (
        <div className="up-add-card">
          <div className="up-add-header">
            <div className="up-add-icon">
              {editingUser ? <Pencil size={24} /> : <UserPlus size={24} />}
            </div>
            <div>
              <h2 className="up-add-title">{editingUser ? t('users.editUser') : t('users.addNewUser')}</h2>
              <p className="up-add-desc">
                {t('users.adminMonitorDesc')}
              </p>
            </div>
          </div>

          <form onSubmit={handleCreateOrUpdate} className="up-add-body">
            <div className="up-form-divider">{t('users.account')}</div>
            <div className="up-form-row">
              <div className="up-form-group">
                <label>{t('users.username')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder={t('users.username')}
                />
              </div>
              <div className="up-form-group">
                <label>{editingUser ? t('users.newPassword') : t('users.password')}</label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="form-input"
                    style={{ paddingRight: 36 }}
                    value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder={editingUser ? t('users.keepBlank') : t('users.password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <div className="up-form-divider">{t('users.profile')}</div>
            <div className="up-form-row">
              <div className="up-form-group">
                <label>{t('users.displayName')}</label>
                <input
                  type="text"
                  className="form-input"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('users.fullName')}
                />
              </div>
              <div className="up-form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Phone size={14} />
                  {t('users.extension')}
                </label>
                <FilterSelect
                  size="md"
                  value={form.extension ?? ''}
                  onChange={handleExtensionSelect}
                  icon={Phone}
                  searchPlaceholder={t('users.searchExtension', 'Search extension…')}
                  options={[
                    { value: '', label: t('users.none', 'None') },
                    ...agents.map(a => ({
                      value: a.extension,
                      label: `${a.extension}${a.name !== a.extension ? ' — ' + a.name : ''}`,
                    })),
                  ]}
                />
                {agents.length === 0 && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{t('users.noExtensions')}</p>
                )}
              </div>
            </div>
            {form.extension && (
              <div className="up-form-row single">
                <div className="up-form-group">
                  <Toggle
                    checked={form.webrtc}
                    onChange={webrtc => setForm(f => ({ ...f, webrtc }))}
                    label={t('users.webrtcLabel')}
                    description={t('users.webrtcHint')}
                    icon={<Radio size={11} />}
                  />
                </div>
              </div>
            )}
            <div className="up-form-row">
              <div className="up-form-group">
                <label>{t('users.role')}</label>
                <FilterSelect
                  size="md"
                  value={form.role}
                  onChange={v => setForm(f => ({ ...f, role: v as 'admin' | 'supervisor' | 'agent' }))}
                  icon={Shield}
                  options={[
                    { value: 'supervisor', label: t('users.roles.supervisor'), dot: 'blue'    },
                    { value: 'agent',      label: t('users.roles.agent'),      dot: 'green'   },
                    { value: 'admin',      label: t('users.roles.admin'),      dot: 'orange'  },
                  ]}
                />
              </div>
              {form.role === 'supervisor' && (
                <div className="up-form-group">
                  <label>{t('users.monitorModes')}</label>
                  <MultiSelectDropdown
                    options={[
                      { value: 'listen', label: t('users.monitor.listen') },
                      { value: 'whisper', label: t('users.monitor.whisper') },
                      { value: 'barge', label: t('users.monitor.barge') },
                    ]}
                    value={form.monitor_modes}
                    onChange={monitor_modes => setForm(f => ({ ...f, monitor_modes: monitor_modes.length ? monitor_modes : ['listen'] }))}
                    placeholder={t('users.selectModes')}
                    emptyMessage={t('users.selectAtLeastOne')}
                  />
                </div>
              )}
              {form.role === 'admin' && (
                <div className="up-form-group">
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>{t('users.adminMonitorDesc')}</p>
                </div>
              )}
              {form.role === 'agent' && (
                <div className="up-form-group">
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>{t('users.agentDesc')}</p>
                </div>
              )}
            </div>

            {form.role !== 'agent' && (
            <>
            <div className="up-form-divider">{t('users.access')}</div>
            <div className="up-form-row single">
              <div className="up-form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Users size={14} />
                  {t('users.groupsLabel')}
                </label>
                <MultiSelectDropdown
                  options={groups.map(g => ({ value: String(g.id), label: g.name }))}
                  value={form.group_ids}
                  onChange={group_ids => setForm(f => ({ ...f, group_ids }))}
                  placeholder={t('users.selectGroups')}
                  emptyMessage={t('users.noGroupsMessage')}
                />
                {onOpenCreateGroup && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="form-input"
                      value={newGroupNameForCreate}
                      onChange={e => setNewGroupNameForCreate(e.target.value)}
                      placeholder={t('users.newGroupNamePlaceholder')}
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
                            monitor_modes: form.role === 'admin' ? ['listen', 'whisper', 'barge'] : form.monitor_modes,
                            group_ids: form.group_ids,
                          },
                          newGroupNameForCreate.trim() || undefined
                        );
                      }}
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Plus size={14} />
                      <Group size={14} />
                      {t('users.createNewGroup')}
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
                {editingUser ? t('users.updateUser') : t('users.addUser')}
              </button>
              {editingUser && (
                <button type="button" className="btn" onClick={resetForm}>
                  {t('users.cancel')}
                </button>
              )}
            </div>
          </form>
        </div>
        )}

        {usersSubTab === 'list' && (
        <>
        {users.length === 0 ? (
          <div className="up-empty">{t('users.noUsers')}</div>
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
                    <span className={`up-role-badge ${u.role}`}>{t(`users.roles.${u.role}`, { defaultValue: u.role })}</span>
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
                  <button type="button" className="btn btn-edit" onClick={() => startEdit(u)} title={t('users.editUser')}>
                    <Pencil size={14} />
                  </button>
                  {u.id !== currentUser?.id && (
                    <button type="button" className="btn btn-delete" onClick={() => handleDelete(u)} title={t('users.deleteConfirm', { username: u.username })}>
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
