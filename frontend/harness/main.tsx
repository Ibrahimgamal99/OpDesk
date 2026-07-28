/**
 * Visual harness for the page-shell primitives. Renders the REAL ui/ components
 * against the REAL stylesheets, with static props so no backend or auth is
 * needed. It verifies the shell's rendered output and CSS — not the three
 * panels' data fetching, which this deliberately does not exercise.
 *
 * Not part of the app bundle; vite only sees it via harness/index.html.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Terminal, History, BarChart3, Tag, Download, Trash2, Pause } from 'lucide-react';
import { Page, Toolbar, SearchInput, Stat, Tabs, RangePicker } from '../src/components/ui';
import { FilterSelect } from '../src/components/FilterSelect';
import '../src/styles/index.css';
import '../src/styles/analytics.css';

const noop = () => {};

/** RangePicker with the app's real preset shape, fixed dates so shots diff. */
function Range() {
  const [v, setV] = React.useState({ from: '2026-07-28', to: '2026-07-28' });
  return (
    <RangePicker
      value={v}
      onChange={setV}
      label="Date range"
      customLabel="Custom"
      max="2026-07-28"
      locale="en-US"
      presets={[
        { key: 'today', label: 'Today', from: '2026-07-28', to: '2026-07-28' },
        { key: 'yesterday', label: 'Yesterday', from: '2026-07-27', to: '2026-07-27' },
        { key: '7d', label: 'Last 7 Days', from: '2026-07-22', to: '2026-07-28' },
        { key: '30d', label: 'Last 30 Days', from: '2026-06-29', to: '2026-07-28' },
        { key: 'month', label: 'This Month', from: '2026-07-01', to: '2026-07-28' },
      ]}
    />
  );
}

/** Commit counter, so a driver can assert the debounce coalesces keystrokes. */
declare global {
  interface Window { __commits?: number; __lastCommit?: string }
}

function Screen({ which }: { which: 'ami' | 'calls' | 'analytics' }) {
  const [q, setQRaw] = React.useState('');
  const setQ = (v: string) => {
    window.__commits = (window.__commits ?? 0) + 1;
    window.__lastCommit = v;
    setQRaw(v);
  };

  if (which === 'ami') {
    return (
      <Page
        icon={<Terminal size={18} />}
        title="AMI Event Stream"
        status={<span className="lg-badge lg-badge-live">Live</span>}
        tabs={<Tabs tabs={[{ key: 'a', label: 'System', icon: <Terminal size={14} /> }, { key: 'b', label: 'CRM Deliveries' }]} active="a" onChange={noop} />}
        toolbar={
          <Toolbar
            search={<SearchInput urlSync={false} value={q} onChange={setQ} label="Search" placeholder="Channel, caller ID, queue…" />}
            filters={[{ key: 'event', label: 'Event type', control: <FilterSelect size="md" value="" onChange={noop} icon={Tag} options={[{ value: '', label: 'All events' }]} /> }]}
            actions={[
              <button className="btn btn-primary"><Terminal size={13} />AMI On</button>,
              <button className="btn btn-ghost"><Pause size={13} />Pause</button>,
              <button className="btn btn-ghost"><Download size={13} />Export</button>,
              <button className="btn btn-ghost"><Trash2 size={13} />Clear</button>,
            ]}
          />
        }
      >
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>…stream body…</div>
      </Page>
    );
  }

  if (which === 'calls') {
    return (
      <Page
        icon={<History size={18} />}
        title="Call History"
        scope={<Range />}
        actions={<Stat value={13} label="Total calls" />}
        toolbar={
          <Toolbar
            search={<SearchInput urlSync={false} value={q} onChange={setQ} label="Search calls" placeholder="Search calls…" />}
            filters={[
              { key: 'status', label: 'Status', active: true, control: <FilterSelect size="md" value="" onChange={noop} options={[{ value: '', label: 'All statuses' }]} /> },
              { key: 'direction', label: 'Direction', active: true, control: <FilterSelect size="md" value="" onChange={noop} options={[{ value: '', label: 'All directions' }]} /> },
              { key: 'app', label: 'Application', control: <FilterSelect size="md" value="" onChange={noop} options={[{ value: '', label: 'All apps' }]} /> },
            ]}
            actions={[<button className="btn btn-ghost">Newest</button>]}
          />
        }
      >
        <div style={{ padding: 24, color: 'var(--text-muted)' }}>…table…</div>
      </Page>
    );
  }

  return (
    <Page
      icon={<BarChart3 size={18} />}
      title="Analytics"
      tabs={<Tabs tabs={[{ key: 'o', label: 'Overview' }, { key: 'q', label: 'Queues' }, { key: 'a', label: 'Agents' }]} active="o" onChange={noop} />}
      scope={<Range />}
    >
      <div style={{ padding: 24, color: 'var(--text-muted)' }}>…charts…</div>
    </Page>
  );
}

function App() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 24, background: 'var(--bg-primary)' }}>
      <Screen which="ami" />
      <Screen which="calls" />
      <Screen which="analytics" />
    </div>
  );
}

// SearchInput syncs ?q=, so it needs a Router ancestor. MemoryRouter keeps the
// harness from touching the real address bar.
createRoot(document.getElementById('root')!).render(
  <MemoryRouter><App /></MemoryRouter>,
);
