import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Save, Loader2, Plug, KeyRound, Send, PhoneIncoming, PhoneOutgoing, ArrowLeftRight, Check,
  Clock, Braces, Copy, ClipboardCheck, Search, Hash, Link2, FlaskConical, RefreshCw, Repeat, Timer,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { fetchWithAuth } from '../auth';
import { api, messageFrom, toApiError } from '../lib/api';
import {
  AdvancedSection, Alert, Badge, Card, Dropdown, EmptyState, FormField, FormRow, FormSection, Loading, Tabs, Toggle,
} from './ui';
import type { SectionCard } from './SettingsPanel';

export interface CRMConfig {
  enabled: boolean;
  server_url: string;
  auth_type: 'api_key' | 'basic_auth' | 'bearer_token' | 'oauth2';
  api_key?: string;
  api_key_header?: string;
  username?: string;
  password?: string;
  bearer_token?: string;
  oauth2_client_id?: string;
  oauth2_client_secret?: string;
  oauth2_token_url?: string;
  oauth2_scope?: string;
  endpoint_path?: string;
  timeout?: number;
  verify_ssl?: boolean;
  // Call-data sync (push) — which fields/directions get pushed after each call
  sync_enabled?: boolean;
  sync_endpoint?: string;
  sync_method?: 'POST' | 'PUT';
  sync_fields?: string[];
  sync_dir_inbound?: boolean;
  sync_dir_outbound?: boolean;
  sync_dir_internal?: boolean;
  block_private?: boolean;
  sync_duration_format?: 'hms' | 'seconds';
  /** {defaultOutboundKey: customKey} — operator overrides of the wire key names. */
  sync_key_map?: Record<string, string>;
  /** {FROM: TO} — remaps outcome values (call_status / disposition). */
  sync_status_map?: Record<string, string>;
  /** When the push fires: at hangup, or once the agent's wrap-up is over. */
  sync_trigger?: 'hangup' | 'wrapup';
  /** Seconds an "after wrap-up" push waits at most. */
  sync_wrapup_timeout?: number;
  sync_retry_enabled?: boolean;
  /** Attempts per call, the first included. */
  sync_retry_max_attempts?: number;
  /** Backoff ladder in seconds (the last repeats); text while being edited. */
  sync_retry_delays?: number[] | string;
  /** Read-only: whether the saved config is live, and why not when it is enabled but is not. */
  active?: boolean;
  unavailable_reason?: string | null;
  field_catalog?: string[];
  /** Read-only, server-derived: catalog field -> the JSON key it goes out under. */
  default_keys?: Record<string, string>;
  /** Read-only, server-derived: the canonical outcome enum values. */
  call_outcomes?: string[];
  // Contact lookup (3CX-style) — resolve caller numbers to CRM contact names
  lookup_enabled?: boolean;
  /** Path template appended to server_url; [Number] is replaced with the caller's number. */
  lookup_url?: string;
  /** Name template of JSON paths, e.g. "[data.0.first_name] [data.0.last_name]". */
  lookup_name_template?: string;
  lookup_number_format?: 'digits' | 'as_is' | 'plus' | 'zeros';
  /** Compare/cache on the last N digits (0 = full number). */
  lookup_match_digits?: number;
  /** Optional JSON path to the matched record's phone field (match verification). */
  lookup_verify_path?: string;
  lookup_ttl_hours?: number;
}

const DEFAULT_CONFIG: CRMConfig = {
  enabled: false,
  server_url: '',
  auth_type: 'api_key',
  endpoint_path: '/api/calls',
  timeout: 30,
  verify_ssl: true,
  sync_enabled: true,
  sync_method: 'POST',
  sync_fields: [],
  sync_dir_inbound: true,
  sync_dir_outbound: true,
  sync_dir_internal: true,
  block_private: false,
  field_catalog: [],
};

// Icons + labels for the direction segmented control.
const CRM_DIRECTIONS = [
  { key: 'sync_dir_inbound' as const,  i18n: 'direction.inbound',  label: 'Inbound',  Icon: PhoneIncoming },
  { key: 'sync_dir_outbound' as const, i18n: 'direction.outbound', label: 'Outbound', Icon: PhoneOutgoing },
  { key: 'sync_dir_internal' as const, i18n: 'direction.internal', label: 'Internal', Icon: ArrowLeftRight },
];

const CRM_AUTH_LABELS: Record<string, string> = {
  api_key: 'API Key', basic_auth: 'Basic Auth', bearer_token: 'Bearer Token', oauth2: 'OAuth2',
};

/** Translated label for an auth type; unknown types fall back to the raw value. */
const crmAuthLabel = (t: TFunction, authType?: string) =>
  authType && CRM_AUTH_LABELS[authType]
    ? t(`settings.crm.authLabels.${authType}`, CRM_AUTH_LABELS[authType])
    : (authType || '');

// Friendly labels for the field chips; unknown keys fall back to the raw name.
const CRM_FIELD_LABELS: Record<string, string> = {
  caller: 'Caller', destination: 'Destination', duration: 'Duration', talk_time: 'Talk time',
  datetime: 'Date / time', call_status: 'Call status', call_type: 'Direction', queue: 'Queue',
  caller_name: 'Caller name', call_id: 'Call ID', uniqueid: 'Unique ID', disposition: 'Disposition',
  hangup_cause: 'Hangup cause', agent: 'Agent', agent_name: 'Agent name',
  answered_extension: 'Answered ext', queue_wait_time: 'Queue wait (s)',
};

// One-line "what is this value" for each catalog field, shown as the chip's tooltip.
const CRM_FIELD_DESCS: Record<string, string> = {
  caller: 'Caller number or extension',
  destination: 'Number that was dialed',
  caller_name: 'CallerID name, when Asterisk provides one',
  call_id: "Asterisk linkedid — the call's cross-reference handle",
  uniqueid: 'Channel uniqueid (per-leg de-dup key)',
  datetime: 'Call start, ISO 8601',
  duration: 'Total call length',
  talk_time: 'Answer → hangup',
  queue_wait_time: 'Seconds waiting in queue before answer',
  call_status: 'Canonical outcome enum',
  disposition: 'Same outcome enum as call status',
  hangup_cause: 'Raw Asterisk hangup cause code',
  call_type: 'inbound · outbound · internal',
  queue: 'Queue name (queue calls only)',
  agent: 'Answering extension, sent as a number',
  agent_name: 'Display name of the answering agent',
  answered_extension: 'Extension that answered the call',
};

const crmFieldLabel = (t: TFunction, f: string) =>
  CRM_FIELD_LABELS[f] ? t(`settings.crm.fields.${f}`, CRM_FIELD_LABELS[f]) : f;
const crmFieldDesc = (t: TFunction, f: string) =>
  CRM_FIELD_DESCS[f] ? t(`settings.crm.fieldDescs.${f}`, CRM_FIELD_DESCS[f]) : '';

// Illustrative values for the live payload preview. Shapes match what the push
// really sends (agent as an int, datetime as ISO 8601, HH:MM:SS durations).
const CRM_SAMPLE: Record<string, string | number> = {
  caller: '01001234567', destination: '2001', duration: '00:05:23', talk_time: '00:04:58',
  datetime: '2026-07-27T14:32:07+03:00', call_status: 'ANSWERED', call_type: 'inbound',
  queue: 'sales', caller_name: 'Ahmed Fathy', call_id: '1753619527.482',
  uniqueid: '1753619527.483', disposition: 'ANSWERED', hangup_cause: '16', agent: 2001,
  agent_name: 'Sara Khaled', answered_extension: '2001', queue_wait_time: 12,
};
const CRM_SAMPLE_SECONDS: Record<string, number> = { duration: 323, talk_time: 298 };

/**
 * Build the example push body exactly the way `crm.build_crm_payload()` does:
 * selection order → duration format (value *and* key) → outcome remap → the
 * operator's key renames, with the same collision rule (a rename onto a key that
 * already exists is dropped and the field keeps its default key).
 *
 * Mirroring the backend matters — a preview that diverges from the wire format is
 * worse than no preview.
 */
function buildCrmPreview(config: CRMConfig): [string, string | number][] {
  const catalog = config.field_catalog || [];
  const selected = (config.sync_fields || []).filter(f => catalog.includes(f));
  const toSeconds = config.sync_duration_format === 'seconds';
  const defaults = config.default_keys || {};
  const statusMap = config.sync_status_map || {};
  const keyMap = config.sync_key_map || {};

  // Pass 1 — resolve each field to its default wire key and formatted value.
  const pre = selected.map((f) => {
    let value: string | number = CRM_SAMPLE[f] ?? f;
    if (toSeconds && f in CRM_SAMPLE_SECONDS) value = CRM_SAMPLE_SECONDS[f];
    if ((f === 'call_status' || f === 'disposition') && typeof value === 'string') {
      value = statusMap[value.toUpperCase()] || value;
    }
    // The rename map is keyed on the HH:MM:SS form of the duration keys; the
    // backend translates them when seconds mode is active.
    const renameSrc = defaults[f] || f;
    let key = renameSrc;
    if (toSeconds && f === 'duration') key = 'durationInSeconds';
    if (toSeconds && f === 'talk_time') key = 'talkTimeInSeconds';
    return { key, renameSrc, value };
  });

  // Pass 2 — apply renames with the backend's collision guard.
  const existing = new Set(pre.map(p => p.key));
  const out: [string, string | number][] = [];
  const emitted = new Set<string>();
  for (const p of pre) {
    let target = (keyMap[p.renameSrc] || '').trim() || p.key;
    if (target !== p.key && existing.has(target)) target = p.key;  // refuse, keep default
    if (emitted.has(target)) {
      target = p.key;
      if (emitted.has(target)) continue;  // nothing safe to send under
    }
    emitted.add(target);
    out.push([target, p.value]);
  }
  return out;
}

/** The API masks a saved secret as this literal; it shows as a blank field. */
const MASK = '***';
type SecretField = 'api_key' | 'password' | 'bearer_token' | 'oauth2_client_secret';

type CrmTab = 'connection' | 'push' | 'lookup';

type LookupResult = { type: 'success' | 'muted' | 'error'; text: string; raw?: string };

export interface CrmSettingsProps {
  /** The section's Card header, from Settings. */
  card: SectionCard;
  /** The stored config, after every load and save — for the Settings card's status line. */
  onLoaded?: (config: CRMConfig) => void;
}

/**
 * Settings → CRM Integration, as one Card: a master switch, an at-a-glance
 * strip, then three tabs — the connection (shared by both directions), the
 * call-data push with its live payload preview, and the contact lookup. One
 * config blob behind one Save in the Card footer.
 */
export function CrmSettings({ card, onLoaded }: CrmSettingsProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CrmTab>('connection');
  const [config, setConfig] = useState<CRMConfig>(DEFAULT_CONFIG);
  // Snapshot of the last loaded/saved config — drives the "unsaved changes"
  // indicator; a long settings form otherwise loses edits silently.
  const [baseline, setBaseline] = useState('');
  const [loading, setLoading] = useState(true);
  // The stored config could not be read: the form shows defaults, and saving them would
  // overwrite what is stored (sync fields, directions, maps), so Save stays off until a load works.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [lookupTestPhone, setLookupTestPhone] = useState('');
  const [lookupTesting, setLookupTesting] = useState(false);
  const [lookupTestResult, setLookupTestResult] = useState<LookupResult | null>(null);
  const [copied, setCopied] = useState(false);

  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });

  const applyLoaded = useCallback((data: CRMConfig) => {
    setConfig(data);
    setBaseline(JSON.stringify(data));
    onLoadedRef.current?.(data);
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetchWithAuth('/api/crm/config');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      applyLoaded(await response.json());
      setLoadFailed(false);
    } catch (error) {
      console.error('Failed to load CRM config:', error);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [applyLoaded]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  /** Re-read the stored config without the loading state. Run after a save so
   *  the operator sees what the backend actually kept — invalid key renames are
   *  dropped server-side, and this refreshes field_catalog / default_keys. */
  const refreshConfigQuietly = async () => {
    try {
      const res = await fetchWithAuth('/api/crm/config');
      if (!res.ok) return;
      applyLoaded(await res.json());
    } catch { /* keep the in-memory config; the save already succeeded */ }
  };

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);
    const posted = JSON.stringify(config);
    try {
      const response = await fetchWithAuth('/api/crm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: posted,
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
        setBaseline(posted);
        refreshConfigQuietly();
        if (data.reload_ok === false || warnings.length) {
          // Saved, but something needs the operator's attention (live-reload
          // failed and/or fields were reverted) — not a silent success.
          setMessage({ type: 'error', text: warnings.join(' ') || t('settings.crm.saveNeedsRestart', 'Saved, but a restart is required to apply.') });
        } else {
          setMessage({ type: 'success', text: t('settings.crm.savedSuccess') });
          setTimeout(() => setMessage(null), 3000);
        }
      } else {
        const error = await response.json().catch(() => ({}));
        setMessage({ type: 'error', text: messageFrom(error, t('settings.crm.saveError')) });
      }
    } catch (error) {
      console.error('Failed to save CRM config:', error);
      setMessage({ type: 'error', text: t('settings.crm.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const updateConfig = (updates: Partial<CRMConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await api<{
        success: boolean; status_code: number | null; message: string; method: string | null;
      }>('/api/crm/test', { method: 'POST', body: config });
      const code = data.status_code ? ` (HTTP ${data.status_code})` : '';
      setTestResult(data.success
        ? { type: 'success', text: (data.message || t('settings.crm.testOk', 'Connection successful')) + code }
        : { type: 'error', text: (data.message || t('settings.crm.testFailed', 'Connection test failed')) + code });
    } catch (e) {
      setTestResult({ type: 'error', text: toApiError(e).message });
    } finally {
      setTesting(false);
    }
  };

  // Contact-lookup test: runs the full pipeline server-side with the current
  // (possibly unsaved) form values, bypassing all caches. The raw excerpt is
  // what lets an operator fix a wrong name template without curl.
  const testLookup = async () => {
    const phone = lookupTestPhone.trim();
    if (!phone) return;
    setLookupTesting(true);
    setLookupTestResult(null);
    try {
      const data = await api<{
        success: boolean; matched: boolean; name: string | null;
        verify_detail: string; raw_excerpt: string; error?: string;
      }>('/api/crm/lookup-test', { method: 'POST', body: { ...config, phone } });
      if (data.success && data.matched && data.name) {
        setLookupTestResult({
          type: 'success',
          text: t('settings.crm.lookupTestFound', 'Contact found: {{name}}', { name: data.name }),
          raw: data.raw_excerpt || '',
        });
      } else if (data.success) {
        setLookupTestResult({
          type: 'muted',
          text: data.verify_detail
            ? t('settings.crm.lookupTestVerifyFail', 'Verification failed — {{detail}}', { detail: data.verify_detail })
            : t('settings.crm.lookupTestNoMatch', 'The CRM answered, but no name was extracted. Check the name template against the response below.'),
          raw: data.raw_excerpt || '',
        });
      } else {
        setLookupTestResult({
          type: 'error',
          text: data.error || t('settings.crm.lookupTestError', 'Lookup test failed'),
          raw: data.raw_excerpt || '',
        });
      }
    } catch (e) {
      setLookupTestResult({ type: 'error', text: toApiError(e).message });
    } finally {
      setLookupTesting(false);
    }
  };

  // ── Secrets: a stored secret reads back as '***'. Show it blank with a "keep
  //    the saved value" hint; clearing what was typed restores the mask, so an
  //    untouched (or re-blanked) field keeps the stored secret. ──
  const savedConfig = useMemo<Partial<CRMConfig>>(() => {
    try { return baseline ? JSON.parse(baseline) : {}; } catch { return {}; }
  }, [baseline]);
  const isStored = (f: SecretField) => savedConfig[f] === MASK;
  const secretProps = (f: SecretField, placeholder: string) => ({
    type: 'password',
    className: 'form-input',
    autoComplete: 'off',
    value: config[f] === MASK ? '' : (config[f] || ''),
    placeholder: isStored(f) ? t('settings.crm.secretSavedHint', 'Blank = keep the saved value') : placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      updateConfig({ [f]: e.target.value || (isStored(f) ? MASK : '') } as Partial<CRMConfig>),
  });

  // ── Field-picker helpers ── every field is opt-in, caller/destination included.
  const catalog = config.field_catalog || [];
  const isFieldOn = (f: string) => (config.sync_fields || []).includes(f);
  const toggleField = (f: string) => {
    const cur = config.sync_fields || [];
    updateConfig({ sync_fields: cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f] });
  };

  // ── Outbound key renames ── the server reports the real wire key per field
  //    (default_keys); never hardcode it here or the rows drift from the wire.
  const defaultKeyFor = (f: string) => (config.default_keys || {})[f] || f;
  const renameForKey = (k: string) => (config.sync_key_map || {})[k] || '';
  const setRenameForKey = (k: string, value: string) => {
    const next = { ...(config.sync_key_map || {}) };
    const v = value.trim();
    if (!v || v === k) delete next[k]; else next[k] = v;  // never persist no-ops
    updateConfig({ sync_key_map: next });
  };
  const toSeconds = config.sync_duration_format === 'seconds';
  const wireKeyFor = (f: string) => {
    const key = defaultKeyFor(f);
    if (!toSeconds) return key;
    return f === 'duration' ? 'durationInSeconds' : f === 'talk_time' ? 'talkTimeInSeconds' : key;
  };
  const renameRows = catalog.filter(isFieldOn)
    .map(f => ({ field: f, key: defaultKeyFor(f), wire: wireKeyFor(f), label: crmFieldLabel(t, f) }));
  const finalKeyFor = (r: { key: string }) => renameForKey(r.key) || r.key;
  const keyCounts: Record<string, number> = {};
  renameRows.forEach(r => { const k = finalKeyFor(r); keyCounts[k] = (keyCounts[k] || 0) + 1; });
  const isColliding = (r: { key: string }) => keyCounts[finalKeyFor(r)] > 1;
  const collisionKeys = Object.keys(keyCounts).filter(k => keyCounts[k] > 1);

  // ── Outcome (status) remap ──
  const statusMapFor = (outcome: string) => (config.sync_status_map || {})[outcome] || '';
  const setStatusMapFor = (outcome: string, value: string) => {
    const next = { ...(config.sync_status_map || {}) };
    const v = value.trim();
    if (!v || v === outcome) delete next[outcome]; else next[outcome] = v;
    updateConfig({ sync_status_map: next });
  };

  // ── Derived view state ──
  const dirty = baseline !== '' && JSON.stringify(config) !== baseline;
  const previewRows = useMemo(() => buildCrmPreview(config), [config]);
  const previewJson = useMemo(
    () => JSON.stringify(Object.fromEntries(previewRows), null, 2), [previewRows]);
  const selectedCount = catalog.filter(isFieldOn).length;
  const activeDirections = CRM_DIRECTIONS.filter(d => config[d.key] !== false);
  const syncOn = config.sync_enabled !== false;
  const syncPath = config.sync_endpoint || config.endpoint_path || '/api/calls';
  // Joined the way the connector does: server_url.rstrip('/') + path. Showing
  // the raw join is deliberate — it exposes a missing leading slash.
  const pushUrl = (config.server_url || 'https://your-crm.example.com').replace(/\/+$/, '') + syncPath;
  const pathNeedsSlash = !syncPath.startsWith('/');
  const lookupBase = (config.server_url || 'https://your-crm.example.com').replace(/\/+$/, '');

  const copyPreview = () => {
    navigator.clipboard?.writeText(previewJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => { /* clipboard blocked — the JSON is on screen regardless */ });
  };

  if (loading) {
    return (
      <Card {...card}>
        <Loading size="sm" label={t('settings.loading', 'Loading…')} />
      </Card>
    );
  }

  const footer = (
    <>
      <span className={`crmx-bar-state u-flex-1 ${dirty ? 'dirty' : ''}`}>
        <span className={`crmx-dot ${dirty ? 'warn' : 'ok'}`} />
        {dirty ? t('settings.crm.unsaved', 'Unsaved changes') : t('settings.crm.allSaved', 'All changes saved')}
      </span>
      <button
        type="button"
        className="btn"
        onClick={testConnection}
        disabled={testing || !config.enabled || !config.server_url}
      >
        {testing ? <Loader2 size={14} className="spinner" /> : <Plug size={14} />}
        {testing ? t('settings.crm.testing', 'Testing…') : t('settings.crm.test', 'Test connection')}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={saveConfig}
        disabled={saving || loadFailed || (config.enabled && !config.server_url.trim())}
        title={loadFailed ? t('settings.crm.loadFailedSave', 'The saved settings could not be loaded, so saving is off.') : undefined}
      >
        {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
        {saving ? t('common.saving') : t('settings.save')}
      </button>
    </>
  );

  const tabs = (
    <Tabs
      ariaLabel={t('settings.crm.sections', 'CRM integration sections')}
      tabs={[
        { key: 'connection', label: t('settings.crm.connection', 'Connection'), icon: <Link2 size={14} /> },
        { key: 'push', label: t('settings.crm.sync', 'Call-data sync'), icon: <Send size={14} />, count: syncOn ? selectedCount : undefined },
        { key: 'lookup', label: t('settings.crm.lookupTitle', 'Contact lookup'), icon: <Search size={14} /> },
      ]}
      active={tab}
      onChange={k => setTab(k as CrmTab)}
    />
  );

  // Without the stored config there is nothing safe to edit: showing defaults would invite
  // a save that overwrites the real settings.
  if (loadFailed) {
    return (
      <Card {...card} className="crmx crmx-card" footer={footer}>
        <Alert
          action={
            <button type="button" className="btn btn-sm" onClick={loadConfig}>
              <RefreshCw size={14} />{t('common.retry', 'Retry')}
            </button>
          }
        >
          {t('settings.crm.loadFailed', 'The CRM settings could not be loaded. Saving is off so the stored settings are not overwritten.')}
        </Alert>
      </Card>
    );
  }

  return (
    <Card
      {...card}
      className="crmx crmx-card"
      footer={footer}
    >
      <div className="u-col u-gap-4">
        <Toggle
          checked={config.enabled}
          onChange={v => updateConfig({ enabled: v })}
          label={t('settings.crm.enable', 'Enable CRM integration')}
          description={t('settings.crm.enableDesc')}
        />

        <Alert tone={message?.type === 'success' ? 'success' : 'error'}>{message?.text}</Alert>
        {testResult && <Alert tone={testResult.type} onDismiss={() => setTestResult(null)}>{testResult.text}</Alert>}
        {!dirty && savedConfig.enabled && savedConfig.active === false && (
          <Alert tone="warning">
            {t('settings.crm.notActive', 'CRM is enabled but not active: {{reason}}. Calls are logged as failed deliveries until this is fixed.', {
              reason: savedConfig.unavailable_reason || t('settings.crm.notActiveUnknown', 'the connection could not be built'),
            })}
          </Alert>
        )}

        {!config.enabled ? (
          <EmptyState
            icon={Plug}
            title={t('settings.crm.offTitle', 'CRM integration is off')}
            description={t('settings.crm.enableDesc')}
          />
        ) : (
          <>
            {/* What the integration currently amounts to, at a glance. */}
            <div className="crmx-meta">
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('settings.crm.pushTarget', 'Push target')}</span>
                <span className="crmx-meta-v mono" title={pushUrl}>{pushUrl}</span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('settings.crm.authType')}</span>
                <span className="crmx-meta-v">{crmAuthLabel(t, config.auth_type)}</span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('settings.crm.sync', 'Call-data sync')}</span>
                <span className="crmx-meta-v">
                  <span className={`crmx-dot ${syncOn ? 'ok' : 'off'}`} />
                  {syncOn
                    ? t('settings.webhooks.metaDirections', {
                        defaultValue: '{{method}} · {{active}}/{{total}} directions',
                        method: config.sync_method || 'POST',
                        active: activeDirections.length,
                        total: CRM_DIRECTIONS.length,
                      })
                    : t('settings.crm.syncPaused', 'Paused')}
                </span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('settings.crm.lookupTitle', 'Contact lookup')}</span>
                <span className="crmx-meta-v">
                  <span className={`crmx-dot ${config.lookup_enabled ? 'ok' : 'off'}`} />
                  {config.lookup_enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}
                </span>
              </div>
            </div>

            <div>
              {tabs}

              {/* ── Connection: shared by the push and the lookup ── */}
              {tab === 'connection' && (
                <div id="tabpanel-connection" role="tabpanel" aria-labelledby="tab-connection">
                  <p className="u-text-sm u-fg-secondary u-mb-2">
                    {t('settings.crm.connectionSub', 'Where OpDesk reaches your CRM and how it authenticates.')}
                  </p>
                  <FormRow single>
                    <FormField label={t('settings.crm.serverUrl')} htmlFor="crm-server-url">
                      <input
                        id="crm-server-url"
                        type="text"
                        className="form-input"
                        dir="ltr"
                        placeholder="https://crm.example.com or http://192.168.1.100:8080"
                        value={config.server_url}
                        onChange={(e) => updateConfig({ server_url: e.target.value })}
                      />
                    </FormField>
                  </FormRow>

                  <FormRow single>
                    <FormField label={t('settings.crm.authType')}>
                      <Dropdown
                        size="md"
                        value={config.auth_type}
                        onChange={v => updateConfig({ auth_type: v as CRMConfig['auth_type'] })}
                        icon={KeyRound}
                        ariaLabel={t('settings.crm.authType')}
                        options={[
                          { value: 'api_key',      label: crmAuthLabel(t, 'api_key'),      dot: 'blue'    },
                          { value: 'basic_auth',   label: crmAuthLabel(t, 'basic_auth'),   dot: 'neutral' },
                          { value: 'bearer_token', label: crmAuthLabel(t, 'bearer_token'), dot: 'green'   },
                          { value: 'oauth2',       label: crmAuthLabel(t, 'oauth2'),       dot: 'orange'  },
                        ]}
                      />
                    </FormField>
                  </FormRow>

                  {config.auth_type === 'api_key' && (
                    <FormRow>
                      <FormField label={t('settings.crm.apiKey')}>
                        <input {...secretProps('api_key', t('settings.crm.apiKeyPh', 'Your API key'))} />
                      </FormField>
                      <FormField label={t('settings.crm.apiKeyHeader')} hint={t('settings.crm.defaultApiKeyHeader')}>
                        <input type="text" className="form-input" placeholder="X-API-Key" value={config.api_key_header || ''}
                          onChange={(e) => updateConfig({ api_key_header: e.target.value })} />
                      </FormField>
                    </FormRow>
                  )}

                  {config.auth_type === 'basic_auth' && (
                    <FormRow>
                      <FormField label={t('settings.crm.username')}>
                        <input type="text" className="form-input" placeholder={t('fields.username', 'Username')}
                          value={config.username || ''} onChange={(e) => updateConfig({ username: e.target.value })} />
                      </FormField>
                      <FormField label={t('settings.crm.password')}>
                        <input {...secretProps('password', t('fields.password', 'Password'))} />
                      </FormField>
                    </FormRow>
                  )}

                  {config.auth_type === 'bearer_token' && (
                    <FormRow single>
                      <FormField label={t('settings.crm.bearerToken')}>
                        <input {...secretProps('bearer_token', t('settings.crm.bearerTokenPh', 'Your bearer token'))} />
                      </FormField>
                    </FormRow>
                  )}

                  {config.auth_type === 'oauth2' && (
                    <>
                      <FormRow>
                        <FormField label={t('settings.crm.clientId')}>
                          <input type="text" className="form-input" placeholder={t('settings.crm.clientIdPh', 'OAuth2 Client ID')}
                            value={config.oauth2_client_id || ''} onChange={(e) => updateConfig({ oauth2_client_id: e.target.value })} />
                        </FormField>
                        <FormField label={t('settings.crm.clientSecret')}>
                          <input {...secretProps('oauth2_client_secret', t('settings.crm.clientSecretPh', 'OAuth2 Client Secret'))} />
                        </FormField>
                      </FormRow>
                      <FormRow>
                        <FormField label={t('settings.crm.tokenUrl')}>
                          <input type="text" className="form-input" dir="ltr" placeholder="https://crm.example.com/oauth/token"
                            value={config.oauth2_token_url || ''} onChange={(e) => updateConfig({ oauth2_token_url: e.target.value })} />
                        </FormField>
                        <FormField label={t('settings.crm.scope')}>
                          <input type="text" className="form-input" placeholder="read write"
                            value={config.oauth2_scope || ''} onChange={(e) => updateConfig({ oauth2_scope: e.target.value })} />
                        </FormField>
                      </FormRow>
                    </>
                  )}

                  <AdvancedSection label={t('settings.crm.advancedOptions')}>
                    <FormRow>
                      <FormField label={t('settings.crm.endpointPath')}>
                        <input type="text" className="form-input" dir="ltr" placeholder="/api/calls" value={config.endpoint_path || ''}
                          onChange={(e) => updateConfig({ endpoint_path: e.target.value })} />
                      </FormField>
                      <FormField label={t('settings.crm.timeout')}>
                        <input type="number" className="form-input" placeholder="30" value={config.timeout || 30} min={1} max={300}
                          onChange={(e) => updateConfig({ timeout: parseInt(e.target.value) || 30 })} />
                      </FormField>
                    </FormRow>
                    <div className="u-col u-gap-3h">
                      <Toggle
                        checked={config.verify_ssl !== false}
                        onChange={(v) => updateConfig({ verify_ssl: v })}
                        label={t('settings.crm.verifySSL')}
                        description={t('settings.crm.verifySSLDesc', 'Turn off only for a CRM using a self-signed certificate.')}
                      />
                      <Toggle
                        checked={config.block_private === true}
                        onChange={(v) => updateConfig({ block_private: v })}
                        label={t('settings.crm.blockPrivate', 'Block private / LAN addresses (strict SSRF)')}
                        description={t('settings.crm.blockPrivateDesc', 'Loopback and cloud-metadata are always blocked. Enable only if your CRM is public — it rejects on-prem/LAN URLs.')}
                      />
                    </div>
                  </AdvancedSection>
                </div>
              )}

              {/* ── Call-data sync: steps on the left, live payload on the right ── */}
              {tab === 'push' && (
                <div id="tabpanel-push" role="tabpanel" aria-labelledby="tab-push" className="crmx-grid">
                  <div className="crmx-col">
                    <Toggle
                      checked={syncOn}
                      onChange={(v) => updateConfig({ sync_enabled: v })}
                      label={t('settings.crm.syncToggle', 'Push call records to the CRM')}
                      description={t('settings.crm.deliverySub', 'When a call ends, where the record goes and which calls qualify.')}
                    />

                    {!syncOn ? (
                      <p className="up-hint">
                        {t('settings.crm.syncOffNote', 'Call-data sync is paused — no call records are pushed. The connection above stays configured.')}
                      </p>
                    ) : (
                      <div>
                        <FormSection title={t('settings.crm.delivery', 'Delivery')} first>
                          <FormRow single>
                            <FormField label={t('settings.crm.pushDirections', 'Push these call directions')}>
                              <div className="ui-segmented" role="group" aria-label={t('settings.crm.pushDirections', 'Push these call directions')}>
                                {CRM_DIRECTIONS.map(({ key, i18n, label, Icon }) => {
                                  const isOn = config[key] !== false;
                                  return (
                                    <button
                                      type="button"
                                      key={key}
                                      className={`btn${isOn ? ' is-selected' : ''}`}
                                      aria-pressed={isOn}
                                      onClick={() => updateConfig({ [key]: !isOn } as Partial<CRMConfig>)}
                                    >
                                      <Icon size={14} />{t(i18n, label)}
                                    </button>
                                  );
                                })}
                              </div>
                              {activeDirections.length === 0 && (
                                <Alert tone="warning" variant="inline" className="u-mt-2">
                                  {t('settings.crm.noDirections', 'No direction selected — nothing will be pushed.')}
                                </Alert>
                              )}
                            </FormField>
                          </FormRow>

                          <FormRow>
                            <FormField
                              label={t('settings.crm.trigger', 'When to push')}
                              hint={t('settings.crm.triggerHint',
                                'After wrap-up waits until the agent who took the call finishes wrap-up, so the record matches the final call log. Unanswered calls go at once.')}
                            >
                              <Dropdown
                                size="md"
                                value={config.sync_trigger || 'hangup'}
                                onChange={(v) => updateConfig({ sync_trigger: v as 'hangup' | 'wrapup' })}
                                icon={Timer}
                                ariaLabel={t('settings.crm.trigger', 'When to push')}
                                options={[
                                  { value: 'hangup', label: t('settings.crm.triggerHangup', 'At hangup'), dot: 'blue' },
                                  { value: 'wrapup', label: t('settings.crm.triggerWrapup', 'After wrap-up'), dot: 'green' },
                                ]}
                              />
                            </FormField>
                            {config.sync_trigger === 'wrapup' && (
                              <FormField
                                label={t('settings.crm.wrapupTimeout', 'Longest wait (seconds)')}
                                htmlFor="crm-wrapup-timeout"
                                hint={t('settings.crm.wrapupTimeoutHint', 'Push anyway if wrap-up has not ended by then.')}
                              >
                                <input
                                  id="crm-wrapup-timeout"
                                  type="number"
                                  className="form-input"
                                  min={5}
                                  max={86400}
                                  value={config.sync_wrapup_timeout ?? 600}
                                  onChange={(e) => updateConfig({ sync_wrapup_timeout: Math.max(5, parseInt(e.target.value, 10) || 600) })}
                                />
                              </FormField>
                            )}
                          </FormRow>

                          <AdvancedSection label={t('settings.crm.deliveryOptions', 'Delivery options')}>
                            <FormRow>
                              <FormField
                                label={t('settings.crm.syncEndpoint', 'Sync endpoint path')}
                                labelExtra={<span className="opt-tag">{t('settings.crm.optional', 'optional')}</span>}
                                hint={t('settings.crm.syncEndpointHint', 'Appended to the server URL. Leave blank to use the connection endpoint path.')}
                              >
                                <input
                                  type="text"
                                  className="form-input"
                                  dir="ltr"
                                  placeholder={config.endpoint_path || '/api/calls'}
                                  value={config.sync_endpoint || ''}
                                  onChange={(e) => updateConfig({ sync_endpoint: e.target.value })}
                                />
                              </FormField>
                              <FormField label={t('settings.crm.httpMethod', 'HTTP method')}>
                                <Dropdown
                                  size="md"
                                  value={config.sync_method || 'POST'}
                                  onChange={(v) => updateConfig({ sync_method: v as 'POST' | 'PUT' })}
                                  icon={Send}
                                  ariaLabel={t('settings.crm.httpMethod', 'HTTP method')}
                                  options={[
                                    { value: 'POST', label: 'POST', dot: 'green' },
                                    { value: 'PUT', label: 'PUT', dot: 'blue' },
                                  ]}
                                />
                              </FormField>
                            </FormRow>
                            <FormRow>
                              <FormField
                                label={t('settings.crm.durationFormat', 'Duration format')}
                                hint={t('settings.crm.durationHint',
                                  'How duration and talk time are sent. In seconds mode the keys become durationInSeconds / talkTimeInSeconds, so the receiver cannot misread the unit.')}
                              >
                                <Dropdown
                                  size="md"
                                  value={config.sync_duration_format || 'hms'}
                                  onChange={(v) => updateConfig({ sync_duration_format: v as 'hms' | 'seconds' })}
                                  icon={Clock}
                                  ariaLabel={t('settings.crm.durationFormat', 'Duration format')}
                                  options={[
                                    { value: 'hms', label: 'HH:MM:SS (00:05:23)', dot: 'blue' },
                                    { value: 'seconds', label: t('settings.crm.durationSeconds', 'Seconds (323)'), dot: 'green' },
                                  ]}
                                />
                              </FormField>
                            </FormRow>
                          </AdvancedSection>
                        </FormSection>

                        <FormSection title={t('settings.crm.retries', 'Retries')}>
                          <Toggle
                            checked={config.sync_retry_enabled !== false}
                            onChange={(v) => updateConfig({ sync_retry_enabled: v })}
                            label={t('settings.crm.retryToggle', 'Retry failed pushes automatically')}
                            description={t('settings.crm.retryDesc',
                              'A push that times out, gets a server error or is rate-limited is sent again with the same idempotency key. A push the CRM rejects (4xx) is not retried; resend it from Logs.')}
                          />
                          {config.sync_retry_enabled !== false && (
                            <FormRow>
                              <FormField
                                label={t('settings.crm.retryMaxAttempts', 'Attempts per call')}
                                htmlFor="crm-retry-attempts"
                                hint={t('settings.crm.retryMaxAttemptsHint', 'The first attempt included (1–20).')}
                              >
                                <input
                                  id="crm-retry-attempts"
                                  type="number"
                                  className="form-input"
                                  min={1}
                                  max={20}
                                  value={config.sync_retry_max_attempts ?? 5}
                                  onChange={(e) => updateConfig({
                                    sync_retry_max_attempts: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)),
                                  })}
                                />
                              </FormField>
                              <FormField
                                label={t('settings.crm.retryDelays', 'Wait between attempts (seconds)')}
                                htmlFor="crm-retry-delays"
                                hint={t('settings.crm.retryDelaysHint',
                                  'Comma-separated; the last value repeats. A longer Retry-After from the CRM wins.')}
                              >
                                <input
                                  id="crm-retry-delays"
                                  type="text"
                                  className="form-input"
                                  dir="ltr"
                                  inputMode="numeric"
                                  placeholder="30, 120, 600, 1800"
                                  value={Array.isArray(config.sync_retry_delays)
                                    ? config.sync_retry_delays.join(', ')
                                    : (config.sync_retry_delays ?? '30, 120, 600, 1800')}
                                  onChange={(e) => updateConfig({ sync_retry_delays: e.target.value })}
                                />
                              </FormField>
                            </FormRow>
                          )}
                          <p className="up-hint u-row u-gap-1">
                            <Repeat size={14} aria-hidden />
                            {t('settings.crm.retryLogHint', 'Every push and each retry is listed under Logs → CRM Deliveries.')}
                          </p>
                        </FormSection>

                        <FormSection title={t('settings.crm.payload', 'Payload fields')}>
                          {catalog.length === 0 ? (
                            <p className="up-hint">
                              {t('settings.crm.noCatalog', 'The field catalog could not be loaded. Reload the page and try again.')}
                            </p>
                          ) : (
                            <>
                              <FormRow single>
                                <FormField
                                  label={t('settings.crm.fieldsToSend', 'Fields to send')}
                                  labelExtra={
                                    <span className="crm-field-badges">
                                      {selectedCount === 0 && <Badge tone="warning">{t('settings.crm.pickAtLeastOne', 'Pick ≥ 1')}</Badge>}
                                      <Badge tone="info">{t('settings.crm.selectedCount', { defaultValue: '{{count}} selected', count: selectedCount })}</Badge>
                                    </span>
                                  }
                                >
                                  <div className="u-row u-gap-1 u-mb-2">
                                    <button type="button" className="btn btn-ghost btn-sm"
                                      onClick={() => updateConfig({ sync_fields: [...catalog] })}>
                                      {t('common.selectAll', 'Select all')}
                                    </button>
                                    <button type="button" className="btn btn-ghost btn-sm"
                                      onClick={() => updateConfig({ sync_fields: [] })}>
                                      {t('settings.crm.clear', 'Clear')}
                                    </button>
                                  </div>
                                  <div className="crm-chips">
                                    {catalog.map((f) => {
                                      const isOn = isFieldOn(f);
                                      return (
                                        <button
                                          type="button"
                                          key={f}
                                          onClick={() => toggleField(f)}
                                          aria-pressed={isOn}
                                          className={`crm-chip ${isOn ? 'on' : ''}`}
                                          title={crmFieldDesc(t, f)}
                                        >
                                          <span className="crm-chip-ico">{isOn ? <Check size={14} /> : null}</span>
                                          {crmFieldLabel(t, f)}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </FormField>
                              </FormRow>

                              {renameRows.length > 0 && (
                                <FormRow single>
                                  <FormField
                                    label={t('settings.crm.fieldNames', 'Field names')}
                                    labelExtra={<span className="opt-tag">{t('settings.crm.optional', 'optional')}</span>}
                                    hint={t('settings.crm.keyNamesHint', 'Rename any field to the key your CRM expects. Leave blank to use the default.')}
                                  >
                                    {collisionKeys.length > 0 && (
                                      <Alert tone="warning" variant="inline" className="u-mb-2">
                                        {t('settings.crm.collisionWarn',
                                          'Two fields would be sent under the same key ({{keys}}). The duplicate rename is dropped and the field keeps its default key.',
                                          { keys: collisionKeys.join(', ') })}
                                      </Alert>
                                    )}
                                    <div className="crm-keymap-rows">
                                      {renameRows.map((row) => (
                                        <div className={`crm-keymap-row ${isColliding(row) ? 'collide' : ''}`} key={row.field}>
                                          <span className="crm-keymap-label">{row.label}</span>
                                          <code className="crm-keymap-default">{row.wire}</code>
                                          <span className="crm-keymap-arrow">→</span>
                                          <input
                                            type="text"
                                            className="crm-keymap-input"
                                            value={renameForKey(row.key)}
                                            placeholder={row.wire}
                                            spellCheck={false}
                                            aria-label={t('settings.crm.jsonKeyFor', 'JSON key for {{field}}', { field: row.label })}
                                            onChange={(e) => setRenameForKey(row.key, e.target.value)}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </FormField>
                                </FormRow>
                              )}
                            </>
                          )}
                        </FormSection>

                        {(config.call_outcomes || []).length > 0 && (
                          <FormSection title={t('settings.crm.outcomeMap', 'Outcome values')}>
                            <FormRow single>
                              <FormField
                                label={t('settings.crm.outcomeMap', 'Outcome values')}
                                labelExtra={<span className="opt-tag">{t('settings.crm.optional', 'optional')}</span>}
                                hint={t('settings.crm.outcomeMapHint',
                                  'Remap an outcome to what your CRM expects (e.g. BUSY → UNANSWERED). Applies to both status and disposition. Leave blank to send unchanged.')}
                              >
                                <div className="crm-keymap-rows">
                                  {(config.call_outcomes || []).map((o) => (
                                    <div className="crm-keymap-row" key={o}>
                                      <span className="crm-keymap-label">{t('settings.crm.outcome', 'Outcome')}</span>
                                      <code className="crm-keymap-default">{o}</code>
                                      <span className="crm-keymap-arrow">→</span>
                                      <input
                                        type="text"
                                        className="crm-keymap-input"
                                        value={statusMapFor(o)}
                                        placeholder={o}
                                        spellCheck={false}
                                        aria-label={t('settings.crm.sendOutcomeAs', 'Send {{outcome}} as', { outcome: o })}
                                        onChange={(e) => setStatusMapFor(o, e.target.value)}
                                      />
                                    </div>
                                  ))}
                                </div>
                              </FormField>
                            </FormRow>
                          </FormSection>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Live payload preview ── */}
                  <aside className="crmx-rail">
                    <Card
                      icon={Braces}
                      title={t('settings.crm.previewTitle', 'Payload preview')}
                      actions={
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={copyPreview}
                          title={t('settings.crm.copyJson', 'Copy JSON')}
                          aria-label={t('settings.crm.copyJson', 'Copy JSON')}
                        >
                          {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
                        </button>
                      }
                      bodyClassName="crmx-preview"
                    >
                      <div className="crmx-req">
                        <Badge tone="info">{config.sync_method || 'POST'}</Badge>
                        <code>{pushUrl}</code>
                      </div>
                      {pathNeedsSlash && (
                        <Alert tone="warning" variant="inline">
                          {t('settings.crm.slashWarn', 'The endpoint path has no leading slash — it is joined to the server URL exactly as shown above.')}
                        </Alert>
                      )}

                      {!syncOn ? (
                        <p className="up-hint">{t('settings.crm.previewPaused', 'Call-data sync is paused — nothing is pushed.')}</p>
                      ) : previewRows.length === 0 ? (
                        <Alert tone="warning" variant="inline">
                          {t('settings.crm.previewEmpty', 'No fields selected — the CRM would receive an empty body.')}
                        </Alert>
                      ) : (
                        <pre className="crmx-json">
                          <span className="j-p">{'{'}</span>
                          {previewRows.map(([k, v], i) => (
                            <span className="crmx-json-line" key={`${k}-${i}`}>
                              {'  '}
                              <span className="j-k">&quot;{k}&quot;</span>
                              <span className="j-p">: </span>
                              {typeof v === 'number'
                                ? <span className="j-n">{v}</span>
                                : <span className="j-s">&quot;{v}&quot;</span>}
                              {i < previewRows.length - 1 && <span className="j-p">,</span>}
                            </span>
                          ))}
                          <span className="j-p">{'}'}</span>
                        </pre>
                      )}

                      <p className="up-hint">
                        {activeDirections.length === CRM_DIRECTIONS.length
                          ? t('settings.crm.previewHintAll', 'Example values — pushed after every call.')
                          : activeDirections.length === 0
                            ? t('settings.crm.previewHintNone', 'Example values. No direction is selected, so nothing is pushed.')
                            : t('settings.crm.previewHintSome', 'Example values — pushed after every {{dirs}} call.',
                                { dirs: activeDirections.map(d => t(d.i18n, d.label)).join(' / ') })}
                      </p>
                    </Card>
                  </aside>
                </div>
              )}

              {/* ── Contact lookup: the reverse direction. On ring/dial the server
                   GETs the CRM for the number, caches the contact and shows the
                   name on the softphone and dashboards. Same connection. ── */}
              {tab === 'lookup' && (
                <div id="tabpanel-lookup" role="tabpanel" aria-labelledby="tab-lookup">
                  <Toggle
                    checked={config.lookup_enabled === true}
                    onChange={(v) => updateConfig({ lookup_enabled: v })}
                    label={t('settings.crm.lookupTitle', 'Contact lookup')}
                    description={t('settings.crm.lookupSub', 'Resolve caller numbers to CRM contact names, shown on the softphone and dashboards. Results are cached server-side.')}
                  />

                  {config.lookup_enabled !== true ? (
                    <p className="up-hint u-mt-3">
                      {t('settings.crm.lookupOffNote', 'Contact lookup is off — calls show bare numbers. The connection above stays configured.')}
                    </p>
                  ) : (
                    <>
                      <FormSection title={t('contactLookup.secRequest', 'What to ask, and how to read the answer')}>
                        <FormRow>
                          <FormField
                            label={t('settings.crm.lookupUrl', 'Lookup URL')}
                            htmlFor="lk-url"
                            hint={t('settings.crm.lookupUrlHint', 'Appended to the server URL. [Number] is replaced with the caller’s number; without it, ?phone=[Number] is added automatically.')}
                          >
                            <input
                              id="lk-url"
                              type="text"
                              className="form-input"
                              dir="ltr"
                              spellCheck={false}
                              placeholder="/api/v2/contacts?phone=[Number]"
                              value={config.lookup_url || ''}
                              onChange={(e) => updateConfig({ lookup_url: e.target.value })}
                            />
                          </FormField>
                          <FormField
                            label={t('settings.crm.lookupNameTemplate', 'Name template')}
                            htmlFor="lk-name"
                            hint={t('settings.crm.lookupNameTemplateHint', 'Each [path] is a dot/index path into the JSON response (data.0.name reads response.data[0].name). Multiple paths are joined, e.g. first + last name.')}
                          >
                            <input
                              id="lk-name"
                              type="text"
                              className="form-input"
                              dir="ltr"
                              spellCheck={false}
                              placeholder="[data.0.first_name] [data.0.last_name]"
                              value={config.lookup_name_template || ''}
                              onChange={(e) => updateConfig({ lookup_name_template: e.target.value })}
                            />
                          </FormField>
                        </FormRow>
                        <p className="u-text-sm u-fg-muted u-mono u-truncate" dir="ltr" title={`${lookupBase}${config.lookup_url || ''}`}>
                          GET {lookupBase}{config.lookup_url || '/…'}
                        </p>
                      </FormSection>

                      <FormSection title={t('contactLookup.secMatching', 'Number matching')}>
                        <FormRow>
                          <FormField label={t('settings.crm.lookupNumberFormat', 'Number sent to the CRM')}>
                            <Dropdown
                              size="md"
                              value={config.lookup_number_format || 'digits'}
                              onChange={(v) => updateConfig({ lookup_number_format: v as CRMConfig['lookup_number_format'] })}
                              icon={Hash}
                              ariaLabel={t('settings.crm.lookupNumberFormat', 'Number sent to the CRM')}
                              options={[
                                { value: 'digits', label: t('settings.crm.lookupFmtDigits', 'Digits only (201005551234)'), dot: 'green' },
                                { value: 'as_is', label: t('settings.crm.lookupFmtAsIs', 'As received (+20 100 555 1234)'), dot: 'blue' },
                                { value: 'plus', label: t('settings.crm.lookupFmtPlus', 'International + (+201005551234)'), dot: 'blue' },
                                { value: 'zeros', label: t('settings.crm.lookupFmtZeros', 'International 00 (00201005551234)'), dot: 'blue' },
                              ]}
                            />
                          </FormField>
                          <FormField
                            label={t('settings.crm.lookupMatchDigits', 'Match last N digits')}
                            htmlFor="lk-match"
                            hint={t('settings.crm.lookupMatchDigitsHint', 'Caching and verification compare only the last N digits, so +20…, 0020… and 0… match the same contact. 0 = full number.')}
                          >
                            <input
                              id="lk-match"
                              type="number"
                              inputMode="numeric"
                              className="form-input"
                              dir="ltr"
                              min={0}
                              max={32}
                              value={config.lookup_match_digits ?? 0}
                              onChange={(e) => updateConfig({ lookup_match_digits: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                            />
                          </FormField>
                        </FormRow>

                        <AdvancedSection>
                          <FormRow>
                            <FormField
                              label={t('settings.crm.lookupVerifyPath', 'Verify phone path')}
                              labelExtra={<span className="opt-tag">{t('settings.crm.optional', 'optional')}</span>}
                              htmlFor="lk-verify"
                              hint={t('settings.crm.lookupVerifyPathHint', 'Path to the phone field of the returned record. A result only counts when it matches the searched number — protects against fuzzy-search false positives.')}
                            >
                              <input
                                id="lk-verify"
                                type="text"
                                className="form-input"
                                dir="ltr"
                                spellCheck={false}
                                placeholder="data.0.phone"
                                value={config.lookup_verify_path || ''}
                                onChange={(e) => updateConfig({ lookup_verify_path: e.target.value })}
                              />
                            </FormField>
                            <FormField
                              label={t('settings.crm.lookupTtl', 'Cache freshness (hours)')}
                              htmlFor="lk-ttl"
                              hint={t('settings.crm.lookupTtlHint', 'How long a cached contact is trusted before the CRM is asked again.')}
                            >
                              <input
                                id="lk-ttl"
                                type="number"
                                inputMode="numeric"
                                className="form-input"
                                dir="ltr"
                                min={1}
                                value={config.lookup_ttl_hours ?? 24}
                                onChange={(e) => updateConfig({ lookup_ttl_hours: Math.max(1, parseInt(e.target.value, 10) || 24) })}
                              />
                            </FormField>
                          </FormRow>
                        </AdvancedSection>
                      </FormSection>

                      {/* Template debugging: name templates are JSON paths into
                          someone else's API, so the real response is what you need. */}
                      <FormSection title={t('settings.crm.lookupTestRun', 'Test lookup')}>
                        <FormRow>
                          <FormField label={t('fields.phoneNumber', 'Phone number')} htmlFor="lk-test">
                            <input
                              id="lk-test"
                              type="tel"
                              inputMode="tel"
                              className="form-input"
                              dir="ltr"
                              placeholder={t('settings.crm.lookupTestPhone', 'Phone number, e.g. +20 100 555 1234')}
                              value={lookupTestPhone}
                              onChange={(e) => setLookupTestPhone(e.target.value)}
                            />
                          </FormField>
                          <div className="up-form-group u-col u-justify-end">
                            <button
                              type="button"
                              className="btn"
                              onClick={testLookup}
                              disabled={lookupTesting || !config.server_url || !(config.lookup_url || '').trim()
                                || !(config.lookup_name_template || '').trim() || !lookupTestPhone.trim()}
                            >
                              {lookupTesting ? <Loader2 size={14} className="spinner" /> : <FlaskConical size={14} />}
                              {lookupTesting ? t('settings.crm.testing', 'Testing…') : t('settings.crm.lookupTestRun', 'Test lookup')}
                            </button>
                          </div>
                        </FormRow>

                        {lookupTestResult && (
                          <Alert tone={lookupTestResult.type === 'success' ? 'success' : lookupTestResult.type === 'error' ? 'error' : 'warning'}>
                            <div>
                              <div>{lookupTestResult.text}</div>
                              {lookupTestResult.raw && (
                                <details className="u-mt-2">
                                  <summary className="u-text-sm">{t('settings.crm.lookupTestRaw', 'CRM response (truncated)')}</summary>
                                  <pre className="u-text-sm u-mono">{lookupTestResult.raw}</pre>
                                </details>
                              )}
                            </div>
                          </Alert>
                        )}
                      </FormSection>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
