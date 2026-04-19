import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, CheckCircle2, Loader2 } from 'lucide-react';
import { getAuthHeaders } from '../auth';
import type { AnalyticsSettings } from '../types';

const inputStyle: React.CSSProperties = {
  width: 76,
  padding: '6px 10px',
  borderRadius: 'var(--radius-sm, 8px)',
  border: '1px solid var(--border-subtle, rgba(48,54,61,0.5))',
  background: 'var(--bg-primary, #0f1117)',
  color: 'var(--text-primary, #f0f6fc)',
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  transition: 'border-color 150ms, box-shadow 150ms',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.82rem',
  color: 'var(--text-secondary, #8b949e)',
  minWidth: 220,
};

const unitStyle: React.CSSProperties = {
  fontSize: '0.78rem',
  color: 'var(--text-muted, #6e7681)',
};

const sectionHeadStyle: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: '0.75rem',
  fontWeight: 700,
  color: 'var(--text-secondary, #8b949e)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

function SettingsInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={e => onChange(parseInt(e.target.value) || min)}
      style={inputStyle}
      onFocus={e => {
        (e.target as HTMLInputElement).style.borderColor = 'var(--accent-primary, #58a6ff)';
        (e.target as HTMLInputElement).style.boxShadow = '0 0 0 3px var(--status-call-glow, rgba(88,166,255,0.2))';
      }}
      onBlur={e => {
        (e.target as HTMLInputElement).style.borderColor = 'var(--border-subtle, rgba(48,54,61,0.5))';
        (e.target as HTMLInputElement).style.boxShadow = 'none';
      }}
    />
  );
}

export function AnalyticsSettingsPanel() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AnalyticsSettings>({
    sla_thresholds: {},
    sla_default_secs: 20,
    fcr_window_days: 7,
    short_abandon_secs: 5,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch('/api/analytics/settings', { headers: getAuthHeaders() })
      .then(async r => {
        if (r.ok) {
          const d = await r.json();
          setSettings(d);
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const resp = await fetch('/api/analytics/settings', {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sla_default_secs: settings.sla_default_secs,
          fcr_window_days: settings.fcr_window_days,
          short_abandon_secs: settings.short_abandon_secs,
        }),
      });
      if (!resp.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '20px 0', color: 'var(--text-muted)' }}>
        <Loader2 size={16} className="spin" />
        {t('analytics.loading')}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: '4px 0' }}>

      {/* SLA */}
      <div>
        <h4 style={sectionHeadStyle}>{t('analytics.settings.slaSection')}</h4>
        <p style={{ fontSize: '0.76rem', color: 'var(--text-muted)', margin: '0 0 14px', lineHeight: 1.5 }}>
          {t('analytics.settings.slaPerQueue')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={labelStyle}>{t('analytics.settings.slaDefault')} (global)</span>
          <SettingsInput
            value={settings.sla_default_secs}
            min={1} max={600}
            onChange={v => setSettings(s => ({ ...s, sla_default_secs: v }))}
          />
          <span style={unitStyle}>s</span>
        </div>
      </div>

      {/* FCR */}
      <div>
        <h4 style={sectionHeadStyle}>{t('analytics.settings.fcrSection')}</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={labelStyle}>{t('analytics.settings.fcrWindow')}</span>
            <SettingsInput
              value={settings.fcr_window_days}
              min={1} max={90}
              onChange={v => setSettings(s => ({ ...s, fcr_window_days: v }))}
            />
            <span style={unitStyle}>days</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={labelStyle}>{t('analytics.settings.shortAbandon')}</span>
            <SettingsInput
              value={settings.short_abandon_secs}
              min={1} max={120}
              onChange={v => setSettings(s => ({ ...s, short_abandon_secs: v }))}
            />
            <span style={unitStyle}>s</span>
          </div>
        </div>
      </div>

      {error && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderRadius: 'var(--radius-sm, 8px)',
          background: 'rgba(248,81,73,0.10)',
          border: '1px solid rgba(248,81,73,0.3)',
          color: 'var(--accent-danger, #f85149)',
          fontSize: '0.82rem',
        }}>
          {error}
        </div>
      )}

      {/* Save */}
      <div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 18px',
            borderRadius: 'var(--radius-sm, 8px)',
            border: 'none',
            background: 'var(--accent-primary, #58a6ff)',
            color: 'var(--bg-primary, #0f1117)',
            cursor: saving ? 'default' : 'pointer',
            fontSize: '0.83rem',
            fontWeight: 600,
            fontFamily: 'inherit',
            opacity: saving ? 0.75 : 1,
            transition: 'opacity 150ms',
          }}
        >
          {saving ? <Loader2 size={14} className="spin" /> : saved ? <CheckCircle2 size={14} /> : <Save size={14} />}
          {saved ? t('analytics.settings.saved') : t('analytics.settings.save')}
        </button>
      </div>
    </div>
  );
}
