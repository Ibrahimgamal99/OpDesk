import { useState, useEffect, useMemo } from 'react';
import {
  Save, Loader2, CheckCircle2, AlertCircle, Database, Signal, Power, PowerOff,
  ChevronDown, ChevronRight, Plug, BarChart3, KeyRound, ShieldCheck, Smartphone, Disc,
  Link2, Send, PhoneIncoming, PhoneOutgoing, ArrowLeftRight, Check, PauseCircle,
  Clock, AlertTriangle, Braces, Copy, ClipboardCheck, Tags, Lock, Radio,
} from 'lucide-react';
import { FilterSelect } from './FilterSelect';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
import { AnalyticsSettingsPanel } from './AnalyticsSettingsPanel';
import { PauseReasonsPanel } from './PauseReasonsPanel';
import { ApiKeysPanel } from './ApiKeysPanel';

export type SettingsTab = 'integrations' | 'api-keys' | 'qos' | 'analytics' | 'sip-tls' | 'mobile-wake' | 'recording' | 'not-ready-codes';

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
  field_catalog?: string[];
  /** Read-only, server-derived: catalog field -> the JSON key it goes out under. */
  default_keys?: Record<string, string>;
  /** Read-only, server-derived: the canonical outcome enum values. */
  call_outcomes?: string[];
}

// Reusable toggle switch matching the app's dark theme.
function CrmToggle({ checked, onChange, label, desc }: {
  checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; desc?: string;
}) {
  return (
    <label className="crm-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="crm-track"><span className="crm-thumb" /></span>
      {(label || desc) && (
        <span className="crm-switch-text">
          {label && <span className="crm-switch-label">{label}</span>}
          {desc && <span className="crm-switch-desc">{desc}</span>}
        </span>
      )}
    </label>
  );
}

// Icons + labels for the direction segmented control.
const CRM_DIRECTIONS = [
  { key: 'sync_dir_inbound' as const,  i18n: 'settings.crm.dirInbound',  label: 'Inbound',  Icon: PhoneIncoming },
  { key: 'sync_dir_outbound' as const, i18n: 'settings.crm.dirOutbound', label: 'Outbound', Icon: PhoneOutgoing },
  { key: 'sync_dir_internal' as const, i18n: 'settings.crm.dirInternal', label: 'Internal', Icon: ArrowLeftRight },
];

const CRM_AUTH_LABELS: Record<string, string> = {
  api_key: 'API Key', basic_auth: 'Basic Auth', bearer_token: 'Bearer Token', oauth2: 'OAuth2',
};

// Friendly labels for the field rows; unknown keys fall back to the raw name.
const CRM_FIELD_LABELS: Record<string, string> = {
  caller: 'Caller', destination: 'Destination', duration: 'Duration', talk_time: 'Talk time',
  datetime: 'Date / time', call_status: 'Call status', call_type: 'Direction', queue: 'Queue',
  caller_name: 'Caller name', call_id: 'Call ID', uniqueid: 'Unique ID', disposition: 'Disposition',
  hangup_cause: 'Hangup cause', agent: 'Agent', agent_name: 'Agent name',
  answered_extension: 'Answered ext', queue_wait_time: 'Queue wait (s)',
};

// One-line "what is this value" for each catalog field, shown under its label in
// the mapping table so an operator doesn't have to read the API docs to decide.
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

// The mapping table groups the catalog so 17 rows stay scannable. Any catalog
// field not listed here is rendered under "Other" — a field added to the backend
// catalog must never silently vanish from this UI.
const CRM_FIELD_GROUPS: { title: string; fields: string[] }[] = [
  { title: 'Identity',      fields: ['caller', 'destination', 'caller_name', 'call_id', 'uniqueid'] },
  { title: 'Timing',        fields: ['datetime', 'duration', 'talk_time', 'queue_wait_time'] },
  { title: 'Outcome',       fields: ['call_status', 'disposition', 'hangup_cause'] },
  { title: 'Routing',       fields: ['call_type', 'queue', 'agent', 'agent_name', 'answered_extension'] },
];

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

interface SettingsPanelProps {
  /** When provided, the active sub-tab is controlled by the parent (sidebar dropdown)
   *  and the panel's own top tab bar is hidden. */
  tab?: SettingsTab;
  onTabChange?: (tab: SettingsTab) => void;
}

export function SettingsPanel({ tab, onTabChange }: SettingsPanelProps = {}) {
  const { t } = useTranslation();
  const controlled = tab !== undefined;
  // The settings sidebar is shown to supervisors too, but the API-key surface is
  // admin-only on the backend — gate the tab rather than showing a form that 403s.
  const isAdmin = getUser()?.role === 'admin';
  const [internalTab, setInternalTab] = useState<SettingsTab>('integrations');
  const activeTab = controlled ? tab : internalTab;
  const setActiveTab = (next: SettingsTab) => {
    if (onTabChange) onTabChange(next);
    if (!controlled) setInternalTab(next);
  };
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [config, setConfig] = useState<CRMConfig>({
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
  });
  // Snapshot of the last loaded/saved config — drives the "unsaved changes"
  // indicator in the action bar. A long settings form with a footer Save button
  // needs it; otherwise edits are silently lost on tab-away.
  const [baseline, setBaseline] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [qosLoading, setQosLoading] = useState(false);
  const [qosMessage, setQosMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sipTlsEnabled, setSipTlsEnabled] = useState(false);
  const [sipTlsDomain, setSipTlsDomain] = useState('');
  const [sipTlsLoading, setSipTlsLoading] = useState(false);
  const [sipTlsMessage, setSipTlsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mobileWakeEnabled, setMobileWakeEnabled] = useState(false);
  const [mobileWakeWait, setMobileWakeWait] = useState(3);
  const [mobileWakeLoading, setMobileWakeLoading] = useState(false);
  const [mobileWakeMessage, setMobileWakeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [recordingFormat, setRecordingFormat] = useState('wav');
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingMessage, setRecordingMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadConfig();
    loadSipTlsStatus();
    loadMobileWakeStatus();
    loadRecordingStatus();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetchWithAuth('/api/crm/config');
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
        setBaseline(JSON.stringify(data));
      } else {
        setConfig({
          enabled: false,
          server_url: '',
          auth_type: 'api_key',
          endpoint_path: '/api/calls',
          timeout: 30,
          verify_ssl: true,
        });
        setBaseline('');
      }
    } catch (error) {
      console.error('Failed to load CRM config:', error);
      setMessage({ type: 'error', text: t('settings.crm.loadError') });
    } finally {
      setLoading(false);
    }
  };

  /** Re-read the stored config without flashing the form's loading state.
   *  Run after a save so the operator sees what the backend actually kept —
   *  invalid key renames are dropped server-side (parse_key_map), and this is
   *  what refreshes field_catalog / default_keys on a first-time setup. */
  const refreshConfigQuietly = async () => {
    try {
      const res = await fetchWithAuth('/api/crm/config');
      if (!res.ok) return;
      const data = await res.json();
      setConfig(data);
      setBaseline(JSON.stringify(data));
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
          // Saved, but something needs the operator's attention (live-reload failed
          // and/or fields were reverted) — surface it instead of a silent success.
          setMessage({ type: 'error', text: warnings.join(' ') || t('settings.crm.saveNeedsRestart', 'Saved, but a restart is required to apply.') });
        } else {
          setMessage({ type: 'success', text: t('settings.crm.savedSuccess') });
          setTimeout(() => setMessage(null), 3000);
        }
      } else {
        const error = await response.json();
        setMessage({ type: 'error', text: error.detail || t('settings.crm.saveError') });
      }
    } catch (error) {
      console.error('Failed to save CRM config:', error);
      setMessage({ type: 'error', text: t('settings.crm.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    saveConfig();
  };

  const updateConfig = (updates: Partial<CRMConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetchWithAuth('/api/crm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        const code = data.status_code ? ` (HTTP ${data.status_code})` : '';
        setTestResult({ type: 'success', text: (data.message || 'Connection successful') + code });
      } else {
        setTestResult({ type: 'error', text: data.detail || data.message || 'Connection test failed' });
      }
    } catch {
      setTestResult({ type: 'error', text: 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  };

  // ── Field-picker helpers ──
  // Every field is opt-in — including caller/destination. The backend no longer
  // force-injects an identity field, so "Select all" must not subtract anything.
  const isFieldOn = (f: string) => (config.sync_fields || []).includes(f);
  const toggleField = (f: string) => {
    const cur = config.sync_fields || [];
    updateConfig({ sync_fields: cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f] });
  };
  const selectAllFields = () =>
    updateConfig({ sync_fields: [...(config.field_catalog || [])] });
  const clearFields = () => updateConfig({ sync_fields: [] });

  // ── Outbound key-rename helpers ──
  // The server tells us the real wire key for each catalog field (default_keys);
  // never hardcode it here or the grid drifts from what actually gets sent.
  const defaultKeyFor = (f: string) => (config.default_keys || {})[f] || f;
  const renameForKey = (k: string) => (config.sync_key_map || {})[k] || '';
  const setRenameForKey = (k: string, value: string) => {
    const next = { ...(config.sync_key_map || {}) };
    const v = value.trim();
    if (!v || v === k) delete next[k]; else next[k] = v;  // never persist no-ops
    updateConfig({ sync_key_map: next });
  };
  // One row per *selected* field, keyed by its real outbound key.
  const renameRows = (config.field_catalog || [])
    .filter(isFieldOn)
    .map(f => ({ field: f, key: defaultKeyFor(f), label: CRM_FIELD_LABELS[f] || f }));
  const finalKeyFor = (r: { key: string }) => renameForKey(r.key) || r.key;
  const keyCounts: Record<string, number> = {};
  renameRows.forEach(r => { const k = finalKeyFor(r); keyCounts[k] = (keyCounts[k] || 0) + 1; });
  const isColliding = (r: { key: string }) => keyCounts[finalKeyFor(r)] > 1;
  const collisionKeys = Object.keys(keyCounts).filter(k => keyCounts[k] > 1);

  // ── Outcome (status) remap helpers ──
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
  const selectedCount = (config.field_catalog || []).filter(isFieldOn).length;
  const activeDirections = CRM_DIRECTIONS.filter(d => (config as any)[d.key] !== false);
  const syncPath = config.sync_endpoint || config.endpoint_path || '/api/calls';
  // Concatenated the same way the connector does: server_url.rstrip('/') + path.
  // Showing the raw join (not a tidied-up version) is deliberate — it exposes a
  // missing leading slash instead of hiding it.
  const pushUrl = (config.server_url || 'https://your-crm.example.com').replace(/\/+$/, '') + syncPath;
  const pathNeedsSlash = !syncPath.startsWith('/');
  // Catalog fields the group map doesn't know about — surfaced rather than dropped.
  const groupedFields = new Set(CRM_FIELD_GROUPS.flatMap(g => g.fields));
  const fieldGroups = [
    ...CRM_FIELD_GROUPS.map(g => ({
      title: g.title,
      fields: g.fields.filter(f => (config.field_catalog || []).includes(f)),
    })),
    { title: 'Other', fields: (config.field_catalog || []).filter(f => !groupedFields.has(f)) },
  ].filter(g => g.fields.length > 0);

  const copyPreview = () => {
    navigator.clipboard?.writeText(previewJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };

  const handleQosEnable = async () => {
    setQosLoading(true);
    setQosMessage(null);
    try {
      const response = await fetchWithAuth('/api/qos/enable', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        setQosMessage({ type: 'success', text: data.message || t('settings.qos.enable') });
      } else {
        const error = await response.json();
        setQosMessage({ type: 'error', text: error.detail || t('settings.qos.enableError') });
      }
    } catch (error) {
      console.error('Failed to enable QoS:', error);
      setQosMessage({ type: 'error', text: t('settings.qos.enableConfigError') });
    } finally {
      setQosLoading(false);
    }
  };

  const handleQosDisable = async () => {
    setQosLoading(true);
    setQosMessage(null);
    try {
      const response = await fetchWithAuth('/api/qos/disable', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        setQosMessage({ type: 'success', text: data.message || t('settings.qos.disable') });
      } else {
        const error = await response.json();
        setQosMessage({ type: 'error', text: error.detail || t('settings.qos.disableError') });
      }
    } catch (error) {
      console.error('Failed to disable QoS:', error);
      setQosMessage({ type: 'error', text: t('settings.qos.disableConfigError') });
    } finally {
      setQosLoading(false);
    }
  };

  const loadSipTlsStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/sip-tls/status');
      if (res.ok) {
        const data = await res.json();
        setSipTlsEnabled(data.enabled);
        setSipTlsDomain(data.domain || '');
      }
    } catch {}
  };

  const handleSipTlsEnable = async () => {
    setSipTlsLoading(true);
    setSipTlsMessage(null);
    try {
      const res = await fetchWithAuth('/api/sip-tls/enable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSipTlsEnabled(true);
        setSipTlsMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setSipTlsMessage({ type: 'error', text: err.detail || t('settings.sipTls.enableError') });
      }
    } catch {
      setSipTlsMessage({ type: 'error', text: t('settings.sipTls.enableError') });
    } finally {
      setSipTlsLoading(false);
    }
  };

  const handleSipTlsDisable = async () => {
    setSipTlsLoading(true);
    setSipTlsMessage(null);
    try {
      const res = await fetchWithAuth('/api/sip-tls/disable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSipTlsEnabled(false);
        setSipTlsMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setSipTlsMessage({ type: 'error', text: err.detail || t('settings.sipTls.disableError') });
      }
    } catch {
      setSipTlsMessage({ type: 'error', text: t('settings.sipTls.disableError') });
    } finally {
      setSipTlsLoading(false);
    }
  };

  const loadMobileWakeStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/mobile-wake/status');
      if (res.ok) {
        const data = await res.json();
        setMobileWakeEnabled(data.enabled);
        setMobileWakeWait(data.wait_seconds ?? 4);
      }
    } catch {}
  };

  const handleMobileWakeEnable = async () => {
    setMobileWakeLoading(true);
    setMobileWakeMessage(null);
    try {
      const res = await fetchWithAuth('/api/mobile-wake/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wait_seconds: mobileWakeWait }),
      });
      if (res.ok) {
        const data = await res.json();
        setMobileWakeEnabled(true);
        setMobileWakeMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setMobileWakeMessage({ type: 'error', text: err.detail || 'Failed to enable mobile wake' });
      }
    } catch {
      setMobileWakeMessage({ type: 'error', text: 'Failed to enable mobile wake' });
    } finally {
      setMobileWakeLoading(false);
    }
  };

  const handleMobileWakeDisable = async () => {
    setMobileWakeLoading(true);
    setMobileWakeMessage(null);
    try {
      const res = await fetchWithAuth('/api/mobile-wake/disable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setMobileWakeEnabled(false);
        setMobileWakeMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setMobileWakeMessage({ type: 'error', text: err.detail || 'Failed to disable mobile wake' });
      }
    } catch {
      setMobileWakeMessage({ type: 'error', text: 'Failed to disable mobile wake' });
    } finally {
      setMobileWakeLoading(false);
    }
  };

  const loadRecordingStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/recording/status');
      if (res.ok) {
        const data = await res.json();
        setRecordingEnabled(data.enabled);
        setRecordingFormat(data.format || 'wav');
      }
    } catch {}
  };

  const handleRecordingEnable = async () => {
    setRecordingLoading(true);
    setRecordingMessage(null);
    try {
      const res = await fetchWithAuth('/api/recording/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: recordingFormat }),
      });
      if (res.ok) {
        const data = await res.json();
        setRecordingEnabled(true);
        setRecordingMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setRecordingMessage({ type: 'error', text: err.detail || 'Failed to enable call recording' });
      }
    } catch {
      setRecordingMessage({ type: 'error', text: 'Failed to enable call recording' });
    } finally {
      setRecordingLoading(false);
    }
  };

  const handleRecordingDisable = async () => {
    setRecordingLoading(true);
    setRecordingMessage(null);
    try {
      const res = await fetchWithAuth('/api/recording/disable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setRecordingEnabled(false);
        setRecordingMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setRecordingMessage({ type: 'error', text: err.detail || 'Failed to disable call recording' });
      }
    } catch {
      setRecordingMessage({ type: 'error', text: 'Failed to disable call recording' });
    } finally {
      setRecordingLoading(false);
    }
  };

  return (
    <div className="panel settings-panel-full">
      <div className="panel-content up-root">

        <div className="up-tabs" style={controlled ? { display: 'none' } : undefined}>
          <button type="button" className={`up-tab ${activeTab === 'integrations' ? 'active' : ''}`} onClick={() => setActiveTab('integrations')}>
            <Plug size={18} />
            {t('settings.integrations')}
          </button>
          {isAdmin && (
            <button type="button" className={`up-tab ${activeTab === 'api-keys' ? 'active' : ''}`} onClick={() => setActiveTab('api-keys')}>
              <KeyRound size={18} />
              {t('settings.tabs.apiKeys', 'API Keys')}
            </button>
          )}
          <button type="button" className={`up-tab ${activeTab === 'qos' ? 'active' : ''}`} onClick={() => setActiveTab('qos')}>
            <Signal size={18} />
            {t('settings.qualityOfService')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
            <BarChart3 size={18} />
            {t('analytics.settings.title')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'sip-tls' ? 'active' : ''}`} onClick={() => setActiveTab('sip-tls')}>
            <ShieldCheck size={18} />
            {t('settings.sipTls.tab')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'mobile-wake' ? 'active' : ''}`} onClick={() => setActiveTab('mobile-wake')}>
            <Smartphone size={18} />
            Mobile Wake
          </button>
          <button type="button" className={`up-tab ${activeTab === 'recording' ? 'active' : ''}`} onClick={() => setActiveTab('recording')}>
            <Disc size={18} />
            Recording
          </button>
          <button type="button" className={`up-tab ${activeTab === 'not-ready-codes' ? 'active' : ''}`} onClick={() => setActiveTab('not-ready-codes')}>
            <PauseCircle size={18} />
            {t('notReady.title', 'Not-Ready Codes')}
          </button>
        </div>

        {/* ── Integrations Tab (CRM) ──
            Layout: hero (master switch) → at-a-glance meta strip → two columns,
            config steps on the left and a live payload preview on the right →
            sticky action bar. The preview is the point of the redesign: the whole
            config only exists to shape one JSON body, so show that body. */}
        {activeTab === 'integrations' && (
          loading ? (
            <div className="crmx-loading">
              <Loader2 size={30} className="spinner" />
              <p>{t('settings.loading')}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="crmx">

              <header className={`crmx-hero ${config.enabled ? 'on' : ''}`}>
                <div className="crmx-hero-ico"><Database size={22} /></div>
                <div className="crmx-hero-main">
                  <div className="crmx-hero-titles">
                    <h2>{t('settings.crm.title')}</h2>
                    <span className={`crm-badge ${config.enabled ? 'on' : 'off'}`}>
                      {config.enabled ? t('settings.crm.stateLive', 'Live') : t('settings.crm.stateOff', 'Off')}
                    </span>
                  </div>
                  <p>{t('settings.crm.description')}</p>
                </div>
                <CrmToggle
                  checked={config.enabled}
                  onChange={(v) => updateConfig({ enabled: v })}
                  label={config.enabled
                    ? t('settings.crm.enabled', 'Enabled')
                    : t('settings.crm.disabled', 'Disabled')}
                />
              </header>

              {message && (
                <div className={`up-alert ${message.type === 'success' ? 'success' : 'error'}`}>
                  {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{message.text}</span>
                </div>
              )}

              {!config.enabled ? (
                <div className="crmx-empty">
                  <div className="crmx-empty-ico"><Plug size={26} /></div>
                  <h3>{t('settings.crm.offTitle', 'CRM integration is off')}</h3>
                  <p>{t('settings.crm.enableDesc')}</p>
                </div>
              ) : (
                <>
                  <div className="crmx-meta">
                    <div className="crmx-meta-cell">
                      <span className="crmx-meta-k">{t('settings.crm.pushTarget', 'Push target')}</span>
                      <span className="crmx-meta-v mono" title={pushUrl}>{pushUrl}</span>
                    </div>
                    <div className="crmx-meta-cell">
                      <span className="crmx-meta-k">{t('settings.crm.authType')}</span>
                      <span className="crmx-meta-v">{CRM_AUTH_LABELS[config.auth_type] || config.auth_type}</span>
                    </div>
                    <div className="crmx-meta-cell">
                      <span className="crmx-meta-k">{t('settings.crm.sync', 'Call-data sync')}</span>
                      <span className="crmx-meta-v">
                        <span className={`crmx-dot ${config.sync_enabled !== false ? 'ok' : 'off'}`} />
                        {config.sync_enabled !== false
                          ? `${config.sync_method || 'POST'} · ${activeDirections.length}/${CRM_DIRECTIONS.length} directions`
                          : t('settings.crm.syncPaused', 'Paused')}
                      </span>
                    </div>
                    <div className="crmx-meta-cell">
                      <span className="crmx-meta-k">{t('settings.crm.fields', 'Fields')}</span>
                      <span className="crmx-meta-v crmx-num">
                        {selectedCount} / {(config.field_catalog || []).length}
                      </span>
                    </div>
                  </div>

                  <div className="crmx-grid">
                    <div className="crmx-col">

                      {/* ── Step 1 · Connection ── */}
                      <section className="crmx-card">
                        <div className="crmx-card-head">
                          <span className="crmx-step">1</span>
                          <div className="crmx-card-ico"><Link2 size={17} /></div>
                          <div className="crmx-card-titles">
                            <h3>{t('settings.crm.connection', 'Connection')}</h3>
                            <p>{t('settings.crm.connectionSub', 'Where OpDesk reaches your CRM and how it authenticates.')}</p>
                          </div>
                        </div>
                        <div className="crmx-card-body">
                          <div className="up-form-group">
                            <label>{t('settings.crm.serverUrl')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="https://crm.example.com or http://192.168.1.100:8080"
                              dir="ltr"
                              value={config.server_url}
                              onChange={(e) => updateConfig({ server_url: e.target.value })}
                              required
                            />
                          </div>

                          <div className="crmx-fields">
                            <div className="up-form-group">
                              <label>{t('settings.crm.authType')}</label>
                              <FilterSelect
                                size="md"
                                value={config.auth_type}
                                onChange={v => updateConfig({ auth_type: v as CRMConfig['auth_type'] })}
                                icon={KeyRound}
                                options={[
                                  { value: 'api_key',       label: 'API Key',       dot: 'blue'    },
                                  { value: 'basic_auth',    label: 'Basic Auth',    dot: 'neutral' },
                                  { value: 'bearer_token',  label: 'Bearer Token',  dot: 'green'   },
                                  { value: 'oauth2',        label: 'OAuth2',        dot: 'orange'  },
                                ]}
                              />
                            </div>

                            {config.auth_type === 'api_key' && (
                              <>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.apiKey')}{config.api_key === '***' && <span className="crmx-saved"><Lock size={10} />{t('settings.crm.stored', 'stored')}</span>}</label>
                                  <input type="password" className="form-input" placeholder="Your API key" value={config.api_key || ''} onChange={(e) => updateConfig({ api_key: e.target.value })} required />
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.apiKeyHeader')}</label>
                                  <input type="text" className="form-input" placeholder="X-API-Key" value={config.api_key_header || ''} onChange={(e) => updateConfig({ api_key_header: e.target.value })} />
                                  <p className="crm-hint">{t('settings.crm.defaultApiKeyHeader')}</p>
                                </div>
                              </>
                            )}

                            {config.auth_type === 'basic_auth' && (
                              <>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.username')}</label>
                                  <input type="text" className="form-input" placeholder="Username" value={config.username || ''} onChange={(e) => updateConfig({ username: e.target.value })} required />
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.password')}{config.password === '***' && <span className="crmx-saved"><Lock size={10} />{t('settings.crm.stored', 'stored')}</span>}</label>
                                  <input type="password" className="form-input" placeholder="Password" value={config.password || ''} onChange={(e) => updateConfig({ password: e.target.value })} required />
                                </div>
                              </>
                            )}

                            {config.auth_type === 'bearer_token' && (
                              <div className="up-form-group">
                                <label>{t('settings.crm.bearerToken')}{config.bearer_token === '***' && <span className="crmx-saved"><Lock size={10} />{t('settings.crm.stored', 'stored')}</span>}</label>
                                <input type="password" className="form-input" placeholder="Your bearer token" value={config.bearer_token || ''} onChange={(e) => updateConfig({ bearer_token: e.target.value })} required />
                              </div>
                            )}

                            {config.auth_type === 'oauth2' && (
                              <>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.clientId')}</label>
                                  <input type="text" className="form-input" placeholder="OAuth2 Client ID" value={config.oauth2_client_id || ''} onChange={(e) => updateConfig({ oauth2_client_id: e.target.value })} required />
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.clientSecret')}{config.oauth2_client_secret === '***' && <span className="crmx-saved"><Lock size={10} />{t('settings.crm.stored', 'stored')}</span>}</label>
                                  <input type="password" className="form-input" placeholder="OAuth2 Client Secret" value={config.oauth2_client_secret || ''} onChange={(e) => updateConfig({ oauth2_client_secret: e.target.value })} required />
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.tokenUrl')}</label>
                                  <input type="text" className="form-input" dir="ltr" placeholder="https://crm.example.com/oauth/token" value={config.oauth2_token_url || ''} onChange={(e) => updateConfig({ oauth2_token_url: e.target.value })} />
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.scope')}</label>
                                  <input type="text" className="form-input" placeholder="read write" value={config.oauth2_scope || ''} onChange={(e) => updateConfig({ oauth2_scope: e.target.value })} />
                                </div>
                              </>
                            )}
                          </div>

                          <button type="button" className="crmx-disclose" onClick={() => setAdvancedOpen((o) => !o)}>
                            {advancedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            {t('settings.crm.advancedOptions')}
                          </button>
                          {advancedOpen && (
                            <div className="crmx-disclose-body">
                              <div className="crmx-fields">
                                <div className="up-form-group">
                                  <label>{t('settings.crm.endpointPath')}</label>
                                  <input type="text" className="form-input" dir="ltr" placeholder="/api/calls" value={config.endpoint_path || ''} onChange={(e) => updateConfig({ endpoint_path: e.target.value })} />
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.timeout')}</label>
                                  <input type="number" className="form-input" placeholder="30" value={config.timeout || 30} onChange={(e) => updateConfig({ timeout: parseInt(e.target.value) || 30 })} min={1} max={300} />
                                </div>
                              </div>
                              <div className="crmx-toggle-list">
                                <CrmToggle
                                  checked={config.verify_ssl !== false}
                                  onChange={(v) => updateConfig({ verify_ssl: v })}
                                  label={t('settings.crm.verifySSL')}
                                  desc={t('settings.crm.verifySSLDesc', 'Turn off only for a CRM using a self-signed certificate.')}
                                />
                                <CrmToggle
                                  checked={config.block_private === true}
                                  onChange={(v) => updateConfig({ block_private: v })}
                                  label={t('settings.crm.blockPrivate', 'Block private / LAN addresses (strict SSRF)')}
                                  desc={t('settings.crm.blockPrivateDesc', 'Loopback and cloud-metadata are always blocked. Enable only if your CRM is public — it rejects on-prem/LAN URLs.')}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      </section>

                      {/* ── Step 2 · Delivery ── */}
                      <section className="crmx-card">
                        <div className="crmx-card-head">
                          <span className="crmx-step">2</span>
                          <div className="crmx-card-ico"><Send size={17} /></div>
                          <div className="crmx-card-titles">
                            <h3>{t('settings.crm.delivery', 'Delivery')}</h3>
                            <p>{t('settings.crm.deliverySub', 'When a call ends, where the record goes and which calls qualify.')}</p>
                          </div>
                          <CrmToggle
                            checked={config.sync_enabled !== false}
                            onChange={(v) => updateConfig({ sync_enabled: v })}
                            label=""
                          />
                        </div>
                        <div className="crmx-card-body">
                          {config.sync_enabled === false ? (
                            <p className="crmx-muted-note">
                              {t('settings.crm.syncOffNote', 'Call-data sync is paused — no call records are pushed. The connection above stays configured.')}
                            </p>
                          ) : (
                            <>
                              <div className="crmx-fields">
                                <div className="up-form-group">
                                  <label>{t('settings.crm.syncEndpoint', 'Sync endpoint path')}</label>
                                  <input
                                    type="text"
                                    className="form-input"
                                    dir="ltr"
                                    placeholder={config.endpoint_path || '/api/calls'}
                                    value={config.sync_endpoint || ''}
                                    onChange={(e) => updateConfig({ sync_endpoint: e.target.value })}
                                  />
                                  <p className="crm-hint">
                                    {t('settings.crm.syncEndpointHint', 'Appended to the server URL. Leave blank to use the connection endpoint path.')}
                                  </p>
                                </div>
                                <div className="up-form-group">
                                  <label>{t('settings.crm.httpMethod', 'HTTP method')}</label>
                                  <FilterSelect
                                    size="md"
                                    value={config.sync_method || 'POST'}
                                    onChange={(v) => updateConfig({ sync_method: v as 'POST' | 'PUT' })}
                                    icon={Send}
                                    options={[
                                      { value: 'POST', label: 'POST', dot: 'green' },
                                      { value: 'PUT', label: 'PUT', dot: 'blue' },
                                    ]}
                                  />
                                </div>
                              </div>

                              <div className="up-form-group">
                                <label>{t('settings.crm.directions', 'Push these call directions')}</label>
                                <div className="crmx-seg">
                                  {CRM_DIRECTIONS.map(({ key, i18n, label, Icon }) => {
                                    const on = (config as any)[key] !== false;
                                    return (
                                      <button
                                        type="button"
                                        key={key}
                                        aria-pressed={on}
                                        className={`crmx-seg-btn ${on ? 'on' : ''}`}
                                        onClick={() => updateConfig({ [key]: !on } as Partial<CRMConfig>)}
                                      >
                                        <Icon size={15} />{t(i18n, label)}
                                        {on && <Check size={14} className="crmx-seg-check" />}
                                      </button>
                                    );
                                  })}
                                </div>
                                {activeDirections.length === 0 && (
                                  <p className="crmx-inline-warn">
                                    <AlertTriangle size={13} />
                                    {t('settings.crm.noDirections', 'No direction selected — nothing will be pushed.')}
                                  </p>
                                )}
                              </div>

                              <div className="up-form-group crmx-half">
                                <label>{t('settings.crm.durationFormat', 'Duration format')}</label>
                                <FilterSelect
                                  size="md"
                                  value={config.sync_duration_format || 'hms'}
                                  onChange={(v) => updateConfig({ sync_duration_format: v as 'hms' | 'seconds' })}
                                  icon={Clock}
                                  options={[
                                    { value: 'hms', label: 'HH:MM:SS (00:05:23)', dot: 'blue' },
                                    { value: 'seconds', label: 'Seconds (323)', dot: 'green' },
                                  ]}
                                />
                                <p className="crm-hint">
                                  {t('settings.crm.durationHint',
                                    'How duration and talk time are sent. In seconds mode the keys become durationInSeconds / talkTimeInSeconds, so the receiver cannot misread the unit.')}
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      </section>

                      {/* ── Step 3 · Fields & key names ──
                          One table instead of the old chip-picker + separate rename
                          grid: pick the field and name its wire key in the same row. */}
                      {config.sync_enabled !== false && (
                        <section className="crmx-card">
                          <div className="crmx-card-head">
                            <span className="crmx-step">3</span>
                            <div className="crmx-card-ico"><Tags size={17} /></div>
                            <div className="crmx-card-titles">
                              <h3>{t('settings.crm.payload', 'Payload fields')}</h3>
                              <p>{t('settings.crm.payloadSub', 'Choose the values to send and, if needed, the key each one lands under.')}</p>
                            </div>
                            <span className="crm-count">{selectedCount} {t('settings.crm.selected', 'selected')}</span>
                          </div>
                          <div className="crmx-card-body">
                            {(config.field_catalog || []).length === 0 ? (
                              <p className="crmx-muted-note">
                                {t('settings.crm.noCatalog', 'The field catalog could not be loaded. Reload the page and try again.')}
                              </p>
                            ) : (
                              <>
                                <div className="crmx-map-bar">
                                  <p className="crm-hint" style={{ margin: 0 }}>
                                    {t('settings.crm.keyNamesHint',
                                      'Rename any field to the key your CRM expects. Leave blank to use the default.')}
                                  </p>
                                  <div className="crmx-map-bar-actions">
                                    <button type="button" className="crm-link-btn" onClick={selectAllFields}>{t('settings.crm.selectAll', 'Select all')}</button>
                                    <span className="crmx-sep" />
                                    <button type="button" className="crm-link-btn" onClick={clearFields}>{t('settings.crm.clear', 'Clear')}</button>
                                  </div>
                                </div>

                                {collisionKeys.length > 0 && (
                                  <div className="crm-keymap-warn">
                                    <AlertTriangle size={14} />
                                    <span>
                                      {t('settings.crm.collisionWarn',
                                        'Two fields would be sent under the same key ({{keys}}). The duplicate rename is dropped and the field keeps its default key.',
                                        { keys: collisionKeys.join(', ') })}
                                    </span>
                                  </div>
                                )}

                                <div className="crmx-map">
                                  <div className="crmx-map-header">
                                    <span>{t('settings.crm.colField', 'Field')}</span>
                                    <span>{t('settings.crm.colSentAs', 'Sent as')}</span>
                                    <span>{t('settings.crm.colRename', 'Rename to')}</span>
                                  </div>
                                  {fieldGroups.map((group) => (
                                    <div className="crmx-map-group" key={group.title}>
                                      <div className="crmx-map-group-title">{group.title}</div>
                                      {group.fields.map((f) => {
                                        const on = isFieldOn(f);
                                        const key = defaultKeyFor(f);
                                        // Show the key that will really go out — the
                                        // duration fields carry their unit in the name.
                                        const wireKey = config.sync_duration_format === 'seconds'
                                          ? (f === 'duration' ? 'durationInSeconds' : f === 'talk_time' ? 'talkTimeInSeconds' : key)
                                          : key;
                                        const collide = on && isColliding({ key });
                                        return (
                                          <div className={`crmx-map-row${on ? ' on' : ''}${collide ? ' collide' : ''}`} key={f}>
                                            <button
                                              type="button"
                                              role="checkbox"
                                              aria-checked={on}
                                              className="crmx-map-pick"
                                              onClick={() => toggleField(f)}
                                            >
                                              <span className="crmx-check">{on && <Check size={12} />}</span>
                                              <span className="crmx-map-name">
                                                {CRM_FIELD_LABELS[f] || f}
                                                {CRM_FIELD_DESCS[f] && <em>{CRM_FIELD_DESCS[f]}</em>}
                                              </span>
                                            </button>
                                            <code className="crmx-map-key">{wireKey}</code>
                                            <input
                                              className="crmx-map-input"
                                              spellCheck={false}
                                              placeholder={on ? wireKey : ''}
                                              disabled={!on}
                                              aria-label={`${CRM_FIELD_LABELS[f] || f} — ${t('settings.crm.colRename', 'Rename to')}`}
                                              value={renameForKey(key)}
                                              onChange={(e) => setRenameForKey(key, e.target.value)}
                                            />
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                        </section>
                      )}

                      {/* ── Step 4 · Outcome values ── */}
                      {config.sync_enabled !== false && (config.call_outcomes || []).length > 0 && (
                        <section className="crmx-card">
                          <div className="crmx-card-head">
                            <span className="crmx-step">4</span>
                            <div className="crmx-card-ico"><Radio size={17} /></div>
                            <div className="crmx-card-titles">
                              <h3>{t('settings.crm.outcomeMap', 'Outcome values')}</h3>
                              <p>{t('settings.crm.outcomeMapHint',
                                'Remap an outcome to what your CRM expects (e.g. BUSY → NO_ANSWER). Applies to both status and disposition. Leave blank to send unchanged.')}</p>
                            </div>
                            <span className="opt-tag">{t('settings.crm.optional', 'optional')}</span>
                          </div>
                          <div className="crmx-card-body">
                            <div className="crmx-outcomes">
                              {(config.call_outcomes || []).map((o) => (
                                <div className={`crmx-outcome${statusMapFor(o) ? ' mapped' : ''}`} key={o}>
                                  <code>{o}</code>
                                  <span className="crm-keymap-arrow">→</span>
                                  <input
                                    className="crmx-map-input"
                                    spellCheck={false}
                                    placeholder={o}
                                    aria-label={`${o} → ?`}
                                    value={statusMapFor(o)}
                                    onChange={(e) => setStatusMapFor(o, e.target.value)}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        </section>
                      )}
                    </div>

                    {/* ── Live payload preview ── */}
                    <aside className="crmx-rail">
                      <div className="crmx-preview">
                        <div className="crmx-preview-head">
                          <Braces size={15} />
                          <span>{t('settings.crm.previewTitle', 'Payload preview')}</span>
                          <button
                            type="button"
                            className="crmx-icon-btn"
                            onClick={copyPreview}
                            title={t('settings.crm.copyJson', 'Copy JSON')}
                            aria-label={t('settings.crm.copyJson', 'Copy JSON')}
                          >
                            {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
                          </button>
                        </div>

                        <div className="crmx-req">
                          <span className={`crmx-verb ${(config.sync_method || 'POST').toLowerCase()}`}>
                            {config.sync_method || 'POST'}
                          </span>
                          <code>{pushUrl}</code>
                        </div>
                        {pathNeedsSlash && (
                          <p className="crmx-inline-warn">
                            <AlertTriangle size={13} />
                            {t('settings.crm.slashWarn', 'The endpoint path has no leading slash — it is joined to the server URL exactly as shown above.')}
                          </p>
                        )}

                        {config.sync_enabled === false ? (
                          <p className="crmx-preview-note">
                            {t('settings.crm.previewPaused', 'Call-data sync is paused — nothing is pushed.')}
                          </p>
                        ) : previewRows.length === 0 ? (
                          <p className="crmx-inline-warn">
                            <AlertTriangle size={13} />
                            {t('settings.crm.previewEmpty', 'No fields selected — the CRM would receive an empty body.')}
                          </p>
                        ) : (
                          <pre className="crmx-json">
                            <span className="j-p">{'{'}</span>
                            {previewRows.map(([k, v], i) => (
                              <span className="crmx-json-line" key={`${k}-${i}`}>
                                {'  '}
                                <span className="j-k">"{k}"</span>
                                <span className="j-p">: </span>
                                {typeof v === 'number'
                                  ? <span className="j-n">{v}</span>
                                  : <span className="j-s">"{v}"</span>}
                                {i < previewRows.length - 1 && <span className="j-p">,</span>}
                              </span>
                            ))}
                            <span className="j-p">{'}'}</span>
                          </pre>
                        )}

                        <p className="crm-hint">
                          {activeDirections.length === CRM_DIRECTIONS.length
                            ? t('settings.crm.previewHintAll', 'Example values — pushed after every call.')
                            : activeDirections.length === 0
                              ? t('settings.crm.previewHintNone', 'Example values. No direction is selected, so nothing is pushed.')
                              : t('settings.crm.previewHintSome', 'Example values — pushed after every {{dirs}} call.',
                                  { dirs: activeDirections.map(d => t(d.i18n, d.label)).join(' / ') })}
                        </p>

                        {testResult && (
                          <div className={`crmx-test ${testResult.type}`}>
                            {testResult.type === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                            <span>{testResult.text}</span>
                          </div>
                        )}
                      </div>
                    </aside>
                  </div>
                </>
              )}

              {/* Sticky action bar — the form is long enough that a footer-only
                  Save is easy to miss, and unsaved edits were silently lost. */}
              <div className="crmx-bar">
                <span className={`crmx-bar-state ${dirty ? 'dirty' : ''}`}>
                  <span className={`crmx-dot ${dirty ? 'warn' : 'ok'}`} />
                  {dirty
                    ? t('settings.crm.unsaved', 'Unsaved changes')
                    : t('settings.crm.allSaved', 'All changes saved')}
                </span>
                <div className="crmx-bar-actions">
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
                    type="submit"
                    className="btn btn-primary"
                    disabled={saving || (config.enabled && !config.server_url)}
                  >
                    {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                    {saving ? t('settings.saving') : t('settings.save')}
                  </button>
                </div>
              </div>
            </form>
          )
        )}

        {/* ── API Keys Tab (admin only) ── */}
        {activeTab === 'api-keys' && (
          <div className="up-add-card">
            {isAdmin ? (
              <ApiKeysPanel />
            ) : (
              <div className="up-add-body">
                <div className="up-alert error">
                  <AlertCircle size={20} />
                  <span>{t('settings.adminOnly', 'Administrator access required.')}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── QoS Tab ── */}
        {activeTab === 'qos' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><Signal size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('settings.qos.title')}</h2>
                <p className="up-add-desc">{t('settings.qos.description')}</p>
              </div>
            </div>
            <div className="up-add-body">
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleQosEnable} disabled={qosLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}>
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {qosLoading ? t('settings.qos.processing') : t('settings.qos.enable')}
                </button>
                <button type="button" className="btn" onClick={handleQosDisable} disabled={qosLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}>
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {qosLoading ? t('settings.qos.processing') : t('settings.qos.disable')}
                </button>
              </div>
              {qosMessage && (
                <div className={`up-alert ${qosMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {qosMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{qosMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SIP TLS Tab ── */}
        {activeTab === 'sip-tls' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><ShieldCheck size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('settings.sipTls.title')}</h2>
                <p className="up-add-desc">{t('settings.sipTls.description')}</p>
              </div>
            </div>
            <div className="up-add-body">
              {sipTlsDomain && (
                <div style={{ marginBottom: 16, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {t('settings.sipTls.domain')}: <strong style={{ color: 'var(--text-primary)' }}>{sipTlsDomain}</strong>
                  {' · '}{t('settings.sipTls.port')}: <strong style={{ color: 'var(--text-primary)' }}>5061</strong>
                  {' · '}{t('settings.sipTls.status')}: <strong style={{ color: sipTlsEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {sipTlsEnabled ? t('settings.sipTls.statusEnabled') : t('settings.sipTls.statusDisabled')}
                  </strong>
                </div>
              )}
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleSipTlsEnable} disabled={sipTlsLoading || sipTlsEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (sipTlsLoading || sipTlsEnabled) ? 0.6 : 1 }}>
                  {sipTlsLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {sipTlsLoading ? t('settings.qos.processing') : t('settings.sipTls.enable')}
                </button>
                <button type="button" className="btn" onClick={handleSipTlsDisable} disabled={sipTlsLoading || !sipTlsEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (sipTlsLoading || !sipTlsEnabled) ? 0.6 : 1 }}>
                  {sipTlsLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {sipTlsLoading ? t('settings.qos.processing') : t('settings.sipTls.disable')}
                </button>
              </div>
              {sipTlsMessage && (
                <div className={`up-alert ${sipTlsMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {sipTlsMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{sipTlsMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Mobile Wake Tab ── */}
        {activeTab === 'mobile-wake' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><Smartphone size={24} /></div>
              <div>
                <h2 className="up-add-title">Mobile Wake</h2>
                <p className="up-add-desc">Send a push notification before dialing so a killed app can re-register with Asterisk before the call rings.</p>
              </div>
            </div>
            <div className="up-add-body">
              <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Status:</span>
                <strong style={{ fontSize: 13, color: mobileWakeEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {mobileWakeEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </div>
              <div className="up-form-group" style={{ marginBottom: 16 }}>
                <label>Wake wait time (seconds)</label>
                <input
                  type="number"
                  className="form-input"
                  value={mobileWakeWait}
                  onChange={e => setMobileWakeWait(Math.max(1, Math.min(30, parseInt(e.target.value) || 4)))}
                  min={1}
                  max={30}
                  style={{ width: 120 }}
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  How long Asterisk waits after sending the push before dialing. Recommended: 3–5s.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleMobileWakeEnable} disabled={mobileWakeLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: mobileWakeLoading ? 0.6 : 1 }}>
                  {mobileWakeLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {mobileWakeLoading ? 'Processing...' : mobileWakeEnabled ? 'Update wait time' : 'Enable'}
                </button>
                <button type="button" className="btn" onClick={handleMobileWakeDisable} disabled={mobileWakeLoading || !mobileWakeEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (mobileWakeLoading || !mobileWakeEnabled) ? 0.6 : 1 }}>
                  {mobileWakeLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {mobileWakeLoading ? 'Processing...' : 'Disable'}
                </button>
              </div>
              {mobileWakeMessage && (
                <div className={`up-alert ${mobileWakeMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {mobileWakeMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{mobileWakeMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Recording Tab ── */}
        {activeTab === 'recording' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><Disc size={24} /></div>
              <div>
                <h2 className="up-add-title">Call Recording</h2>
                <p className="up-add-desc">Record every real call (internal, inbound and outbound trunk) with MixMonitor. The mixed file is saved to the default monitor folder and linked to the CDR.</p>
              </div>
            </div>
            <div className="up-add-body">
              <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Status:</span>
                <strong style={{ fontSize: 13, color: recordingEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {recordingEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </div>
              <div className="up-form-group" style={{ marginBottom: 16 }}>
                <label>Recording format</label>
                <FilterSelect
                  size="md"
                  value={recordingFormat}
                  onChange={setRecordingFormat}
                  minWidth={200}
                  style={{ width: 200 }}
                  options={[
                    { value: 'wav', label: 'wav (uncompressed)' },
                    { value: 'wav49', label: 'wav49 (GSM in WAV)' },
                    { value: 'gsm', label: 'gsm' },
                    { value: 'g722', label: 'g722 (HD)' },
                    { value: 'ulaw', label: 'ulaw' },
                    { value: 'alaw', label: 'alaw' },
                    { value: 'sln', label: 'sln' },
                  ]}
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Applies to the mixed file and both single legs. wav is highest quality; wav49/gsm save disk space.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleRecordingEnable} disabled={recordingLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: recordingLoading ? 0.6 : 1 }}>
                  {recordingLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {recordingLoading ? 'Processing...' : recordingEnabled ? 'Update format' : 'Enable'}
                </button>
                <button type="button" className="btn" onClick={handleRecordingDisable} disabled={recordingLoading || !recordingEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (recordingLoading || !recordingEnabled) ? 0.6 : 1 }}>
                  {recordingLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {recordingLoading ? 'Processing...' : 'Disable'}
                </button>
              </div>
              {recordingMessage && (
                <div className={`up-alert ${recordingMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {recordingMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{recordingMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Analytics Tab ── */}
        {activeTab === 'analytics' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><BarChart3 size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('analytics.settings.title')}</h2>
                <p className="up-add-desc">{t('analytics.settings.description', 'Configure analytics data sources and retention.')}</p>
              </div>
            </div>
            <div className="up-add-body">
              <AnalyticsSettingsPanel />
            </div>
          </div>
        )}

        {/* ── Not-Ready Codes Tab ── */}
        {activeTab === 'not-ready-codes' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><PauseCircle size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('notReady.title', 'Not-Ready Codes')}</h2>
                <p className="up-add-desc">{t('notReady.description', 'Pause reasons agents select when going Not-Ready.')}</p>
              </div>
            </div>
            <div className="up-add-body">
              <PauseReasonsPanel />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export { SettingsPanel as CRMSettingsModal };
