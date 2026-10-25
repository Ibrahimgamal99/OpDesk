/**
 * Users + Groups list search. Renders the REAL ui/ shell (Page, Tabs, Toolbar,
 * SearchInput, Table, Badge) against the REAL stylesheets, with the same
 * `matches`/`prepareQuery` predicates the panels use, so a driver can type and
 * assert the list actually narrows.
 *
 * The panels themselves fetch on mount and gate on an admin session, so they are
 * not mounted directly; this reproduces their list tab with static rows.
 *
 * Not part of the app bundle; vite only sees it via harness/team.html.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Users, Group, Pencil, Trash2, Plus, ChevronDown } from 'lucide-react';
import {
  Page, Tabs, Toolbar, SearchInput, Table, Badge, EmptyState, matches, prepareQuery, type BadgeTone,
} from '../src/components/ui';
// Same set and order as src/main.tsx.
import '../src/styles/variables.css';
import '../src/styles/index.css';
import '../src/styles/classic-pages.css';
import '../src/styles/utilities.css';

const USERS = [
  { id: 1, username: 'ibrahim', name: 'Ibrahim Gamal', extension: '1001', role: 'admin', groups: ['Sales', 'Support'] },
  { id: 2, username: 'mona', name: 'Mona Adel', extension: '1005', role: 'supervisor', groups: ['Sales'] },
  { id: 3, username: 'karim', name: 'Karim Fouad', extension: '1012', role: 'agent', groups: [] },
];

const GROUPS = [
  { id: 1, name: 'Sales', agents: ['1005 (Mona Adel)', '1012 (Karim Fouad)'], queues: ['700 Inbound'], users: ['ibrahim', 'mona'] },
  { id: 2, name: 'Support', agents: ['1001 (Ibrahim Gamal)'], queues: ['701 Tech'], users: ['ibrahim'] },
];

const ROLE_TONE: Record<string, BadgeTone> = { admin: 'purple', supervisor: 'primary', agent: 'success' };

const noop = () => {};

function RowActions() {
  return (
    <div className="u-row u-justify-end u-gap-1">
      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Edit"><Pencil size={14} /></button>
      <button type="button" className="btn btn-ghost btn-danger btn-sm btn-icon" aria-label="Delete"><Trash2 size={14} /></button>
    </div>
  );
}

function TeamPage({ tab, count, search, setSearch, label, placeholder, children }: {
  tab: 'users' | 'groups'; count: number; search: string; setSearch: (v: string) => void;
  label: string; placeholder: string; children: React.ReactNode;
}) {
  return (
    <Page
      icon={Users}
      title="Teams"
      count={count}
      tabs={<Tabs tabs={[{ key: 'users', label: 'Users' }, { key: 'groups', label: 'Groups' }]} active={tab} onChange={noop} />}
      actions={<button type="button" className="btn btn-primary"><Plus size={14} />{tab === 'users' ? 'Add user' : 'Add group'}</button>}
      toolbar={
        <Toolbar search={
          <SearchInput urlSync={false} debounceMs={0} value={search} onChange={setSearch} label={label} placeholder={placeholder} />
        } />
      }
    >
      {children}
    </Page>
  );
}

function UsersList() {
  const [search, setSearch] = React.useState('');
  const filtered = React.useMemo(() => {
    const q = prepareQuery(search);
    return q ? USERS.filter(u => matches(q, u.username, u.name, u.extension, u.role, ...u.groups)) : USERS;
  }, [search]);

  return (
    <TeamPage tab="users" count={USERS.length} search={search} setSearch={setSearch}
      label="Search users" placeholder="Username, name, extension, group…">
      <div id={filtered.length ? 'users-list' : undefined}>
        <Table
          framed
          caption="Users"
          rows={filtered}
          rowKey={u => u.id}
          empty={<div id="users-empty"><EmptyState icon={Users} title={`No users match "${search}"`} /></div>}
          columns={[
            {
              key: 'name', header: 'Username', primary: true,
              cell: u => (
                <div className="u-min-w-0">
                  <div className="u-semibold u-truncate">{u.username}</div>
                  <div className="u-fg-muted u-text-sm u-truncate">{[u.name, u.extension].join(' · ')}</div>
                </div>
              ),
            },
            { key: 'role', header: 'Role', cell: u => <Badge tone={ROLE_TONE[u.role] ?? 'neutral'}>{u.role}</Badge> },
            {
              key: 'access', header: 'Access',
              cell: u => (
                <button type="button" className="btn btn-ghost btn-sm" title={u.groups.join(', ') || 'No groups'}>
                  {u.groups.length === 0 ? 'No groups' : u.groups.length === 1 ? '1 group' : `${u.groups.length} groups`}
                </button>
              ),
            },
            { key: 'actions', header: 'Actions', align: 'end', cell: () => <RowActions /> },
          ]}
        />
      </div>
    </TeamPage>
  );
}

function GroupsList() {
  const [search, setSearch] = React.useState('');
  // Every row expanded, as the old harness showed it, so the member chips render.
  const [expanded, setExpanded] = React.useState<Set<number>>(() => new Set(GROUPS.map(g => g.id)));
  const toggle = (id: number) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const filtered = React.useMemo(() => {
    const q = prepareQuery(search);
    return q ? GROUPS.filter(g => matches(q, g.name, ...g.agents, ...g.queues, ...g.users)) : GROUPS;
  }, [search]);

  const memberCell = (open: boolean, summary: string, chips: React.ReactNode[]) => {
    if (!open) return <span className="u-fg-secondary">{summary}</span>;
    if (chips.length === 0) return <span className="u-fg-muted">None</span>;
    return <div className="u-row u-wrap u-gap-1">{chips}</div>;
  };

  return (
    <TeamPage tab="groups" count={GROUPS.length} search={search} setSearch={setSearch}
      label="Search groups" placeholder="Group, agent, queue, user…">
      <div id={filtered.length ? 'groups-list' : undefined}>
        <Table
          framed
          caption="Groups"
          rows={filtered}
          rowKey={g => g.id}
          onRowClick={g => toggle(g.id)}
          empty={<div id="groups-empty"><EmptyState icon={Group} title={`No groups match "${search}"`} /></div>}
          columns={[
            {
              key: 'name', header: 'Group name', primary: true,
              cell: g => (
                <button type="button" className="btn btn-ghost btn-sm" aria-expanded={expanded.has(g.id)}
                  onClick={e => { e.stopPropagation(); toggle(g.id); }}>
                  <ChevronDown size={14} className={`gp-chevron${expanded.has(g.id) ? ' is-open' : ''}`} aria-hidden />
                  {g.name}
                </button>
              ),
            },
            {
              key: 'agents', header: 'Agents',
              cell: g => memberCell(expanded.has(g.id), `${g.agents.length} agents`,
                g.agents.map((a, i) => <Badge key={i} tone="primary" title={a}>{a}</Badge>)),
            },
            {
              key: 'queues', header: 'Queues',
              cell: g => memberCell(expanded.has(g.id), `${g.queues.length} queues`,
                g.queues.map((q, i) => <Badge key={i} tone="purple" title={q}>{q}</Badge>)),
            },
            {
              key: 'users', header: 'Users',
              cell: g => memberCell(expanded.has(g.id), `${g.users.length} users`,
                g.users.map((u, i) => <Badge key={i} title={u}>{u}</Badge>)),
            },
            { key: 'actions', header: 'Actions', align: 'end', cell: () => <RowActions /> },
          ]}
        />
      </div>
    </TeamPage>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 24, background: 'var(--bg-primary)' }}>
      <UsersList />
      <GroupsList />
    </div>
  </MemoryRouter>,
);
