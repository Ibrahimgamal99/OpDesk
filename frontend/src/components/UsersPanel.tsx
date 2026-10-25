import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Save, Users, UserPlus, Pencil, Trash2, Shield, Plus, Phone, Eye, EyeOff, Radio, QrCode, Smartphone,
} from 'lucide-react';
import { MobileSetupQR } from './MobileSetupQR';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
import type { PendingUserFormSnapshot } from '../App';
import { raiseFor } from '../lib/api';
import {
  Dropdown, SearchInput, matches, prepareQuery, Alert, Page, Toolbar, EmptyState, Badge, Table, Modal, Loading,
  FormSection, FormRow, FormField, Toggle, useConfirm,
} from './ui';
import type { BadgeTone } from './ui';

export interface OpDeskUser {
  id: number;
  username: string;
  extension?: string | null;
  name?: string | null;
  role: string;
  is_active: number | boolean;
  /** Monitor modes (listen, whisper, barge). The API sends only this list; there is no
   *  single `monitor_mode` field. Agents carry an empty list. */
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

type Role = 'admin' | 'supervisor' | 'agent';

export interface UsersPanelProps {
  /** Restored form when returning from Groups tab (create new group flow). */
  pendingUserForm?: PendingUserFormSnapshot | null;
  onClearPendingUserForm?: () => void;
  /** Open Groups tab with create form; pass current form snapshot and optional group name to pre-fill. */
  onOpenCreateGroup?: (formSnapshot: PendingUserFormSnapshot, prefillGroupName?: string) => void;
  /** The Teams page's Users/Groups tab bar, from App. */
  tabs?: React.ReactNode;
}

const ROLE_TONE: Record<string, BadgeTone> = {
  admin: 'purple',
  supervisor: 'primary',
  agent: 'success',
};

const EMPTY_FORM = {
  username: '',
  password: '',
  name: '',
  extension: '',
  role: 'supervisor' as Role,
  monitor_modes: ['listen'] as string[],
  group_ids: [] as string[],
  webrtc: false,
  /**
   * PJSIP max_contacts > 1: the browser and the phone may hold a registration at the same
   * time. null until the extension's credentials say (or when the PBX could not be read):
   * the toggle is then hidden and nothing is saved, so an outage never writes a wrong value.
   */
  multiDevice: null as boolean | null,
};

/** The form's multi-device state from a credentials answer's max_contacts. */
const multiDeviceOf = (maxContacts: unknown): boolean | null =>
  typeof maxContacts === 'number' ? maxContacts > 1 : null;

export function UsersPanel(props: UsersPanelProps = {}) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const { pendingUserForm = null, onClearPendingUserForm, onOpenCreateGroup, tabs } = props;
  const currentUser = getUser();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<OpDeskUser[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingUser, setEditingUser] = useState<OpDeskUser | null>(null);
  /** The add/edit form is a Modal over the list, which is always the page. */
  const [formOpen, setFormOpen] = useState(false);
  const [qrUser, setQrUser] = useState<OpDeskUser | null>(null);
  const [expandedAccessUserId, setExpandedAccessUserId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [newGroupNameForCreate, setNewGroupNameForCreate] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);

  const handleExtensionSelect = useCallback(async (ext: string) => {
    setForm(f => ({ ...f, extension: ext, webrtc: ext ? f.webrtc : false, multiDevice: null }));
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
          multiDevice: multiDeviceOf(data.max_contacts),
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
      multiDevice: null,
    });
    setFormOpen(true);
    onClearPendingUserForm();
  }, [pendingUserForm, onClearPendingUserForm]);

  // `keepMessage` for the refresh after a save/delete: clearing here wiped the
  // "User created/deleted" notice the instant it was set.
  const loadData = useCallback(async ({ keepMessage = false }: { keepMessage?: boolean } = {}) => {
    setLoading(true);
    if (!keepMessage) setMessage(null);
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
    setShowPassword(false);
    setForm(EMPTY_FORM);
    setFormOpen(false);
  }, []);

  const openCreate = () => {
    resetForm();
    setMessage(null);
    setFormOpen(true);
  };

  const startEdit = (u: OpDeskUser) => {
    setMessage(null);
    setEditingUser(u);
    setShowPassword(false);
    // An empty list (agents, or a supervisor saved before modes existed) opens on the
    // default the server applies: everything for an admin, Listen otherwise.
    let modes = (u.monitor_modes || []).filter(m => m === 'listen' || m === 'whisper' || m === 'barge');
    if (!modes.length) modes = u.role === 'admin' ? ['listen', 'whisper', 'barge'] : ['listen'];
    setForm({
      username: u.username,
      password: '',
      name: u.name || '',
      extension: u.extension || '',
      role: (u.role as Role) || 'supervisor',
      monitor_modes: [...modes],
      group_ids: (u.group_ids || []).map(String),
      webrtc: false,
      multiDevice: null,
    });
    setFormOpen(true);
    // Load the current WebRTC state for this user's extension (async).
    if (u.extension) {
      fetchWithAuth(`/api/settings/extensions/${u.extension}/credentials`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) setForm(f => ({ ...f, webrtc: data.webrtc === 'yes', multiDevice: multiDeviceOf(data.max_contacts) })); })
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
      let saved: string;
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
        if (!res.ok) await raiseFor(res);
        saved = t('users.userUpdated');
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
        if (!res.ok) await raiseFor(res);
        saved = t('users.userCreated');
      }
      // Persist WebRTC toggle for the linked extension (best-effort; user save already succeeded).
      let webrtcFailed = false;
      if (form.extension) {
        try {
          const wr = await fetchWithAuth(`/api/settings/extensions/${form.extension}/webrtc`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: form.webrtc }),
          });
          if (!wr.ok) webrtcFailed = true;
        } catch {
          webrtcFailed = true;
        }
      }
      // The device limit, sent after WebRTC rather than with it: both end in a PBX reload,
      // and only when the form knows the current value (see EMPTY_FORM.multiDevice).
      let multiDeviceFailed = false;
      if (form.extension && form.multiDevice !== null) {
        try {
          const md = await fetchWithAuth(`/api/settings/extensions/${form.extension}/max-contacts`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: form.multiDevice }),
          });
          if (!md.ok) multiDeviceFailed = true;
        } catch {
          multiDeviceFailed = true;
        }
      }
      resetForm();
      loadData({ keepMessage: true });
      setMessage(webrtcFailed
        ? { type: 'error', text: t('users.webrtcSaveFailed') }
        : multiDeviceFailed
          ? { type: 'error', text: t('users.multiDeviceSaveFailed', 'User saved, but updating the device limit failed.') }
          : { type: 'success', text: saved });
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('common.requestFailed', 'Request failed') });
    }
  };

  const handleDelete = async (user: OpDeskUser) => {
    if (user.id === currentUser?.id) {
      setMessage({ type: 'error', text: t('users.cannotDeleteSelf') });
      return;
    }
    const ok = await confirm({
      title: t('users.deleteTitle', 'Delete user?'),
      message: t('users.deleteConfirm', { username: user.username }),
      confirmLabel: t('common.delete', 'Delete'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (!ok) return;
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/settings/users/${user.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) await raiseFor(res);
      setMessage({ type: 'success', text: t('users.userDeleted') });
      resetForm();
      loadData({ keepMessage: true });
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('common.deleteFailed', 'Delete failed') });
    }
  };

  // Above the early returns: hooks cannot live after one.
  //
  // Searches everything the row actually shows — username, name, extension,
  // role, and group names — because a field you can read but cannot search reads
  // as broken. Group names are the reason this is not a one-line filter: the row
  // shows "3 groups", so "who is in Sales" is the question people bring here.
  const filtered = useMemo(() => {
    const q = prepareQuery(search);
    if (!q) return users;
    const groupName = (id: number) => groups.find(g => g.id === id)?.name ?? '';
    return users.filter(u => matches(q,
      u.username,
      u.name,
      u.extension,
      t(`users.roles.${u.role}`, { defaultValue: u.role }),
      ...(u.group_ids || []).map(groupName),
    ));
  }, [users, groups, search, t]);

  if (!isAdmin) {
    return (
      <Page icon={Users} title={t('nav.teams', 'Teams')} tabs={tabs}>
        <EmptyState icon={Shield} title={t('users.adminOnly')} />
      </Page>
    );
  }

  if (loading) {
    return (
      <Page icon={Users} title={t('nav.teams', 'Teams')} tabs={tabs}>
        <Loading label={t('users.loading')} />
      </Page>
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

  return (
    <Page
      icon={Users}
      title={t('nav.teams', 'Teams')}
      tabs={tabs}
      count={users.length}
      actions={
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          <Plus size={14} />
          {t('users.addUser')}
        </button>
      }
      toolbar={
        // Only when there is a list to narrow. A search box above an empty list
        // is a control that cannot do anything.
        users.length > 0 ? (
          <Toolbar
            search={
              <SearchInput
                value={search}
                onChange={setSearch}
                label={t('users.searchLabel', 'Search users')}
                placeholder={t('users.searchPlaceholder', 'Username, name, extension, group…')}
                // Filters a list already in memory: nothing to coalesce, and no
                // deep link worth writing to the address bar from an admin screen.
                debounceMs={0}
                urlSync={false}
              />
            }
          />
        ) : undefined
      }
    >
      {/* Messages land on the list once the Modal is closed; while it is open
          they belong to the form and show at the top of its body. */}
      {!formOpen && <Alert tone={message?.type === 'success' ? 'success' : 'error'}>{message?.text}</Alert>}

      <Table
        framed
        caption={t('users.title')}
        rows={filtered}
        rowKey={u => u.id}
        empty={users.length === 0
          ? <EmptyState icon={Users} title={t('users.noUsers')} />
          : <EmptyState icon={Users} title={t('users.noMatches', 'No users match "{{query}}"', { query: search })} />}
        columns={[
          {
            key: 'name', header: t('fields.username'), primary: true,
            cell: u => {
              const metaParts = [u.name, u.extension].filter(Boolean);
              return (
                <div className="u-min-w-0">
                  <div className="u-semibold u-truncate">{u.username}</div>
                  {metaParts.length > 0 && (
                    <div className="u-fg-muted u-text-sm u-truncate">{metaParts.join(' · ')}</div>
                  )}
                </div>
              );
            },
          },
          {
            key: 'role', header: t('fields.role'),
            cell: u => (
              <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>
                {t(`users.roles.${u.role}`, { defaultValue: u.role })}
              </Badge>
            ),
          },
          {
            key: 'access', header: t('users.access'),
            cell: u => {
              const access = accessSummary(u);
              const expanded = expandedAccessUserId === u.id && access.full.length > 0;
              return (
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    title={access.title}
                    aria-expanded={expanded}
                    onClick={() => setExpandedAccessUserId(prev => (prev === u.id ? null : u.id))}
                  >
                    {access.short}
                  </button>
                  {expanded && (
                    <div className="u-col u-gap-1 u-mt-1 u-text-sm u-fg-secondary">
                      {access.full.map((line, i) => <div key={i}>{line}</div>)}
                    </div>
                  )}
                </div>
              );
            },
          },
          {
            key: 'actions', header: t('common.actions', 'Actions'), align: 'end',
            cell: u => (
              <div className="u-row u-justify-end u-gap-1">
                {u.extension && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-icon"
                    onClick={() => setQrUser(u)}
                    title={t('mobileSetup.button', 'Mobile app QR')}
                    aria-label={t('mobileSetup.button', 'Mobile app QR')}
                  >
                    <QrCode size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  onClick={() => startEdit(u)}
                  title={t('users.editUser')}
                  aria-label={t('users.editUser')}
                >
                  <Pencil size={14} />
                </button>
                {u.id !== currentUser?.id && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger btn-sm btn-icon"
                    onClick={() => handleDelete(u)}
                    title={t('users.deleteConfirm', { username: u.username })}
                    aria-label={t('common.delete', 'Delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ),
          },
        ]}
      />

      <Modal
        open={formOpen}
        onClose={resetForm}
        title={editingUser ? t('users.editUser') : t('users.addNewUser')}
        icon={editingUser ? <Pencil size={16} /> : <UserPlus size={16} />}
        width="xl"
        footer={
          <>
            <button type="button" className="btn" onClick={resetForm}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="user-form" className="btn btn-primary">
              <Save size={14} />
              {editingUser ? t('users.updateUser') : t('users.addUser')}
            </button>
          </>
        }
      >
        <form id="user-form" onSubmit={handleCreateOrUpdate}>
          <Alert tone={message?.type === 'success' ? 'success' : 'error'} className="u-mb-4">{message?.text}</Alert>
          <FormSection title={t('common.account')} first>
            <FormRow>
              <FormField label={t('fields.username')} htmlFor="up-user-username" required>
                <input
                  id="up-user-username"
                  type="text"
                  autoComplete="off"
                  className="form-input"
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  placeholder={t('fields.username')}
                />
              </FormField>
              <FormField label={editingUser ? t('users.newPassword') : t('fields.password')} htmlFor="up-user-password" required={!editingUser}>
                <div className="u-row u-gap-2">
                  <input
                    id="up-user-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    className="form-input u-flex-1 u-min-w-0"
                    value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder={editingUser ? t('users.keepBlank') : t('fields.password')}
                  />
                  <button
                    type="button"
                    className="btn btn-icon"
                    onClick={() => setShowPassword(v => !v)}
                    title={showPassword ? t('account.hide', 'Hide') : t('account.show', 'Show')}
                    aria-label={showPassword ? t('account.hide', 'Hide') : t('account.show', 'Show')}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </FormField>
            </FormRow>
          </FormSection>

          <FormSection title={t('users.profile')}>
            <FormRow>
              <FormField label={t('users.displayName')} htmlFor="up-user-name">
                <input
                  id="up-user-name"
                  type="text"
                  className="form-input"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('fields.fullName')}
                />
              </FormField>
              <FormField label={t('users.extension')}>
                <Dropdown
                  size="md"
                  value={form.extension ?? ''}
                  onChange={handleExtensionSelect}
                  icon={Phone}
                  ariaLabel={t('users.extension')}
                  searchPlaceholder={t('users.searchExtension', 'Search extension…')}
                  options={[
                    { value: '', label: t('common.none', 'None') },
                    ...agents.map(a => ({
                      value: a.extension,
                      label: `${a.extension}${a.name !== a.extension ? ' — ' + a.name : ''}`,
                    })),
                  ]}
                />
                {agents.length === 0 && (
                  <p className="u-fg-muted u-text-sm u-mt-1">{t('users.noExtensions')}</p>
                )}
              </FormField>
            </FormRow>
            {form.extension && (
              <FormRow single>
                <Toggle
                  checked={form.webrtc}
                  onChange={webrtc => setForm(f => ({ ...f, webrtc }))}
                  label={t('users.webrtcLabel')}
                  description={t('users.webrtcHint')}
                  icon={<Radio size={14} />}
                />
              </FormRow>
            )}
            {form.extension && form.multiDevice !== null && (
              <FormRow single>
                <Toggle
                  checked={form.multiDevice}
                  onChange={multiDevice => setForm(f => ({ ...f, multiDevice }))}
                  label={t('users.multiDeviceLabel', 'Browser and phone at the same time')}
                  description={t('users.multiDeviceHint')}
                  icon={<Smartphone size={14} />}
                />
              </FormRow>
            )}
            <FormRow>
              <FormField
                label={t('fields.role')}
                hint={form.role === 'admin' ? t('users.adminMonitorDesc') : form.role === 'agent' ? t('users.agentDesc') : undefined}
              >
                <Dropdown
                  size="md"
                  value={form.role}
                  onChange={v => setForm(f => ({ ...f, role: v as Role }))}
                  icon={Shield}
                  ariaLabel={t('fields.role')}
                  options={[
                    { value: 'supervisor', label: t('users.roles.supervisor'), dot: 'blue'    },
                    { value: 'agent',      label: t('users.roles.agent'),      dot: 'green'   },
                    { value: 'admin',      label: t('users.roles.admin'),      dot: 'orange'  },
                  ]}
                />
              </FormField>
              {form.role === 'supervisor' && (
                <FormField label={t('users.monitorModes')}>
                  <Dropdown multiple size="md"
                    options={[
                      { value: 'listen', label: t('users.monitor.listen') },
                      { value: 'whisper', label: t('users.monitor.whisper') },
                      { value: 'barge', label: t('users.monitor.barge') },
                    ]}
                    value={form.monitor_modes}
                    onChange={monitor_modes => setForm(f => ({ ...f, monitor_modes: monitor_modes.length ? monitor_modes : ['listen'] }))}
                    placeholder={t('users.selectModes')}
                    emptyMessage={t('users.selectAtLeastOne')}
                    ariaLabel={t('users.monitorModes')}
                  />
                </FormField>
              )}
            </FormRow>
          </FormSection>

          {form.role !== 'agent' && (
            <FormSection title={t('users.access')}>
              <FormRow single>
                <FormField label={t('users.groupsLabel')}>
                  <Dropdown multiple size="md"
                    options={groups.map(g => ({ value: String(g.id), label: g.name }))}
                    value={form.group_ids}
                    onChange={group_ids => setForm(f => ({ ...f, group_ids }))}
                    placeholder={t('users.selectGroups')}
                    emptyMessage={t('users.noGroupsMessage')}
                    ariaLabel={t('users.groupsLabel')}
                  />
                  {onOpenCreateGroup && (
                    <div className="u-row u-gap-2 u-mt-2h u-wrap">
                      <input
                        type="text"
                        className="form-input u-flex-1 u-min-w-0"
                        value={newGroupNameForCreate}
                        onChange={e => setNewGroupNameForCreate(e.target.value)}
                        placeholder={t('users.newGroupNamePlaceholder')}
                        aria-label={t('users.newGroupNamePlaceholder')}
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
                      >
                        <Plus size={14} />
                        {t('users.createNewGroup')}
                      </button>
                    </div>
                  )}
                </FormField>
              </FormRow>
            </FormSection>
          )}
        </form>
      </Modal>
      {confirmDialog}
      <MobileSetupQR open={qrUser !== null} onClose={() => setQrUser(null)} userId={qrUser?.id} label={qrUser?.username} />
    </Page>
  );
}
