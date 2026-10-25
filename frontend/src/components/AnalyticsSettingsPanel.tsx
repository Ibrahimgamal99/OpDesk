import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Loader2, Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import { messageFrom } from '../lib/api';
import { Alert, Card, Dropdown, FormField, FormRow, FormSection, Loading } from './ui';
import type { SectionCard } from './SettingsPanel';
import type { AnalyticsSettings } from '../types';

export interface AnalyticsSettingsPanelProps {
  /** The section's Card header, from Settings. */
  card: SectionCard;
  /** The settings as saved — for the Settings card's status line. */
  onSaved?: (settings: AnalyticsSettings) => void;
}

/** The accepted range of each setting, as the server checks it (analytics SETTING_RANGES). */
const RANGE = {
  sla: [1, 600],
  fcrWindow: [0, 90],
  shortAbandon: [0, 120],
  callbackWindow: [0, 168],
} as const;

/** A number input's value as a whole number inside its range; empty or garbage reads as the
 *  floor, so 0 (off) is a value like any other where the range allows it. */
function intIn(raw: string, [lo, hi]: readonly [number, number]): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

interface QueueOption { extension: string; queue_name: string }

/** Settings → Analytics: the KPI definitions every analytics figure is computed with. */
export function AnalyticsSettingsPanel({ card, onSaved }: AnalyticsSettingsPanelProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AnalyticsSettings>({
    sla_thresholds: {},
    sla_default_secs: 20,
    fcr_window_days: 7,
    short_abandon_secs: 5,
    callback_window_hours: 24,
  });
  // The overrides as loaded, so a save can tell the server which ones were removed.
  const [savedThresholds, setSavedThresholds] = useState<Record<string, number>>({});
  const [queues, setQueues] = useState<QueueOption[]>([]);
  const [addQueue, setAddQueue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchWithAuth('/api/analytics/settings')
      .then(async r => {
        if (!r.ok) return;
        const s = (await r.json()) as AnalyticsSettings;
        setSettings(s);
        setSavedThresholds(s.sla_thresholds ?? {});
      })
      .catch(e => setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setLoading(false));
    // The queue picker for a new override; without it, existing overrides still edit.
    fetchWithAuth('/api/settings/queues')
      .then(async r => { if (r.ok) setQueues(((await r.json()) as { queues?: QueueOption[] }).queues ?? []); })
      .catch(() => setQueues([]));
  }, []);

  const queueLabel = (ext: string) => {
    const q = queues.find(x => x.extension === ext);
    return q && q.queue_name && q.queue_name !== ext ? `${ext} · ${q.queue_name}` : ext;
  };
  const overrides = Object.entries(settings.sla_thresholds).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  const addable = queues.filter(q => !(q.extension in settings.sla_thresholds));

  function setOverride(ext: string, secs: number | null) {
    setSettings(s => {
      const next = { ...s.sla_thresholds };
      if (secs === null) delete next[ext];
      else next[ext] = secs;
      return { ...s, sla_thresholds: next };
    });
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    // Every override as it stands, and null for each one removed since the load.
    const thresholds: Record<string, number | null> = { ...settings.sla_thresholds };
    for (const ext of Object.keys(savedThresholds)) if (!(ext in thresholds)) thresholds[ext] = null;
    try {
      const resp = await fetchWithAuth('/api/analytics/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sla_thresholds: thresholds,
          sla_default_secs: settings.sla_default_secs,
          fcr_window_days: settings.fcr_window_days,
          short_abandon_secs: settings.short_abandon_secs,
          callback_window_hours: settings.callback_window_hours,
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(messageFrom(body, t('analytics.settings.saveFailed', 'Failed to save')));
      }
      setSavedThresholds(settings.sla_thresholds);
      onSaved?.(settings);
      setMessage({ type: 'success', text: t('analytics.settings.saved') });
      setTimeout(() => setMessage(null), 2500);
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : t('notReady.saveFailed', 'Save failed') });
    } finally {
      setSaving(false);
    }
  }

  const saveButton = (
    <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
      {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
      {saving ? t('common.saving') : t('analytics.settings.save')}
    </button>
  );

  if (loading) {
    return (
      <Card {...card}>
        <Loading size="sm" label={t('analytics.loading')} />
      </Card>
    );
  }

  const seconds = t('analytics.settings.unitSeconds', 'seconds');
  return (
    <Card {...card} footer={saveButton}>
      <FormSection title={t('analytics.settings.slaSection')} first>
        <FormRow triple>
          <FormField label={t('analytics.settings.slaDefault')} htmlFor="an-sla" hint={seconds}>
            <input
              id="an-sla"
              type="number"
              className="form-input"
              min={RANGE.sla[0]}
              max={RANGE.sla[1]}
              value={settings.sla_default_secs}
              onChange={e => setSettings(s => ({ ...s, sla_default_secs: intIn(e.target.value, RANGE.sla) }))}
            />
          </FormField>
        </FormRow>
        <p className="u-text-sm u-fg-muted u-mb-3">{t('analytics.settings.slaPerQueue')}</p>
        {overrides.length > 0 && (
          <div className="an-table-wrap u-mb-3">
            <table className="an-table">
              <thead>
                <tr>
                  <th>{t('fields.queue', 'Queue')}</th>
                  <th>{t('analytics.settings.slaOverride', 'Threshold')} ({seconds})</th>
                  <th aria-label={t('common.actions', 'Actions')} />
                </tr>
              </thead>
              <tbody>
                {overrides.map(([ext, secs]) => (
                  <tr key={ext}>
                    <td>{queueLabel(ext)}</td>
                    <td>
                      <input
                        type="number"
                        className="form-input"
                        min={RANGE.sla[0]}
                        max={RANGE.sla[1]}
                        value={secs}
                        aria-label={`${t('analytics.settings.slaOverride', 'Threshold')} ${queueLabel(ext)}`}
                        onChange={e => setOverride(ext, intIn(e.target.value, RANGE.sla))}
                      />
                    </td>
                    <td className="an-col-fit">
                      <button type="button" className="btn btn-ghost btn-danger btn-sm btn-icon"
                        onClick={() => setOverride(ext, null)}
                        title={t('analytics.settings.slaRemove', 'Use the default')}
                        aria-label={`${t('analytics.settings.slaRemove', 'Use the default')} ${queueLabel(ext)}`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {addable.length > 0 && (
          <div className="u-row u-gap-2">
            <Dropdown
              value={addQueue}
              onChange={setAddQueue}
              options={addable.map(q => ({ value: q.extension, label: queueLabel(q.extension) }))}
              placeholder={t('analytics.settings.slaPickQueue', 'Pick a queue')}
              ariaLabel={t('analytics.settings.slaPickQueue', 'Pick a queue')}
              size="md"
              minWidth={200}
            />
            <button type="button" className="btn btn-ghost" disabled={!addQueue}
              onClick={() => { setOverride(addQueue, settings.sla_default_secs); setAddQueue(''); }}>
              <Plus size={14} />
              {t('analytics.settings.slaAdd', 'Add override')}
            </button>
          </div>
        )}
      </FormSection>

      <FormSection title={t('analytics.settings.fcrSection')}>
        <FormRow triple>
          <FormField label={t('analytics.settings.fcrWindow')} htmlFor="an-fcr"
            hint={t('analytics.settings.fcrWindowHint', 'days · 0 turns FCR off')}>
            <input
              id="an-fcr"
              type="number"
              className="form-input"
              min={RANGE.fcrWindow[0]}
              max={RANGE.fcrWindow[1]}
              value={settings.fcr_window_days}
              onChange={e => setSettings(s => ({ ...s, fcr_window_days: intIn(e.target.value, RANGE.fcrWindow) }))}
            />
          </FormField>
          <FormField label={t('analytics.settings.callbackWindow', 'Callback window')} htmlFor="an-callback"
            hint={t('analytics.settings.callbackWindowHint', 'hours · our call back counts as a repeat contact and as a recovered caller · 0 turns it off')}>
            <input
              id="an-callback"
              type="number"
              className="form-input"
              min={RANGE.callbackWindow[0]}
              max={RANGE.callbackWindow[1]}
              value={settings.callback_window_hours}
              onChange={e => setSettings(s => ({ ...s, callback_window_hours: intIn(e.target.value, RANGE.callbackWindow) }))}
            />
          </FormField>
          <FormField label={t('analytics.settings.shortAbandon')} htmlFor="an-abandon" hint={seconds}>
            <input
              id="an-abandon"
              type="number"
              className="form-input"
              min={RANGE.shortAbandon[0]}
              max={RANGE.shortAbandon[1]}
              value={settings.short_abandon_secs}
              onChange={e => setSettings(s => ({ ...s, short_abandon_secs: intIn(e.target.value, RANGE.shortAbandon) }))}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <Alert tone={message?.type === 'success' ? 'success' : 'error'}>{message?.text}</Alert>
    </Card>
  );
}
