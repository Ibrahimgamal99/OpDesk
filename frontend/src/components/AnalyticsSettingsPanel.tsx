import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import { Alert, Card, FormField, FormRow, FormSection, Loading } from './ui';
import type { SectionCard } from './SettingsPanel';
import type { AnalyticsSettings } from '../types';

export interface AnalyticsSettingsPanelProps {
  /** The section's Card header, from Settings. */
  card: SectionCard;
  /** The settings as saved — for the Settings card's status line. */
  onSaved?: (settings: AnalyticsSettings) => void;
}

/** Settings → Analytics: the KPI definitions every analytics figure is computed with. */
export function AnalyticsSettingsPanel({ card, onSaved }: AnalyticsSettingsPanelProps) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AnalyticsSettings>({
    sla_thresholds: {},
    sla_default_secs: 20,
    fcr_window_days: 7,
    short_abandon_secs: 5,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetchWithAuth('/api/analytics/settings')
      .then(async r => { if (r.ok) setSettings(await r.json()); })
      .catch(e => setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const resp = await fetchWithAuth('/api/analytics/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sla_default_secs: settings.sla_default_secs,
          fcr_window_days: settings.fcr_window_days,
          short_abandon_secs: settings.short_abandon_secs,
        }),
      });
      if (!resp.ok) throw new Error(t('analytics.settings.saveFailed', 'Failed to save'));
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
      {saving ? t('settings.saving') : t('analytics.settings.save')}
    </button>
  );

  if (loading) {
    return (
      <Card {...card}>
        <Loading size="sm" label={t('analytics.loading')} />
      </Card>
    );
  }

  return (
    <Card {...card} footer={saveButton}>
      <FormSection title={t('analytics.settings.slaSection')} first>
        <p className="u-text-sm u-fg-muted u-mb-3">{t('analytics.settings.slaPerQueue')}</p>
        <FormRow triple>
          <FormField label={t('analytics.settings.slaDefault')} htmlFor="an-sla" hint={t('analytics.settings.unitSeconds', 'seconds')}>
            <input
              id="an-sla"
              type="number"
              className="form-input"
              min={1}
              max={600}
              value={settings.sla_default_secs}
              onChange={e => setSettings(s => ({ ...s, sla_default_secs: parseInt(e.target.value) || 1 }))}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection title={t('analytics.settings.fcrSection')}>
        <FormRow triple>
          <FormField label={t('analytics.settings.fcrWindow')} htmlFor="an-fcr" hint={t('analytics.settings.unitDays', 'days')}>
            <input
              id="an-fcr"
              type="number"
              className="form-input"
              min={1}
              max={90}
              value={settings.fcr_window_days}
              onChange={e => setSettings(s => ({ ...s, fcr_window_days: parseInt(e.target.value) || 1 }))}
            />
          </FormField>
          <FormField label={t('analytics.settings.shortAbandon')} htmlFor="an-abandon" hint={t('analytics.settings.unitSeconds', 'seconds')}>
            <input
              id="an-abandon"
              type="number"
              className="form-input"
              min={1}
              max={120}
              value={settings.short_abandon_secs}
              onChange={e => setSettings(s => ({ ...s, short_abandon_secs: parseInt(e.target.value) || 1 }))}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <Alert tone={message?.type === 'success' ? 'success' : 'error'}>{message?.text}</Alert>
    </Card>
  );
}
