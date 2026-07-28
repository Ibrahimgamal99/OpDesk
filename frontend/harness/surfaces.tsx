/**
 * Every text-entry control in the product, on the surface it actually sits on,
 * so `--control-surface` can be judged in one look instead of screen by screen.
 * Renders the real components against the real stylesheets.
 *
 * Not part of the app bundle; vite only sees it via harness/surfaces.html.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { BookUser, UserPlus, Phone } from 'lucide-react';
import { Page, SearchInput, Toolbar } from '../src/components/ui';
import { FilterSelect } from '../src/components/FilterSelect';
import '../src/styles/index.css';
import '../src/styles/analytics.css';

const noop = () => {};

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ font: '600 11px/2.4 monospace', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function App() {
  const [q, setQ] = React.useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 24, background: 'var(--bg-primary)' }}>
      {/* 1 — the toolbar band: search beside a size="md" FilterSelect. These were
             --bg-primary and --bg-tertiary respectively. */}
      <Group title="ui/Toolbar band — search + filters">
        <Page icon={<BookUser size={18} />} title="On a band"
          toolbar={
            <Toolbar
              search={<SearchInput urlSync={false} value={q} onChange={setQ} label="Search" placeholder="Search calls…" />}
              filters={[
                { key: 'a', label: 'Status', control: <FilterSelect size="md" value="" onChange={noop} options={[{ value: '', label: 'All statuses' }]} /> },
                { key: 'b', label: 'Direction', active: true, control: <FilterSelect size="md" value="" onChange={noop} options={[{ value: '', label: 'All directions' }]} /> },
              ]}
            />
          }
        >
          <div style={{ padding: 24, color: 'var(--text-muted)' }}>…body…</div>
        </Page>
      </Group>

      {/* 2 — Contacts: the panel chrome it still uses, with the migrated search
             and the form fields that share the same surface token. */}
      <Group title="Contacts — .panel + ui/SearchInput + .form-input">
        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title"><BookUser size={16} className="panel-title-icon" />Contacts</h2>
          </div>
          <div className="panel-content">
            <div className="cn-search">
              <SearchInput urlSync={false} value={q} onChange={setQ} label="Search contacts" placeholder="Search contacts…" />
            </div>

            <div className="up-add-card">
              <div className="up-add-header">
                <div className="up-add-icon"><UserPlus size={24} /></div>
                <div>
                  <h2 className="up-add-title">Add contact</h2>
                  <p className="up-add-desc">Fields use the same surface as the search above.</p>
                </div>
              </div>
              <div className="up-add-body">
                <div className="up-form-row">
                  <div className="up-form-group">
                    <label>Name</label>
                    <input type="text" className="form-input" placeholder="Jane Doe" />
                  </div>
                  <div className="up-form-group">
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Phone size={14} />Phone</label>
                    <input type="text" className="form-input" defaultValue="+20 100 000 0000" />
                  </div>
                </div>
                <div className="up-form-group">
                  <label>Notes</label>
                  <textarea className="form-input" rows={2} placeholder="Optional" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </Group>

      {/* 3 — the two that were never on the ui/ layer at all. */}
      <Group title="Softphone search · login input · drilldown filter">
        <div className="panel">
          <div className="panel-content" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="softphone-search-wrap">
              <input className="softphone-search-input" placeholder="Search or dial…" />
            </div>
            <input className="login-input" placeholder="Username" />
            <input className="an-filter-input" placeholder="Filter rows…" />
          </div>
        </div>
      </Group>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter><App /></MemoryRouter>,
);
