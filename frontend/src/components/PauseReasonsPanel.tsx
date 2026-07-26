import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Save, X, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../auth';

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

interface FormState {
  id: number | null;
  code: string;
  label: string;
  productive: boolean;
  color: string;
  sort_order: number;
  is_active: boolean;
}

const EMPTY: FormState = { id: null, code: '', label: '', productive: false, color: '#d29922', sort_order: 100, is_active: true };

/** Admin management of Not-Ready Codes (pause reasons). */
export function PauseReasonsPanel() {
  const { t } = useTranslation();
  const [reasons, setReasons] = useState<PauseReason[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = () => {
    fetchWithAuth('/api/pause-reasons')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setReasons(d.reasons || []); })
      .catch(() => setMsg({ kind: 'err', text: t('notReady.loadFailed', 'Failed to load') }));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (r: PauseReason) => setForm({
    id: r.id, code: r.code, label: r.label, productive: !!r.productive,
    color: r.color || '#d29922', sort_order: r.sort_order, is_active: !!r.is_active,
  });

  const save = async () => {
    if (!form.label.trim() || (!form.id && !form.code.trim())) {
      setMsg({ kind: 'err', text: t('notReady.codeLabelRequired', 'Code and label are required') });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const isEdit = form.id != null;
      const url = isEdit ? `/api/pause-reasons/${form.id}` : '/api/pause-reasons';
      const method = isEdit ? 'PATCH' : 'POST';
      const body = isEdit
        ? { label: form.label, productive: form.productive, color: form.color, sort_order: form.sort_order, is_active: form.is_active }
        : { code: form.code.trim(), label: form.label, productive: form.productive, color: form.color, sort_order: form.sort_order, is_active: form.is_active };
      const res = await fetchWithAuth(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Failed');
      setForm(EMPTY);
      setMsg({ kind: 'ok', text: t('notReady.saved', 'Saved') });
      load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: PauseReason) => {
    if (r.is_system) return;
    if (!window.confirm(t('notReady.confirmDelete', 'Delete this code?'))) return;
    const res = await fetchWithAuth(`/api/pause-reasons/${r.id}`, { method: 'DELETE' });
    if (res.ok) { load(); if (form.id === r.id) setForm(EMPTY); }
    else setMsg({ kind: 'err', text: (await res.json().catch(() => ({}))).detail || 'Delete failed' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {msg && (
        <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13,
          background: msg.kind === 'ok' ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.12)',
          color: msg.kind === 'ok' ? 'var(--status-idle, #3fb950)' : 'var(--status-ringing, #f85149)' }}>
          {msg.text}
        </div>
      )}

      {/* Editor */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <Field label={t('notReady.code', 'Code')}>
          <input className="input" value={form.code} disabled={form.id != null}
            onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="break" style={{ width: 110 }} />
        </Field>
        <Field label={t('notReady.label', 'Label')}>
          <input className="input" value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Break" style={{ width: 150 }} />
        </Field>
        <Field label={t('notReady.color', 'Color')}>
          <input type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })}
            style={{ width: 42, height: 34, padding: 2, background: 'transparent', border: 'none' }} />
        </Field>
        <Field label={t('notReady.order', 'Order')}>
          <input className="input" type="number" value={form.sort_order}
            onChange={(e) => setForm({ ...form, sort_order: parseInt(e.target.value, 10) || 0 })} style={{ width: 70 }} />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={form.productive} onChange={(e) => setForm({ ...form, productive: e.target.checked })} />
          {t('notReady.productive', 'Productive')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
          {t('notReady.active', 'Active')}
        </label>
        <button type="button" className="btn" onClick={save} disabled={busy}
          style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {busy ? <Loader2 size={14} className="spinner" /> : form.id != null ? <Save size={14} /> : <Plus size={14} />}
          {form.id != null ? t('notReady.update', 'Update') : t('notReady.add', 'Add')}
        </button>
        {form.id != null && (
          <button type="button" className="btn btn-ghost" onClick={() => setForm(EMPTY)}>
            <X size={14} /> {t('notReady.cancel', 'Cancel')}
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {reasons.map((r) => (
          <div key={r.id} onClick={() => edit(r)} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer',
            background: 'var(--bg-card, rgba(255,255,255,0.03))', borderRadius: 8,
            border: '1px solid var(--border-color, rgba(255,255,255,0.08))', opacity: r.is_active ? 1 : 0.5,
          }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.color || '#d29922' }} />
            <span style={{ fontWeight: 600 }}>{r.label}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.code}</span>
            {!r.productive && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {t('agent.break', 'break')}</span>}
            {!!r.is_system && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {t('notReady.system', 'system')}</span>}
            <span style={{ marginLeft: 'auto' }} />
            {!r.is_system && (
              <button type="button" className="btn btn-icon btn-danger"
                onClick={(e) => { e.stopPropagation(); remove(r); }} title={t('notReady.delete', 'Delete')}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {reasons.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{t('notReady.none', 'No codes yet')}</div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </div>
  );
}
