import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Pause, ListX, Save, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import {
  Toggle, Modal, FormSection, FormRow, FormField, Alert, Table, Card, Badge, EmptyState, useActionError, useConfirm,
} from './ui';
import { raiseFor } from '../lib/api';
import type { SectionCard } from './SettingsPanel';
import type { PauseReason } from '../types';

const truthy = (v: number | boolean | undefined) => v === true || v === 1;

interface ReasonForm { code: string; label: string; productive: boolean; color: string; active: boolean; sort_order: number; }

/**
 * `color` is persisted per-reason and edited through `<input type="color">`,
 * which only accepts a literal `#rrggbb` — a `var(--token)` is invalid there
 * and would silently reset the swatch to black. So this hex literal is user
 * data, not styling, and is exempt from the Rule 1 token requirement.
 */
// eslint-disable-next-line no-restricted-syntax -- persisted data value, see above
const DEFAULT_REASON_COLOR = '#d29922';

const blank: ReasonForm = { code: '', label: '', productive: false, color: DEFAULT_REASON_COLOR, active: true, sort_order: 0 };

/** Codes starting with this prefix belong to the system (`__WRAPUP`); the backend refuses them. */
const RESERVED_PREFIX = '__';

export interface PauseReasonsPanelProps {
  /** The section's Card header, from Settings. Without it the Card is titled "Reason codes". */
  card?: SectionCard;
  /** The number of active codes after every load — for the Settings card's status line. */
  onCountChange?: (count: number) => void;
}

/**
 * Admin CRUD for Not-Ready / pause reason codes (table + modal). Agents pick
 * these when going Not-Ready; the `productive` flag separates paid work from
 * breaks in the Agent Adherence report. The list asks for the system codes too
 * (`include_system=true`, e.g. the wrap-up pause), which are shown read-only.
 */
export function PauseReasonsPanel({ card, onCountChange }: PauseReasonsPanelProps = {}) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const [items, setItems] = useState<PauseReason[]>([]);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<PauseReason | null>(null);
  const [form, setForm] = useState<ReasonForm>(blank);
  const [saving, setSaving] = useState(false);
  const { error, run, clear } = useActionError();

  const onCountRef = useRef(onCountChange);
  useEffect(() => { onCountRef.current = onCountChange; });

  const load = useCallback(() => {
    fetchWithAuth('/api/pause-reasons?include_system=true')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const list: PauseReason[] = d.reasons || [];
        setItems(list);
        // The Settings card counts what agents can pick: active, not system-owned.
        onCountRef.current?.(list.filter(r => truthy(r.is_active) && !truthy(r.is_system)).length);
      })
      .catch(() => { /* transient — table just stays as-is */ });
  }, []);
  useEffect(load, [load]);

  const openCreate = () => { clear(); setForm(blank); setEditing(null); setModal('create'); };
  const openEdit = (r: PauseReason) => {
    clear();
    setForm({
      code: r.code,
      label: r.label,
      productive: truthy(r.productive),
      color: r.color || DEFAULT_REASON_COLOR,
      active: truthy(r.is_active),
      sort_order: r.sort_order || 0,
    });
    setEditing(r);
    setModal('edit');
  };

  const reservedCode = modal === 'create' && form.code.trim().startsWith(RESERVED_PREFIX);

  const save = async () => {
    if (!form.label.trim() || (modal === 'create' && !form.code.trim()) || reservedCode) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        label: form.label.trim(),
        productive: form.productive,
        color: form.color,
        is_active: form.active,
        sort_order: form.sort_order,
      };
      const ok = await run(async () => {
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
        if (!res.ok) await raiseFor(res);
        return true;
      }, t('notReady.saveFailed', 'Save failed'));
      if (ok) { setModal(null); load(); }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: PauseReason) => {
    if (truthy(r.is_system)) return;
    const confirmed = await confirm({
      title: t('agent.codes.deleteTitle', 'Delete reason code?'),
      message: t('notReady.confirmDelete', 'Delete this reason code?'),
      confirmLabel: t('common.delete', 'Delete'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (!confirmed) return;
    const ok = await run(async () => {
      const res = await fetchWithAuth(`/api/pause-reasons/${r.id}`, { method: 'DELETE' });
      if (!res.ok) await raiseFor(res);
      return true;
    }, t('agent.codes.deleteFailed', 'Could not delete that reason code.'));
    if (ok) load();
  };

  const canSave = !!form.label.trim() && (modal !== 'create' || !!form.code.trim()) && !reservedCode;

  const addButton = (
    <button type="button" className="btn" onClick={openCreate}>
      <Plus size={14} /> {t('notReady.add', 'Add code')}
    </button>
  );

  return (
    <Card
      flush
      icon={card?.icon ?? Pause}
      title={card?.title ?? t('agent.codes.listTitle', 'Reason codes')}
      description={card?.description ?? t('notReady.subtitle', 'Reason codes agents pick when going Not-Ready. Productive codes count toward paid work; breaks do not.')}
      actions={<>{card?.actions}{addButton}</>}
    >
      {/* While the form is open its errors show at the top of the Modal instead. */}
      {error && !modal && <div className="u-p-3"><Alert onDismiss={clear}>{error}</Alert></div>}

      <Table
        density="default"
        caption={t('notReady.title', 'Not-Ready Codes')}
        rows={items}
        rowKey={r => r.id}
        rowClassName={r => (truthy(r.is_active) ? undefined : 'notes-row-inactive')}
        empty={
          <EmptyState
            size="sm"
            icon={ListX}
            title={t('notReady.none', 'No codes yet')}
            description={t('notReady.subtitle', 'Reason codes agents pick when going Not-Ready. Productive codes count toward paid work; breaks do not.')}
            action={addButton}
          />
        }
        columns={[
          {
            key: 'code', header: t('notReady.code', 'Code'), primary: true,
            cell: r => (
              <>
                <span className="agent-bar-dot pr-code-dot" style={{ '--dot-color': r.color || 'var(--text-muted)' } as React.CSSProperties} />
                <span dir="ltr">{r.code}</span>
                {truthy(r.is_system) && (
                  <Badge className="u-ms-1h" title={t('notReady.systemHint', 'Used by OpDesk itself; it cannot be edited or deleted.')}>
                    {t('notReady.system', 'System')}
                  </Badge>
                )}
              </>
            ),
          },
          { key: 'label', header: t('notReady.label', 'Label'), cell: r => r.label },
          {
            key: 'productive', header: t('notReady.productive', 'Productive'),
            cell: r => truthy(r.productive)
              ? <Badge tone="success">{t('notReady.yes', 'Yes')}</Badge>
              : <Badge>{t('notReady.break', 'Break')}</Badge>,
          },
          {
            key: 'active', header: t('notReady.active', 'Active'),
            cell: r => (
              <Badge tone={truthy(r.is_active) ? 'success' : 'neutral'}>
                {truthy(r.is_active) ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
              </Badge>
            ),
          },
          {
            key: 'actions', header: t('common.actions', 'Actions'), align: 'end',
            cell: r => (
              <div className="notes-row-actions">
                {truthy(r.is_system) ? (
                  <span className="notes-muted">—</span>
                ) : (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => openEdit(r)}
                      title={t('common.edit', 'Edit')} aria-label={t('common.edit', 'Edit')}><Pencil size={14} /></button>
                    <button type="button" className="btn btn-ghost btn-danger btn-sm btn-icon" onClick={() => remove(r)}
                      title={t('common.delete', 'Delete')} aria-label={t('common.delete', 'Delete')}><Trash2 size={14} /></button>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />

      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={modal === 'create' ? t('notReady.addTitle', 'New reason code') : t('notReady.editTitle', 'Edit reason code')}
        icon={<Pause size={16} />}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setModal(null)}>{t('common.cancel', 'Cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !canSave}>
              {saving ? <Loader2 size={14} className="spinner" /> : modal === 'create' ? <Plus size={14} /> : <Save size={14} />}
              {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
            </button>
          </>
        }
      >
        {error && <Alert className="u-mb-3" onDismiss={clear}>{error}</Alert>}

        <FormSection title={t('notReady.basic', 'Basic')} first>
          <FormRow>
            <FormField
              label={t('notReady.code', 'Code')}
              required
              hint={reservedCode ? t('notReady.reservedCode', 'Codes starting with __ are reserved for the system.') : undefined}
            >
              <input className="form-input" dir="ltr" value={form.code} disabled={modal === 'edit'}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.replace(/\s+/g, '_').toLowerCase() }))}
                placeholder="break" />
            </FormField>
            <FormField label={t('notReady.label', 'Label')} required>
              <input className="form-input" value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder={t('agent.codes.labelPlaceholder', 'Break')} />
            </FormField>
          </FormRow>
          <FormRow>
            <FormField label={t('notReady.color', 'Color')}>
              <input type="color" className="form-input" value={form.color}
                onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))} />
            </FormField>
            <FormField label={t('notReady.order', 'Sort order')}>
              <input type="number" className="form-input" value={form.sort_order}
                onChange={(e) => setForm((f) => ({ ...f, sort_order: parseInt(e.target.value, 10) || 0 }))} />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection title={t('common.status', 'Status')}>
          <FormRow single>
            <Toggle checked={form.productive} onChange={(v) => setForm((f) => ({ ...f, productive: v }))}
              label={t('notReady.productive', 'Productive')}
              description={t('notReady.productiveHint', 'Counts as paid work (e.g. Meeting, Training) rather than a break in adherence.')} />
          </FormRow>
          <FormRow single>
            <Toggle checked={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))}
              label={form.active ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
              description={t('notReady.activeHint', 'Inactive codes are hidden from the agent picker.')} />
          </FormRow>
        </FormSection>
      </Modal>
      {confirmDialog}
    </Card>
  );
}
