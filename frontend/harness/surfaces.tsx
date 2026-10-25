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
import { BookUser, UserPlus, Radio, Search, Settings, ArrowUpDown } from 'lucide-react';
import {
  Page, SearchInput, Toolbar, Dropdown, RangePicker, Card, FormSection, FormRow, FormField,
} from '../src/components/ui';
// Same set and order as src/main.tsx.
import '../src/styles/variables.css';
import '../src/styles/index.css';
import '../src/styles/classic-pages.css';
import '../src/styles/utilities.css';

const OPTIONS = ['Sales', 'Support', 'Billing', 'Retention', 'Onboarding', 'Escalations',
  'Night shift', 'VIP', 'Callbacks', 'Surveys', 'Collections'].map(l => ({ value: l, label: l }));

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="u-fg-muted" style={{ font: '600 11px/2.4 monospace', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function App() {
  const [q, setQ] = React.useState('');
  const [one, setOne] = React.useState('');
  const [many, setMany] = React.useState<string[]>(['Sales']);
  const [range, setRange] = React.useState({ from: '2026-07-28', to: '2026-07-28' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 24, paddingBottom: 420, background: 'var(--bg-primary)' }}>
      {/* 1 — the page header and toolbar band: range trigger, search, single and
             multi Dropdown triggers side by side. */}
      <Group title="ui/Page band — RangePicker · SearchInput · Dropdown (single, multi)">
        <Page icon={BookUser} title="On a band" count={42}
          scope={
            <RangePicker value={range} onChange={setRange} label="Date range" customLabel="Custom" locale="en-US"
              presets={[{ key: 'today', label: 'Today', from: '2026-07-28', to: '2026-07-28' }]} />
          }
          toolbar={
            <Toolbar
              search={<SearchInput urlSync={false} value={q} onChange={setQ} label="Search" placeholder="Search calls…" />}
              filters={
                <>
                  <div><Dropdown size="md" value={one} onChange={setOne} ariaLabel="Status" placeholder="All statuses" options={OPTIONS} /></div>
                  <div data-active><Dropdown size="md" icon={ArrowUpDown} value="" onChange={() => {}} ariaLabel="Direction" options={[{ value: '', label: 'All directions' }]} /></div>
                  <div><Dropdown multiple size="md" value={many} onChange={setMany} ariaLabel="Groups" placeholder="Groups" options={OPTIONS} /></div>
                </>
              }
            />
          }
        >
          <div className="u-fg-muted">…body…</div>
        </Page>
      </Group>

      {/* 2 — Contacts' add/edit form, on the modal surface it opens in. Drawn
             statically (ui-modal markup) so it sits in flow without a scrim. */}
      <Group title="Contacts form — .ui-modal + FormField + .form-input">
        <div className="ui-modal" style={{ maxWidth: 520 }}>
          <div className="ui-modal-head">
            <div className="ui-modal-title-row">
              <span className="ui-modal-icon"><UserPlus size={16} /></span>
              <h3 className="ui-modal-title">Add contact</h3>
            </div>
          </div>
          <div className="ui-modal-body">
            <FormSection title="Details" first>
              <FormRow>
                <FormField label="Name" htmlFor="c-name" required>
                  <input id="c-name" type="text" className="form-input" placeholder="Jane Doe" />
                </FormField>
                <FormField label="Phone" htmlFor="c-phone" required>
                  <input id="c-phone" type="text" className="form-input" dir="ltr" defaultValue="+20 100 000 0000" />
                </FormField>
              </FormRow>
              <FormRow>
                <FormField label="Groups">
                  <Dropdown multiple size="md" value={many} onChange={setMany} ariaLabel="Groups" options={OPTIONS} />
                </FormField>
                <FormField label="Notes" htmlFor="c-notes">
                  <input id="c-notes" type="text" className="form-input" placeholder="Optional" />
                </FormField>
              </FormRow>
            </FormSection>
          </div>
        </div>
      </Group>

      {/* 3 — login card, the softphone's dial field and transfer field, and the
             CRM key-map input, none of which are ui/ components. */}
      <Group title="Login card · softphone dial + transfer · CRM key map">
        <div className="u-row u-wrap u-gap-4" style={{ alignItems: 'flex-start' }}>
          <Card className="login-panel" icon={Radio} title="OpDesk" description="Sign in with your extension">
            <FormRow single>
              <FormField label="Extension or username" htmlFor="l-user">
                <input id="l-user" type="text" className="form-input" placeholder="1001" />
              </FormField>
            </FormRow>
          </Card>
          <div className="softphone-panel" style={{ width: 320 }}>
            <div className="softphone-dial-area">
              <div className="softphone-search-wrap">
                <Search size={16} className="softphone-search-icon" />
                <input type="text" className="softphone-search-input" placeholder="Enter number" />
              </div>
              <input type="text" className="form-input sp-xfer-input" placeholder="Transfer to extension" aria-label="Transfer to extension" />
            </div>
          </div>
          <Card icon={Settings} title="CRM key map">
            <div className="crm-keymap-rows">
              <div className="crm-keymap-row">
                <span className="crm-keymap-label">Outcome</span>
                <code className="crm-keymap-default">BUSY</code>
                <span className="crm-keymap-arrow">→</span>
                <input type="text" className="crm-keymap-input" placeholder="BUSY" defaultValue="NO_ANSWER" aria-label="Send BUSY as" />
              </div>
            </div>
          </Card>
        </div>
      </Group>

      {/* 4 — the Dropdown's own filter box, which only exists while open. Held
             open (controlled, no onOpenChange) so the field is always visible. */}
      <Group title="Dropdown panel — filter box (held open)">
        <div style={{ width: 260 }}>
          <Dropdown open size="md" value={one} onChange={setOne} ariaLabel="Queue" placeholder="Pick a queue" options={OPTIONS} />
        </div>
      </Group>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter><App /></MemoryRouter>,
);
