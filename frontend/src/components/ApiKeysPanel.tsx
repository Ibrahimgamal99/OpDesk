import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, KeyRound, Plus, Trash2, Copy, Check, Power, Pencil, RefreshCw, Save,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../auth';
import { Modal, Alert, Badge, Card, EmptyState, FormField, FormRow, Loading, Table, useConfirm } from './ui';
import type { SectionCard } from './SettingsPanel';
import type { ApiKey } from '../types';
import { raiseFor, toApiError } from '../lib/api';

interface ApiKeyCreated extends ApiKey { key: string; }

interface FormState {
  name: string;
  scopes: string[];
  expires_at: string; // YYYY-MM-DD or ''
}

const blank: FormState = { name: '', scopes: [], expires_at: '' };

// Scopes grouped for display. Only scopes the backend actually reports
// (GET /api/api-keys/permissions) are rendered; anything returned that has no group
// here falls into "Other", so this list degrading is cosmetic, not functional.
// `label` is the English default; the rendered text is settings.apiKeys.groups.<key>.
const SCOPE_GROUPS: { key: string; label: string; scopes: string[] }[] = [
  { key: 'calls', label: 'Calls & CDR', scopes: ['calls:read', 'calls:write', 'cdr:read'] },
  { key: 'analytics', label: 'Analytics', scopes: ['analytics:read'] },
  { key: 'contacts', label: 'Contacts', scopes: ['contacts:read', 'contacts:write'] },
];

// English defaults with their i18n keys (':' is i18next's namespace separator,
// so the raw scope cannot be a key).
const SCOPE_LABELS: Record<string, { key: string; label: string }> = {
  'calls:read': { key: 'settings.apiKeys.scopeLabels.calls_read', label: 'Read live calls, extensions, queues & status' },
  'calls:write': { key: 'settings.apiKeys.scopeLabels.calls_originate', label: 'Originate calls (click-to-call)' },
  'cdr:read': { key: 'settings.apiKeys.scopeLabels.cdr_read', label: 'Read call history & recordings' },
  'analytics:read': { key: 'settings.apiKeys.scopeLabels.analytics_read', label: 'Read analytics & exports' },
  'contacts:read': { key: 'settings.apiKeys.scopeLabels.contacts_read', label: 'Read the phonebook' },
  'contacts:write': { key: 'settings.apiKeys.scopeLabels.contacts_write', label: 'Push contacts into the phonebook' },
};

// A checkbox that supports an indeterminate (some-but-not-all) state.
function TriCheck({ checked, indeterminate }: { checked: boolean; indeterminate: boolean }) {
  return (
    <span className={`apikey-tricheck${checked ? ' is-checked' : indeterminate ? ' is-mixed' : ''}`} aria-hidden>
      {checked && <Check size={9} strokeWidth={3} />}
      {!checked && indeterminate && <span className="apikey-tricheck-mixed" />}
    </span>
  );
}

function ScopesChecklist({ available, value, onChange }: {
  available: string[];
  value: string[];
  onChange: (scopes: string[]) => void;
}) {
  const { t } = useTranslation();
  const set = new Set(value);
  const avail = new Set(available);

  const grouped = SCOPE_GROUPS
    .map(g => ({ ...g, scopes: g.scopes.filter(s => avail.has(s)) }))
    .filter(g => g.scopes.length > 0);
  const known = new Set(grouped.flatMap(g => g.scopes));
  const other = available.filter(s => !known.has(s));
  const groups = other.length > 0
    ? [...grouped, { key: 'other', label: 'Other', scopes: other }]
    : grouped;

  const readScopes = available.filter(s => s.endsWith(':read'));

  function toggle(scope: string) {
    const next = new Set(set);
    if (next.has(scope)) next.delete(scope); else next.add(scope);
    onChange(Array.from(next));
  }
  function toggleGroup(scopes: string[], allChecked: boolean) {
    const next = new Set(set);
    if (allChecked) scopes.forEach(s => next.delete(s));
    else scopes.forEach(s => next.add(s));
    onChange(Array.from(next));
  }

  const allSelected = available.length > 0 && available.every(s => set.has(s));
  const readOnlySelected = value.length > 0 && value.every(s => s.endsWith(':read'));

  return (
    <div className="u-col u-gap-4">
      {/* Toolbar: live count + quick presets */}
      <div className="u-row u-gap-2 u-wrap">
        <Badge tone="info">{t('settings.apiKeys.selectedCount', { defaultValue: '{{count}} selected', count: value.length })}</Badge>
        <div className="u-flex-1" />
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={allSelected}
          onClick={() => onChange(allSelected ? [] : [...available])}>{t('common.selectAll', 'Select all')}</button>
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={readOnlySelected}
          onClick={() => onChange([...readScopes])}>{t('settings.apiKeys.readOnly', 'Read-only')}</button>
        <button type="button" className="btn btn-ghost btn-sm"
          disabled={value.length === 0} onClick={() => onChange([])}>{t('common.clear', 'Clear')}</button>
      </div>

      {groups.map(group => {
        const allChecked = group.scopes.every(s => set.has(s));
        const someChecked = group.scopes.some(s => set.has(s));
        const groupCount = group.scopes.filter(s => set.has(s)).length;
        return (
          <div key={group.key}>
            {/* A real button: it toggles every scope in the group, so it must be
                keyboard-reachable and announced as a checkbox. */}
            <button
              type="button"
              role="checkbox"
              aria-checked={allChecked ? true : (someChecked ? 'mixed' : false)}
              onClick={() => toggleGroup(group.scopes, allChecked)}
              className="apikey-scope-group u-row u-gap-2 u-mb-1h u-pointer u-w-full u-start"
            >
              <TriCheck checked={allChecked} indeterminate={!allChecked && someChecked} />
              <span className="u-text-xs u-bold u-upper u-fg-muted">{t(`settings.apiKeys.groups.${group.key}`, group.label)}</span>
              {groupCount > 0 && (
                <span className="u-text-xs u-semibold u-fg-muted">{groupCount}/{group.scopes.length}</span>
              )}
            </button>
            <div className="apikey-scope-grid">
              {group.scopes.map(scope => (
                <label key={scope} className="u-row u-gap-2 u-pointer u-py-1">
                  <input
                    type="checkbox"
                    className="u-flex-none u-pointer"
                    checked={set.has(scope)}
                    onChange={() => toggle(scope)}
                  />
                  <span className="u-text-sm u-fg-secondary">
                    {SCOPE_LABELS[scope] ? t(SCOPE_LABELS[scope].key, SCOPE_LABELS[scope].label) : scope}
                  </span>
                  <span className="u-text-xs u-fg-muted u-mono">{scope}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  if (!scopes || scopes.length === 0) {
    return <span className="u-fg-muted u-text-xs">—</span>;
  }
  const shown = scopes.slice(0, 3);
  const rest = scopes.length - shown.length;
  return (
    <div className="u-row u-wrap u-gap-1">
      {shown.map(s => (
        <Badge key={s} tone="info" className="u-mono">{s}</Badge>
      ))}
      {rest > 0 && <Badge>+{rest}</Badge>}
    </div>
  );
}

/**
 * The YYYY-MM-DD an <input type="date"> expects, sliced from the server's timestamp. Never
 * through Date: the server sends a local wall-clock time without a zone, and toISOString()
 * would shift it to UTC (east of UTC, midnight becomes the previous day).
 */
function isoToDateInput(iso: string | null | undefined): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((iso || '').trim());
  return m ? m[1] : '';
}

function isEnabled(k: ApiKey): boolean { return k.enabled === true || k.enabled === 1; }
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');

export interface ApiKeysPanelProps {
  /** The section's Card header, from Settings. */
  card: SectionCard;
  /** The number of enabled keys after every load — for the Settings card's status line. */
  onCountChange?: (count: number) => void;
}

/**
 * Management UI for machine-to-machine API keys — system credentials with explicit
 * permission scopes. The plaintext key is returned by the backend only once, on
 * creation, and shown in a copy-once modal; thereafter only the prefix is ever
 * displayed. Admin-only (mounted inside the Settings panel).
 */
export function ApiKeysPanel({ card, onCountChange }: ApiKeysPanelProps) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ApiKey | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [saving, setSaving] = useState(false);
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const onCountRef = useRef(onCountChange);
  useEffect(() => { onCountRef.current = onCountChange; });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [keysRes, permsRes] = await Promise.all([
        fetchWithAuth('/api/api-keys'),
        fetchWithAuth('/api/api-keys/permissions'),
      ]);
      if (!keysRes.ok) throw new Error('load failed');
      const list: ApiKey[] = (await keysRes.json()).api_keys || [];
      setKeys(list);
      onCountRef.current?.(list.filter(isEnabled).length);
      if (permsRes.ok) setAvailable((await permsRes.json()).permissions || []);
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openCreate() { setMessage(null); setEditing(null); setForm(blank); setModalOpen(true); }
  function openEdit(k: ApiKey) {
    setMessage(null);
    setEditing(k);
    setForm({ name: k.name, scopes: k.scopes || [], expires_at: isoToDateInput(k.expires_at) });
    setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(blank); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setMessage({ type: 'error', text: t('settings.apiKeys.nameRequired', 'Name is required') }); return; }
    if (form.scopes.length === 0) { setMessage({ type: 'error', text: t('settings.apiKeys.scopeRequired', 'Select at least one scope') }); return; }
    setSaving(true);
    try {
      if (editing) {
        // Send the plain YYYY-MM-DD (or '' to clear) — the backend normalizes it — and
        // only when it changed, so saving a rename keeps an expiry's time of day.
        const body: Record<string, unknown> = { name: form.name.trim(), scopes: form.scopes };
        if (form.expires_at !== isoToDateInput(editing.expires_at)) body.expires_at = form.expires_at;
        const res = await fetchWithAuth(`/api/api-keys/${editing.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) await raiseFor(res);
        closeModal();
        setMessage({ type: 'success', text: t('settings.apiKeys.saved', 'API key saved') });
        load();
      } else {
        const body: Record<string, unknown> = { name: form.name.trim(), scopes: form.scopes };
        if (form.expires_at) body.expires_at = form.expires_at;
        const res = await fetchWithAuth('/api/api-keys', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) await raiseFor(res);
        const created: ApiKeyCreated = await res.json();
        closeModal();
        setCopied(false);
        setCreatedKey(created);
        load();
      }
    } catch (err: unknown) {
      setMessage({ type: 'error', text: toApiError(err).message });
    } finally { setSaving(false); }
  }

  async function toggleEnabled(k: ApiKey) {
    try {
      const res = await fetchWithAuth(`/api/api-keys/${k.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !isEnabled(k) }),
      });
      if (!res.ok) throw new Error();
      load();
    } catch { setMessage({ type: 'error', text: t('settings.apiKeys.updateFailed', 'Failed to update API key') }); }
  }

  async function handleDelete(k: ApiKey) {
    const ok = await confirm({
      title: t('settings.apiKeys.revokeTitle', 'Revoke API key?'),
      message: t('settings.apiKeys.revokeConfirmNow', {
        defaultValue: 'Revoke API key "{{name}}"? Any integration using it will stop working immediately.',
        name: k.name,
      }),
      confirmLabel: t('settings.apiKeys.revoke', 'Revoke'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (!ok) return;
    try {
      const res = await fetchWithAuth(`/api/api-keys/${k.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error();
      setMessage({ type: 'success', text: t('settings.apiKeys.revoked', 'API key revoked') });
      load();
    } catch { setMessage({ type: 'error', text: t('settings.apiKeys.revokeFailed', 'Failed to revoke API key') }); }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be blocked; the field is selectable for manual copy */ }
  }

  const createButton = (
    <button type="button" className="btn" onClick={openCreate}>
      <Plus size={14} /> {t('settings.apiKeys.add', 'Add key')}
    </button>
  );
  // Validation and save errors belong to the form while it is open, so they show
  // at the top of the Modal body instead of on the list behind it.
  const formMessage = modalOpen && message?.type === 'error' ? message : null;
  const listMessage = formMessage ? null : message;

  return (
    <Card {...card} flush actions={<>{card.actions}{createButton}</>}>
      <AnimatePresence>
        {listMessage && (
          <motion.div className="u-p-3" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Alert tone={listMessage.type === 'success' ? 'success' : 'error'} onDismiss={() => setMessage(null)}>
              {listMessage.text}
            </Alert>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <Loading size="sm" label={t('settings.loading', 'Loading…')} />
      ) : loadError ? (
        <div className="u-p-4">
          <Alert tone="error" action={<button type="button" className="btn" onClick={load}><RefreshCw size={14} /> {t('common.retry', 'Retry')}</button>}>
            {t('settings.apiKeys.loadFailed', 'Failed to load API keys.')}
          </Alert>
        </div>
      ) : (
        <Table
          caption={t('settings.home.title.apiKeys', 'API keys')}
          rows={keys}
          rowKey={k => k.id}
          empty={
            <EmptyState
              size="sm"
              icon={KeyRound}
              title={t('settings.apiKeys.emptyTitle', 'No API keys yet')}
              description={t('settings.apiKeys.emptyHintIntegrate', 'Add one to integrate with OpDesk.')}
              action={createButton}
            />
          }
          columns={[
            { key: 'name', header: t('settings.apiKeys.name', 'Name'), primary: true, cell: k => <span className="u-semibold">{k.name}</span> },
            { key: 'key', header: t('settings.apiKeys.key', 'Key'), cell: k => <span className="u-mono u-text-sm u-fg-muted">{k.key_prefix}…</span> },
            { key: 'scopes', header: t('settings.apiKeys.scopes', 'Scopes'), cell: k => <ScopeBadges scopes={k.scopes} /> },
            { key: 'used', header: t('settings.apiKeys.lastUsed', 'Last used'), hideOnMobile: true, cell: k => <span className="u-text-sm u-fg-muted">{fmtDate(k.last_used_at)}</span> },
            {
              key: 'expires', header: t('settings.apiKeys.expires', 'Expires'), hideOnMobile: true,
              cell: k => <span className="u-text-sm u-fg-muted">{k.expires_at ? fmtDate(k.expires_at) : t('settings.apiKeys.never', 'Never')}</span>,
            },
            {
              key: 'status', header: t('common.status', 'Status'),
              cell: k => <Badge tone={isEnabled(k) ? 'success' : 'neutral'}>{isEnabled(k) ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}</Badge>,
            },
            {
              key: 'actions', header: t('common.actions', 'Actions'), align: 'end',
              cell: k => (
                <div className="u-row u-gap-1 u-justify-end">
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => openEdit(k)}
                    title={t('common.edit', 'Edit')} aria-label={`${t('common.edit', 'Edit')} ${k.name}`}><Pencil size={14} /></button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => toggleEnabled(k)}
                    title={isEnabled(k) ? t('settings.apiKeys.disable', 'Disable') : t('settings.apiKeys.enable', 'Enable')}
                    aria-label={`${isEnabled(k) ? t('settings.apiKeys.disable', 'Disable') : t('settings.apiKeys.enable', 'Enable')} ${k.name}`}><Power size={14} /></button>
                  <button type="button" className="btn btn-ghost btn-danger btn-sm btn-icon" onClick={() => handleDelete(k)}
                    title={t('settings.apiKeys.revoke', 'Revoke')} aria-label={`${t('settings.apiKeys.revoke', 'Revoke')} ${k.name}`}><Trash2 size={14} /></button>
                </div>
              ),
            },
          ]}
        />
      )}

      {/* Create / edit modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? t('settings.apiKeys.editTitle', 'Edit API key') : t('settings.apiKeys.addTitle', 'Add API key')}
        icon={<KeyRound size={16} />}
        width="xl"
        footer={
          <>
            <button type="button" className="btn" onClick={closeModal}>{t('common.cancel', 'Cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSubmit}>
              {saving ? <Loader2 size={14} className="spinner" /> : editing ? <Save size={14} /> : <Plus size={14} />}
              {editing ? t('common.saveChanges', 'Save changes') : t('settings.apiKeys.add', 'Add key')}
            </button>
          </>
        }
      >
        <form onSubmit={handleSubmit} className="u-col u-gap-4">
          {formMessage && <Alert tone="error" onDismiss={() => setMessage(null)}>{formMessage.text}</Alert>}
          <FormRow>
            <FormField label={t('settings.apiKeys.name', 'Name')} htmlFor="ak-name" required>
              <input id="ak-name" className="form-input" value={form.name} autoFocus
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder={t('settings.apiKeys.namePlaceholder', 'e.g. Reporting integration')} />
            </FormField>
            <FormField label={t('settings.apiKeys.expires', 'Expires')} htmlFor="ak-expires" hint={t('settings.apiKeys.expiresHint', 'Leave blank to never expire.')}>
              <input id="ak-expires" className="form-input" type="date" value={form.expires_at}
                onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} />
            </FormField>
          </FormRow>
          <FormField label={t('settings.apiKeys.scopes', 'Scopes')}>
            <p className="up-hint u-mb-2">
              {t('settings.apiKeys.scopesHint', 'The key can only call endpoints covered by the scopes you grant.')}{' '}
              {t('settings.apiKeys.scopesNever', 'Settings, user management and the logs are never reachable with a key.')}
            </p>
            <ScopesChecklist available={available} value={form.scopes} onChange={scopes => setForm(f => ({ ...f, scopes }))} />
          </FormField>
        </form>
      </Modal>

      {/* One-time key reveal modal */}
      <Modal
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title={t('settings.apiKeys.createdTitle', 'API key created')}
        icon={<KeyRound size={16} />}
        footer={<button type="button" className="btn btn-primary" onClick={() => setCreatedKey(null)}>{t('common.done', 'Done')}</button>}
      >
        <Alert tone="warning" className="u-mb-3">
          {t('settings.apiKeys.copyNow', 'Copy this key now — it will not be shown again.')}
        </Alert>
        <FormField label={t('settings.apiKeys.yourKey', 'Your key')}>
          <div className="u-row u-gap-2">
            <input
              className="form-input u-flex-1 u-mono u-text-sm"
              readOnly
              value={createdKey?.key || ''}
              onFocus={e => e.target.select()}
              aria-label={t('settings.apiKeys.yourKey', 'Your key')}
            />
            <button type="button" className={`btn btn-icon${copied ? ' u-fg-success' : ''}`} onClick={copyKey}
              title={t('common.copy', 'Copy')} aria-label={t('settings.apiKeys.copyKey', 'Copy key')}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </FormField>
      </Modal>
      {confirmDialog}
    </Card>
  );
}
