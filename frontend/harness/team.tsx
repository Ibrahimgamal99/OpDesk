/**
 * Users + Groups list search. Renders the REAL panels' list markup and the REAL
 * ui/SearchInput against the REAL stylesheets, with the same filter predicates
 * the panels use, so a driver can type and assert the list actually narrows.
 *
 * The panels themselves fetch on mount and gate on an admin session, so they are
 * not mounted directly; this reproduces their list sub-tab with static rows.
 *
 * Not part of the app bundle; vite only sees it via harness/team.html.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Users, Group, Pencil, Trash2, Phone, List, ChevronDown } from 'lucide-react';
import { SearchInput } from '../src/components/ui';
import '../src/styles/index.css';

const USERS = [
  { id: 1, username: 'ibrahim', name: 'Ibrahim Gamal', extension: '1001', role: 'admin', groups: ['Sales', 'Support'] },
  { id: 2, username: 'mona', name: 'Mona Adel', extension: '1005', role: 'supervisor', groups: ['Sales'] },
  { id: 3, username: 'karim', name: 'Karim Fouad', extension: '1012', role: 'agent', groups: [] },
];

const GROUPS = [
  { id: 1, name: 'Sales', agents: ['1005 (Mona Adel)', '1012 (Karim Fouad)'], queues: ['700 Inbound'], users: ['ibrahim', 'mona'] },
  { id: 2, name: 'Support', agents: ['1001 (Ibrahim Gamal)'], queues: ['701 Tech'], users: ['ibrahim'] },
];

function UsersList() {
  const [search, setSearch] = React.useState('');
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return USERS;
    return USERS.filter(u => [u.username, u.name, u.extension, u.role, ...u.groups]
      .some(v => (v || '').toLowerCase().includes(q)));
  }, [search]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title"><Users size={16} className="panel-title-icon" />Users</h2>
      </div>
      <div className="panel-content">
        <div className="up-search">
          <SearchInput
            urlSync={false} debounceMs={0} value={search} onChange={setSearch}
            label="Search users" placeholder="Username, name, extension, group…"
          />
        </div>
        {filtered.length === 0 ? (
          <div className="up-empty" id="users-empty">No users match "{search}"</div>
        ) : (
          <div className="up-users-list" id="users-list">
            {filtered.map(u => (
              <div key={u.id} className="up-user-card">
                <div className="up-user-avatar">{u.username[0].toUpperCase()}</div>
                <div className="up-user-info">
                  <div className="up-user-name">{u.username}</div>
                  <div className="up-user-meta">{[u.name, u.extension].join(' · ')}</div>
                  <div className="up-user-badges">
                    <span className={`up-role-badge ${u.role}`}>{u.role}</span>
                    <button type="button" className="up-access-tag up-access-tag-btn">
                      {u.groups.length === 0 ? 'No groups' : `${u.groups.length} groups`}
                    </button>
                  </div>
                </div>
                <div className="up-user-actions">
                  <button className="btn btn-edit"><Pencil size={14} /></button>
                  <button className="btn btn-delete"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupsList() {
  const [search, setSearch] = React.useState('');
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.filter(g => [g.name, ...g.agents, ...g.queues, ...g.users]
      .some(v => (v || '').toLowerCase().includes(q)));
  }, [search]);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title"><Group size={16} className="panel-title-icon" />Groups</h2>
      </div>
      <div className="panel-content">
        <div className="up-search">
          <SearchInput
            urlSync={false} debounceMs={0} value={search} onChange={setSearch}
            label="Search groups" placeholder="Group, agent, queue, user…"
          />
        </div>
        {filtered.length === 0 ? (
          <div className="up-empty" id="groups-empty">No groups match "{search}"</div>
        ) : (
          <div className="up-users-list" id="groups-list">
            {filtered.map(g => (
              <div key={g.id} className="up-user-card">
                <div className="up-user-info" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className="up-user-avatar" style={{ background: 'var(--accent-teal)', color: 'var(--bg-primary)', flexShrink: 0 }}>
                      <Group size={20} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="up-user-name">{g.name}</span>
                        <ChevronDown size={18} style={{ color: 'var(--text-muted)' }} />
                      </div>
                      <div className="up-user-badges">
                        <span className="up-access-tag">{g.agents.length} agents</span>
                        <span className="up-access-tag">{g.queues.length} queues</span>
                        <span className="up-access-tag">{g.users.length} users</span>
                      </div>
                      <div className="gp-expanded">
                        <div className="gp-detail-grid">
                          <div className="gp-detail-section">
                            <div className="gp-detail-label"><Phone size={12} />Agents <span>({g.agents.length})</span></div>
                            <div className="gp-chips">
                              {g.agents.map((a, i) => <span key={i} className="gp-chip gp-chip-agent">{a}</span>)}
                            </div>
                          </div>
                          <div className="gp-detail-section">
                            <div className="gp-detail-label"><List size={12} />Queues <span>({g.queues.length})</span></div>
                            <div className="gp-chips">
                              {g.queues.map((q, i) => <span key={i} className="gp-chip gp-chip-queue">{q}</span>)}
                            </div>
                          </div>
                          <div className="gp-detail-section">
                            <div className="gp-detail-label"><Users size={12} />Users <span>({g.users.length})</span></div>
                            <div className="gp-chips">
                              {g.users.map((u, i) => <span key={i} className="gp-chip gp-chip-user">{u}</span>)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="up-user-actions">
                  <button className="btn btn-edit"><Pencil size={14} /></button>
                  <button className="btn btn-delete"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
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
