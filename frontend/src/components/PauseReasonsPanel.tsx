import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Edit2, Trash2, Pause } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import { Modal, Toggle, FormSection, FormRow, FormField } from './ui';

interface PauseReason {
  id: number;
  code: string;
  label: string;
  productive: number | boolean;
  color?: string | null;
  sort_order: number;
  is_active: number | boolean;
  is_system: number | boolean;
}

const truthy = (v: number | boolean | undefined) => v === true || v === 1;

interface ReasonForm { code: string; label: string; productive: boolean; color: string; active: boolean; sort_order: number; }

/**
 * `color` is persisted per-reason and edited through `<input type="color">`,
 * which only accepts a literal `#rrggbb` — a `var(--token)` is invalid there
 * and would silently reset the swatch to black. So these two hex literals are
 * user data, not styling, and are exempt from the Rule 1 token requirement.
 */
// eslint-disable-next-line no-restricted-syntax -- persisted data value, see above
const DEFAULT_REASON_COLOR = '#d29922';

const blank: ReasonForm = { code: '', label: '', productive: false, color: DEFAULT_REASON_COLOR, active: true, sort_order: 100 };

/**
 * Admin CRUD for Not-Ready / pause reason codes (echo-parity table + modal).
 * Agents pick these when going Not-Ready; the `productive` flag separates paid
 * work from breaks in the Agent Adherence report. System codes are read-only.
 */
export function PauseReasonsPanel() {
  const { t } = useTranslation();
  const [items, setItems] = useState<PauseReason[]>([]);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<PauseReason | null>(null);
  const [form, setForm] = useState<ReasonForm>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchWithAuth('/api/pause-reasons')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setItems(d.reasons || []); })
      .catch(() => { /* transient — table just stays as-is */ });
  }, []);
  useEffect(load, [load]);

  const openCreate = () => { setForm(blank); setEditing(null); setError(null); setModal('create'); };
  const openEdit = (r: PauseReason) => {
    setForm({
      code: r.code,
      label: r.label,
      productive: truthy(r.productive),
      color: r.color || DEFAULT_REASON_COLOR,
      active: truthy(r.is_active),
      sort_order: r.sort_order || 0,
    });
    setEditing(r);
    setError(null);
    setModal('edit');
  };

  const save = async () => {
    if (!form.label.trim() || (modal === 'create' && !form.code.trim())) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        label: form.label.trim(),
        productive: form.productive,
        color: form.color,
        is_active: form.active,
        sort_order: form.sort_order,
      };
      const res = modal === 'create'
        ? await fetchWithAuth('/api/pause-reasons', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, code: form.code.trim() }),
          })
        : await fetchWithAuth(`/api/pause-reasons/${editing!.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))).detail;
        throw new Error(detail || t('notReady.saveFailed', 'Save failed'));
      }
      setModal(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notReady.saveFailed', 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: PauseReason) => {
    if (truthy(r.is_system)) return;
    if (!window.confirm(t('notReady.confirmDelete', 'Delete this reason code?'))) return;
    const res = await fetchWithAuth(`/api/pause-reasons/${r.id}`, { method: 'DELETE' });
    if (res.ok) load();
  };

  const canSave = !!form.label.trim() && (modal !== 'create' || !!form.code.trim());

  return (
    <div>
      <div className="notes-toolbar">
        <span className="panel-subtitle">
          {t('notReady.subtitle', 'Reason codes agents pick when going Not-Ready. Productive codes count toward paid work; breaks do not.')}
        </span>
        <button type="button" className="btn btn-primary notes-toolbar-action" onClick={openCreate}>
          <Plus size={14} /> {t('notReady.add', 'Add code')}
        </button>
      </div>

      <div className="settings-users-table-wrap">
        <table className="settings-users-table">
          <thead>
            <tr>
              <th>{t('notReady.code', 'Code')}</th>
              <th>{t('notReady.label', 'Label')}</th>
              <th>{t('notReady.productive', 'Productive')}</th>
              <th>{t('notReady.active', 'Active')}</th>
              <th style={{ textAlign: 'end' }}>{t('notReady.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className={truthy(r.is_active) ? undefined : 'notes-row-inactive'}>
                <td className="notes-cell-strong">
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
                    background: r.color || 'var(--text-muted)', marginInlineEnd: 8, verticalAlign: 'middle',
                  }} />
                  <span dir="ltr">{r.code}</span>
                  {truthy(r.is_system) && (
                    <span className="badge badge-muted" style={{ marginInlineStart: 6 }}>{t('notReady.system', 'System')}</span>
                  )}
                </td>
                <td>{r.label}</td>
                <td>
                  {truthy(r.productive)
                    ? <span className="badge badge-success">{t('notReady.yes', 'Yes')}</span>
                    : <span className="badge badge-muted">{t('notReady.break', 'Break')}</span>}
                </td>
                <td>
                  <span className={`badge ${truthy(r.is_active) ? 'badge-success' : 'badge-muted'}`}>
                    {truthy(r.is_active) ? t('notReady.enabled', 'Enabled') : t('notReady.disabled', 'Disabled')}
                  </span>
                </td>
                <td>
                  <div className="notes-row-actions">
                    {truthy(r.is_system) ? (
                      <span className="notes-muted">—</span>
                    ) : (
                      <>
                        <button type="button" className="btn btn-icon" onClick={() => openEdit(r)} title={t('notReady.edit', 'Edit')}>
                          <Edit2 size={13} />
                        </button>
                        <button type="button" className="btn btn-icon" onClick={() => remove(r)} title={t('notReady.delete', 'Delete')}>
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="notes-table-empty">{t('notReady.none', 'No codes yet')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'create' ? t('notReady.addTitle', 'New reason code') : t('notReady.editTitle', 'Edit reason code')}
        icon={<Pause size={16} />}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setModal(null)}>{t('notReady.cancel', 'Cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !canSave}>
              {saving ? t('notReady.saving', 'Saving…') : t('notReady.save', 'Save')}
            </button>
          </>
        }
      >
        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12,
            background: 'var(--status-ringing-bg)', color: 'var(--status-ringing)' }}>
            {error}
          </div>
        )}

        <FormSection title={t('notReady.basic', 'Basic')} first>
          <FormRow>
            <FormField label={t('notReady.code', 'Code')} required>
              <input className="form-input" dir="ltr" value={form.code} disabled={modal === 'edit'}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/\s+/g, '_').toLowerCase() }))}
                placeholder="break" />
            </FormField>
            <FormField label={t('notReady.label', 'Label')} required>
              <input className="form-input" value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="Break" />
            </FormField>
          </FormRow>
          <FormRow>
            <FormField label={t('notReady.color', 'Color')}>
              <input type="color" className="form-input" value={form.color}
                onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} style={{ height: 38, padding: 2 }} />
            </FormField>
            <FormField label={t('notReady.order', 'Sort order')}>
              <input type="number" className="form-input" value={form.sort_order}
                onChange={(e) => setForm((f) => ({ ...f, sort_order: parseInt(e.target.value, 10) || 0 }))} />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection title={t('notReady.status', 'Status')}>
          <FormRow single>
            <Toggle checked={form.productive} onChange={(v) => setForm((f) => ({ ...f, productive: v }))}
              label={t('notReady.productive', 'Productive')}
              description={t('notReady.productiveHint', 'Counts as paid work (e.g. Meeting, Training) rather than a break in adherence.')} />
          </FormRow>
          <FormRow single>
            <Toggle checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))}
              label={form.active ? t('notReady.enabled', 'Enabled') : t('notReady.disabled', 'Disabled')}
              description={t('notReady.activeHint', 'Inactive codes are hidden from the agent picker.')} />
          </FormRow>
        </FormSection>
      </Modal>
    </div>
  );
}
