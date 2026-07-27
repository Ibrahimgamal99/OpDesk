import { useState, useEffect } from 'react';
import {
  Loader2, CheckCircle2, AlertCircle, KeyRound, Plus, Trash2, X, Copy, Check, Power,
  Pencil, RefreshCw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { fetchWithAuth } from '../auth';
import { Modal } from './ui';
import type { ApiKey } from '../types';

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
const SCOPE_GROUPS: { key: string; label: string; scopes: string[] }[] = [
  { key: 'calls', label: 'Calls & CDR', scopes: ['calls:read', 'calls:write', 'cdr:read'] },
  { key: 'analytics', label: 'Analytics', scopes: ['analytics:read'] },
];

const SCOPE_LABELS: Record<string, string> = {
  'calls:read': 'Read live calls, extensions, queues & status',
  'calls:write': 'Originate calls (click-to-call)',
  'cdr:read': 'Read call history & recordings',
  'analytics:read': 'Read analytics & exports',
};

// A checkbox that supports an indeterminate (some-but-not-all) state.
function TriCheck({ checked, indeterminate }: { checked: boolean; indeterminate: boolean }) {
  return (
    <div style={{
      width: 14, height: 14, borderRadius: 3, border: '1.5px solid var(--border-primary)',
      background: checked
        ? 'var(--accent-primary)'
        : indeterminate ? 'color-mix(in srgb, var(--accent-primary) 30%, transparent)' : 'transparent',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      {checked && <Check size={9} color="var(--text-on-accent)" strokeWidth={3} />}
      {!checked && indeterminate && (
        <span style={{ width: 6, height: 6, background: 'var(--accent-primary)', borderRadius: 1, display: 'block' }} />
      )}
    </div>
  );
}

function ScopesChecklist({ available, value, onChange }: {
  available: string[];
  value: string[];
  onChange: (scopes: string[]) => void;
}) {
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Toolbar: live count + quick presets */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="gp-chip" style={{ fontSize: 11 }}>{value.length} selected</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ak-preset" onClick={() => onChange(allSelected ? [] : [...available])}>
          Select all
        </button>
        <button type="button" className={`btn ak-preset${readOnlySelected ? ' btn-primary' : ''}`} onClick={() => onChange([...readScopes])}>
          Read-only
        </button>
        <button type="button" className="btn ak-preset" disabled={value.length === 0} onClick={() => onChange([])}>
          Clear
        </button>
      </div>

      {groups.map(group => {
        const allChecked = group.scopes.every(s => set.has(s));
        const someChecked = group.scopes.some(s => set.has(s));
        const groupCount = group.scopes.filter(s => set.has(s)).length;
        return (
          <div key={group.key}>
            <div className="ak-group-head" onClick={() => toggleGroup(group.scopes, allChecked)}>
              <TriCheck checked={allChecked} indeterminate={!allChecked && someChecked} />
              <span className="ak-group-label">{group.label}</span>
              {groupCount > 0 && (
                <span className="ak-group-count">{groupCount}/{group.scopes.length}</span>
              )}
            </div>
            <div className="ak-scope-grid">
              {group.scopes.map(scope => (
                <label key={scope} className="ak-scope">
                  <input
                    type="checkbox"
                    checked={set.has(scope)}
                    onChange={() => toggle(scope)}
                    style={{ width: 13, height: 13, accentColor: 'var(--accent-primary)', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <span className="ak-scope-label">{SCOPE_LABELS[scope] || scope}</span>
                  <span className="ak-scope-token">{scope}</span>
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
    return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>;
  }
  const shown = scopes.slice(0, 3);
  const rest = scopes.length - shown.length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
      {shown.map(s => (
        <span key={s} className="gp-chip gp-chip-queue" style={{ fontSize: 9, fontFamily: 'var(--font-mono)' }}>{s}</span>
      ))}
      {rest > 0 && <span className="gp-chip" style={{ fontSize: 9 }}>+{rest}</span>}
    </div>
  );
}

/** Convert an ISO timestamp to the YYYY-MM-DD value an <input type="date"> expects. */
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function isEnabled(k: ApiKey): boolean { return k.enabled === true || k.enabled === 1; }
const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');

/**
 * Management UI for machine-to-machine API keys — system credentials with explicit
 * permission scopes. The plaintext key is returned by the backend only once, on
 * creation, and shown in a copy-once modal; thereafter only the prefix is ever
 * displayed. Admin-only (mounted inside the Settings panel).
 */
export function ApiKeysPanel() {
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

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const [keysRes, permsRes] = await Promise.all([
        fetchWithAuth('/api/api-keys'),
        fetchWithAuth('/api/api-keys/permissions'),
      ]);
      if (!keysRes.ok) throw new Error('load failed');
      setKeys((await keysRes.json()).api_keys || []);
      if (permsRes.ok) setAvailable((await permsRes.json()).permissions || []);
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  function openCreate() { setEditing(null); setForm(blank); setModalOpen(true); }
  function openEdit(k: ApiKey) {
    setEditing(k);
    setForm({ name: k.name, scopes: k.scopes || [], expires_at: isoToDateInput(k.expires_at) });
    setModalOpen(true);
  }
  function closeModal() { setModalOpen(false); setEditing(null); setForm(blank); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setMessage({ type: 'error', text: 'Name is required' }); return; }
    if (form.scopes.length === 0) { setMessage({ type: 'error', text: 'Select at least one scope' }); return; }
    setSaving(true);
    try {
      if (editing) {
        // Send the plain YYYY-MM-DD (or '' to clear) — the backend normalizes it.
        const body = { name: form.name.trim(), scopes: form.scopes, expires_at: form.expires_at };
        const res = await fetchWithAuth(`/api/api-keys/${editing.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) throw await res.json().catch(() => ({}));
        closeModal();
        setMessage({ type: 'success', text: 'API key saved' });
        load();
      } else {
        const body: Record<string, unknown> = { name: form.name.trim(), scopes: form.scopes };
        if (form.expires_at) body.expires_at = form.expires_at;
        const res = await fetchWithAuth('/api/api-keys', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) throw await res.json().catch(() => ({}));
        const created: ApiKeyCreated = await res.json();
        closeModal();
        setCopied(false);
        setCreatedKey(created);
        load();
      }
    } catch (err: unknown) {
      const detail = (err as { detail?: string })?.detail || 'Failed to save API key';
      setMessage({ type: 'error', text: detail });
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
    } catch { setMessage({ type: 'error', text: 'Failed to update API key' }); }
  }

  async function handleDelete(k: ApiKey) {
    if (!window.confirm(`Revoke API key "${k.name}"? Any integration using it will stop working immediately.`)) return;
    try {
      const res = await fetchWithAuth(`/api/api-keys/${k.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error();
      setMessage({ type: 'success', text: 'API key revoked' });
      load();
    } catch { setMessage({ type: 'error', text: 'Failed to revoke API key' }); }
  }

  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be blocked; the field is selectable for manual copy */ }
  }

  if (loading) {
    return (
      <div className="ak-loading">
        <Loader2 size={28} className="spinner" /><span style={{ marginTop: 12 }}>Loading…</span>
      </div>
    );
  }

  return (
    <div>
      <div className="up-add-header">
        <div className="up-add-icon"><KeyRound size={22} /></div>
        <div style={{ flex: 1 }}>
          <h2 className="up-add-title">API Keys</h2>
          <p className="up-add-desc">
            Machine-to-machine credentials for the integration API, scoped to explicit permissions.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}><Plus size={14} /> Create</button>
      </div>

      <AnimatePresence>
        {message && (
          <motion.div
            className={`up-alert ${message.type}`}
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' }}
          >
            {message.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{message.text}</span>
            <button
              onClick={() => setMessage(null)}
              style={{ marginInlineStart: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', display: 'flex' }}
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {loadError ? (
        <div className="ak-loading">
          <AlertCircle size={32} style={{ color: 'var(--accent-danger)' }} />
          <span>Failed to load API keys.</span>
          <button className="btn btn-primary" onClick={load}><RefreshCw size={14} /> Retry</button>
        </div>
      ) : (
        <div className="cl-table-wrap">
          <table className="cl-table ak-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>Status</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k, idx) => (
                <tr key={k.id} className={idx % 2 === 0 ? 'cl-row-even' : 'cl-row-odd'}>
                  <td data-label="Name" style={{ fontWeight: 600 }}>{k.name}</td>
                  <td data-label="Key"><span className="ak-prefix">{k.key_prefix}…</span></td>
                  <td data-label="Scopes"><ScopeBadges scopes={k.scopes} /></td>
                  <td data-label="Last used" className="ak-dim">{fmtDate(k.last_used_at)}</td>
                  <td data-label="Expires" className="ak-dim">{k.expires_at ? fmtDate(k.expires_at) : 'Never'}</td>
                  <td data-label="Status">
                    <span className={`crm-badge ${isEnabled(k) ? 'on' : 'off'}`}>
                      {isEnabled(k) ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td data-label="">
                    <div className="ak-row-actions">
                      <button className="btn btn-icon" onClick={() => openEdit(k)} title="Edit"><Pencil size={13} /></button>
                      <button className="btn btn-icon" onClick={() => toggleEnabled(k)} title={isEnabled(k) ? 'Disable' : 'Enable'}>
                        <Power size={13} />
                      </button>
                      <button className="btn btn-icon ak-danger" onClick={() => handleDelete(k)} title="Revoke">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={7} data-label="" style={{ textAlign: 'center', padding: '48px 24px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                      <KeyRound size={32} style={{ opacity: 0.3 }} />
                      <span className="gp-empty-hint">No API keys yet. Create one to integrate with OpDesk.</span>
                      <button className="btn btn-primary" onClick={openCreate}><Plus size={14} /> Create</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / edit modal */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit API Key' : 'Create API Key'}
        icon={<KeyRound size={16} />}
        width="xl"
        footer={
          <>
            <button className="btn" onClick={closeModal}>Cancel</button>
            <button className="btn btn-primary" disabled={saving} onClick={handleSubmit}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {saving && <Loader2 size={14} className="spinner" />}
              {editing ? 'Save' : 'Create'}
            </button>
          </>
        }
      >
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <label className="ak-label">Name <span style={{ color: 'var(--accent-danger)' }}>*</span></label>
              <input
                className="form-input" value={form.name} autoFocus style={{ width: '100%' }}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Reporting integration"
              />
            </div>
            <div style={{ flex: '0 1 200px' }}>
              <label className="ak-label">Expires</label>
              <input
                className="form-input" type="date" value={form.expires_at}
                onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))}
              />
              <div className="gp-empty-hint" style={{ marginTop: 4 }}>Leave blank to never expire.</div>
            </div>
          </div>
          <div>
            <label className="ak-label">Scopes</label>
            <div className="gp-empty-hint" style={{ marginBottom: 8 }}>
              The key can only call endpoints covered by the scopes you grant. Settings, user
              management and the logs are never reachable with a key.
            </div>
            <ScopesChecklist
              available={available}
              value={form.scopes}
              onChange={scopes => setForm(f => ({ ...f, scopes }))}
            />
          </div>
        </form>
      </Modal>

      {/* One-time key reveal modal */}
      <Modal
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title="API Key Created"
        icon={<KeyRound size={16} />}
        footer={<button className="btn btn-primary" onClick={() => setCreatedKey(null)}>Done</button>}
      >
        <div className="up-alert error" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <AlertCircle size={16} />
          <span>Copy this key now — it will not be shown again.</span>
        </div>
        <label className="ak-label">Your key</label>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input
            className="form-input ak-key-reveal"
            readOnly
            value={createdKey?.key || ''}
            onFocus={e => e.target.select()}
          />
          <button
            type="button" onClick={copyKey} title="Copy"
            style={{
              position: 'absolute', insetInlineEnd: 8, background: 'none', border: 'none',
              cursor: 'pointer', padding: 0, display: 'flex',
              color: copied ? 'var(--accent-success)' : 'var(--text-muted)',
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </Modal>
    </div>
  );
}
