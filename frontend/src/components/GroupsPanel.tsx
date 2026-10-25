import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Save, Plus, Pencil, Trash2, Shield, Phone, List, Group, ChevronDown, Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
import { raiseFor } from '../lib/api';
import {
  Dropdown, SearchInput, matches, prepareQuery, Alert, Page, Toolbar, EmptyState, Badge, Table, Modal, Loading,
  FormSection, FormRow, FormField, useConfirm,
} from './ui';

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

export interface GroupsPanelProps {
  /** When set, open create form and pre-fill group name (e.g. from Users "Create new group" flow). */
  initialGroupName?: string;
  /** Called after applying initialGroupName so parent can clear the intent. */
  onConsumeIntent?: () => void;
  /** The Teams page's Users/Groups tab bar, from App. */
  tabs?: React.ReactNode;
}

const EMPTY_FORM = {
  name: '',
  agent_extensions: [] as string[],
  queue_extensions: [] as string[],
  user_ids: [] as string[],
};

export function GroupsPanel(props: GroupsPanelProps) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const { initialGroupName, onConsumeIntent, tabs } = props;
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
  /** The add/edit form is a Modal over the list, which is always the page. */
  const [formOpen, setFormOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);

  // Open create form with name pre-filled when arriving from Users "Create new group"
  useEffect(() => {
    if (initialGroupName === undefined || !onConsumeIntent) return;
    setFormOpen(true);
    setEditingGroup(null);
    setForm(prev => ({ ...prev, name: initialGroupName }));
    onConsumeIntent();
  }, [initialGroupName, onConsumeIntent]);

  // `keepMessage` for the refresh after a save/delete: clearing here wiped the
  // "Group created/updated" notice the instant it was set.
  const loadData = useCallback(async ({ keepMessage = false }: { keepMessage?: boolean } = {}) => {
    setLoading(true);
    if (!keepMessage) setMessage(null);
    try {
      const [groupsRes, agentsRes, queuesRes, usersRes] = await Promise.all([
        fetchWithAuth('/api/settings/groups'),
        fetchWithAuth('/api/settings/agents'),
        fetchWithAuth('/api/settings/queues'),
        fetchWithAuth('/api/settings/users'),
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
        setMessage({ type: 'error', text: t('groups.adminRequired') });
      }
    } catch (e) {
      console.error(e);
      setMessage({ type: 'error', text: t('groups.loadError') });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = useCallback(() => {
    setEditingGroup(null);
    setForm(EMPTY_FORM);
    setFormOpen(false);
  }, []);

  const openCreate = () => {
    resetForm();
    setMessage(null);
    setFormOpen(true);
  };

  const startEdit = (g: OpDeskGroup) => {
    setMessage(null);
    setExpandedGroupId(null);
    setEditingGroup(g);
    setForm({
      name: g.name,
      agent_extensions: g.agent_extensions || [],
      queue_extensions: (g.queues || []).map(q => q.extension),
      user_ids: (g.user_ids || []).map(String),
    });
    setFormOpen(true);
  };

  const handleCreateOrUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: t('groups.groupNameRequired') });
      return;
    }
    try {
      if (editingGroup) {
        const res = await fetchWithAuth(`/api/settings/groups/${editingGroup.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name,
            agent_extensions: form.agent_extensions,
            queue_extensions: form.queue_extensions,
            user_ids: form.user_ids.map(Number),
          }),
        });
        if (!res.ok) await raiseFor(res);
        setMessage({ type: 'success', text: t('groups.groupUpdated') });
      } else {
        const res = await fetchWithAuth('/api/settings/groups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim(),
            agent_extensions: form.agent_extensions,
            queue_extensions: form.queue_extensions,
            user_ids: form.user_ids.map(Number),
          }),
        });
        if (!res.ok) await raiseFor(res);
        setMessage({ type: 'success', text: t('groups.groupCreated') });
      }
      resetForm();
      loadData({ keepMessage: true });
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('common.requestFailed', 'Request failed') });
    }
  };

  const handleDelete = async (g: OpDeskGroup) => {
    const ok = await confirm({
      title: t('groups.deleteTitle', 'Delete group?'),
      message: t('groups.deleteConfirm', { name: g.name }),
      confirmLabel: t('common.delete', 'Delete'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (!ok) return;
    setMessage(null);
    try {
      const res = await fetchWithAuth(`/api/settings/groups/${g.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) await raiseFor(res);
      setMessage({ type: 'success', text: t('groups.groupDeleted') });
      resetForm();
      loadData({ keepMessage: true });
    } catch (err: unknown) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : t('common.deleteFailed', 'Delete failed') });
    }
  };

  // Member labels are built once here and used by BOTH the filter and the row,
  // so searching can never disagree with what the expanded row lists.
  const agentLabelsFor = useCallback((g: OpDeskGroup) => (g.agent_extensions || []).map(ext => {
    const a = agents.find(x => x.extension === ext);
    return a ? `${a.extension}${a.name && a.name !== a.extension ? ` (${a.name})` : ''}`.trim() || ext : ext;
  }), [agents]);
  const queueLabelsFor = useCallback((g: OpDeskGroup) =>
    (g.queues || []).map(q => q.queue_name || q.extension), []);
  const userLabelsFor = useCallback((g: OpDeskGroup) =>
    (g.user_ids || []).map(uid => users.find(x => x.id === uid)?.username ?? String(uid)), [users]);

  // Above the early returns: hooks cannot live after one. Members are searchable
  // as well as the name — "which group has extension 1005" is the question this
  // screen exists to answer, and a name-only match cannot answer it.
  const filtered = useMemo(() => {
    const q = prepareQuery(search);
    if (!q) return groups;
    return groups.filter(g => matches(q,
      g.name,
      ...agentLabelsFor(g),
      ...queueLabelsFor(g),
      ...userLabelsFor(g),
    ));
  }, [groups, search, agentLabelsFor, queueLabelsFor, userLabelsFor]);

  if (!isAdmin) {
    return (
      <Page icon={Users} title={t('nav.teams', 'Teams')} tabs={tabs}>
        <EmptyState icon={Shield} title={t('groups.adminOnly')} />
      </Page>
    );
  }

  if (loading) {
    return (
      <Page icon={Users} title={t('nav.teams', 'Teams')} tabs={tabs}>
        <Loading label={t('groups.loading')} />
      </Page>
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

  const toggleExpanded = (id: number) => setExpandedGroupId(prev => (prev === id ? null : id));

  // Collapsed rows show a count per column; an expanded row lists every member
  // as a chip in the same column, so the detail lines up under its header.
  const memberCell = (expanded: boolean, summary: string, chips: React.ReactNode[]) => {
    if (!expanded) return <span className="u-fg-secondary">{summary}</span>;
    if (chips.length === 0) return <span className="u-fg-muted">{t('common.none')}</span>;
    return <div className="u-row u-wrap u-gap-1">{chips}</div>;
  };

  return (
    <Page
      icon={Users}
      title={t('nav.teams', 'Teams')}
      tabs={tabs}
      count={groups.length}
      actions={
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          <Plus size={14} />
          {t('groups.addGroup')}
        </button>
      }
      toolbar={
        // Only when there is a list to narrow. A search box above an empty list
        // is a control that cannot do anything.
        groups.length > 0 ? (
          <Toolbar
            search={
              <SearchInput
                value={search}
                onChange={setSearch}
                label={t('groups.searchLabel', 'Search groups')}
                placeholder={t('groups.searchPlaceholder', 'Group, agent, queue, user…')}
                // Filters a list already in memory: nothing to coalesce, and no
                // deep link worth writing from an admin screen.
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
        caption={t('groups.title')}
        rows={filtered}
        rowKey={g => g.id}
        empty={groups.length === 0
          ? <EmptyState icon={Group} title={t('groups.noGroups')} />
          : <EmptyState icon={Group} title={t('groups.noMatches', 'No groups match "{{query}}"', { query: search })} />}
        onRowClick={g => toggleExpanded(g.id)}
        columns={[
          {
            key: 'name', header: t('groups.groupName'), primary: true,
            cell: g => {
              const isExpanded = expandedGroupId === g.id;
              return (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-expanded={isExpanded}
                  onClick={e => { e.stopPropagation(); toggleExpanded(g.id); }}
                >
                  <ChevronDown size={14} className={`gp-chevron${isExpanded ? ' is-open' : ''}`} aria-hidden />
                  {g.name}
                </button>
              );
            },
          },
          {
            key: 'agents', header: t('groups.agentsLabel'),
            cell: g => memberCell(
              expandedGroupId === g.id,
              t('groups.agentsCount', { count: g.agent_extensions?.length ?? 0 }),
              agentLabelsFor(g).map((label, i) => <Badge key={i} tone="primary" title={label}>{label}</Badge>),
            ),
          },
          {
            key: 'queues', header: t('nav.queues'),
            cell: g => memberCell(
              expandedGroupId === g.id,
              t('groups.queuesCount', { count: g.queues?.length ?? 0 }),
              queueLabelsFor(g).map((label, i) => <Badge key={i} tone="purple" title={label}>{label}</Badge>),
            ),
          },
          {
            key: 'users', header: t('nav.users'),
            cell: g => memberCell(
              expandedGroupId === g.id,
              t('groups.usersCount', { count: g.user_ids?.length ?? 0 }),
              userLabelsFor(g).map((label, i) => <Badge key={i} title={label}>{label}</Badge>),
            ),
          },
          {
            key: 'actions', header: t('common.actions', 'Actions'), align: 'end',
            cell: g => (
              <div className="u-row u-justify-end u-gap-1">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  onClick={e => { e.stopPropagation(); startEdit(g); }}
                  title={t('groups.editGroup')}
                  aria-label={t('groups.editGroup')}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-danger btn-sm btn-icon"
                  onClick={e => { e.stopPropagation(); handleDelete(g); }}
                  title={t('groups.deleteConfirm', { name: g.name })}
                  aria-label={t('common.delete', 'Delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ),
          },
        ]}
      />

      <Modal
        open={formOpen}
        onClose={resetForm}
        title={editingGroup ? t('groups.editGroup') : t('groups.addNewGroup')}
        icon={editingGroup ? <Pencil size={16} /> : <Group size={16} />}
        width="xl"
        footer={
          <>
            <button type="button" className="btn" onClick={resetForm}>
              {t('common.cancel')}
            </button>
            <button type="submit" form="group-form" className="btn btn-primary">
              <Save size={14} />
              {editingGroup ? t('groups.updateGroup') : t('groups.addGroup')}
            </button>
          </>
        }
      >
        <form id="group-form" onSubmit={handleCreateOrUpdate}>
          <Alert tone={message?.type === 'success' ? 'success' : 'error'} className="u-mb-4">{message?.text}</Alert>
          <p className="u-text-sm u-fg-muted u-mb-4">{t('groups.description')}</p>
          <FormSection title={t('groups.groupSection')} first>
            <FormRow>
              <FormField label={t('groups.groupName')} htmlFor="gp-group-name" required>
                <input
                  id="gp-group-name"
                  type="text"
                  className="form-input"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder={t('groups.namePlaceholder')}
                />
              </FormField>
            </FormRow>
          </FormSection>

          <FormSection title={t('groups.agentsQueues')}>
            <FormRow single>
              <FormField label={t('groups.agents')}>
                <Dropdown multiple size="md"
                  icon={Phone}
                  options={agentOptions}
                  value={form.agent_extensions}
                  onChange={agent_extensions => setForm(f => ({ ...f, agent_extensions }))}
                  placeholder={t('groups.selectAgents')}
                  emptyMessage={t('groups.noAgents')}
                  ariaLabel={t('groups.agents')}
                />
              </FormField>
            </FormRow>
            <FormRow single>
              <FormField label={t('groups.queues')}>
                <Dropdown multiple size="md"
                  icon={List}
                  options={queueOptions}
                  value={form.queue_extensions}
                  onChange={queue_extensions => setForm(f => ({ ...f, queue_extensions }))}
                  placeholder={t('groups.selectQueues')}
                  emptyMessage={t('groups.noQueues')}
                  ariaLabel={t('groups.queues')}
                />
              </FormField>
            </FormRow>
          </FormSection>

          <FormSection title={t('nav.users')}>
            <FormRow single>
              <FormField label={t('groups.usersInGroup')}>
                <Dropdown multiple size="md"
                  icon={Users}
                  options={userOptions}
                  value={form.user_ids}
                  onChange={user_ids => setForm(f => ({ ...f, user_ids }))}
                  placeholder={t('groups.selectUsers')}
                  emptyMessage={t('groups.noUsers')}
                  ariaLabel={t('groups.usersInGroup')}
                />
              </FormField>
            </FormRow>
          </FormSection>
        </form>
      </Modal>
      {confirmDialog}
    </Page>
  );
}
