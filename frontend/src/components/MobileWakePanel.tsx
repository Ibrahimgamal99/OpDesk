import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Save, Trash2, RefreshCw, KeyRound, ExternalLink, Timer, Smartphone, Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, toApiError } from '../lib/api';
import {
  Alert, Badge, Card, EmptyState, FileUpload, FormField, FormRow, FormSection, Loading, Table, Tabs, Toggle, useConfirm,
} from './ui';
import type { Column } from './ui';
import type { SectionCard } from './SettingsPanel';
import { MEDUT_REPO_URL } from './MobileSetupQR';

interface PushBinding {
  id: number;
  extension: string;
  provider: string;
  param: string | null;
  token: string;
  user_agent: string | null;
  last_seen_at: string | null;
}

export interface PushConfig {
  mobile_wake: { enabled: boolean; hold_seconds: number; settle_seconds: number; client_marker: string };
  fcm: {
    project_id: string; has_service_account: boolean; service_account_email: string;
    service_account_project: string; source: 'ui' | 'env' | null; ready: boolean;
  };
  apns: {
    key_id: string; team_id: string; bundle_id: string; has_auth_key: boolean;
    source: 'ui' | 'env' | null; sandbox: boolean; ready: boolean;
  };
  web: { public_key: string; ready: boolean; library_installed: boolean };
  bindings: PushBinding[];
}

/** A key file picked in the form: undefined = keep the stored one, null = remove it. */
type KeyFile = { name: string; text: string } | null | undefined;

type WakeTab = 'wake-settings' | 'wake-keys' | 'wake-devices';

export interface MobileWakePanelProps {
  /** The section's Card header, from Settings. */
  card: SectionCard;
  /** The stored config after every load and save — for the Settings card's status line. */
  onLoaded?: (config: PushConfig) => void;
}

/**
 * Settings → Mobile Wake, as one Card: a status strip, then three tabs — the
 * wake timings, the push keys (FCM, APNs, Web push) and the RFC 8599 devices.
 * Timings and keys are one config behind one Save in the Card footer.
 */
export function MobileWakePanel({ card, onLoaded }: MobileWakePanelProps) {
  const { t } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const [tab, setTab] = useState<WakeTab>('wake-settings');
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  /** The server's per-field errors from the last save (path → message). */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [enabled, setEnabled] = useState(false);
  const [hold, setHold] = useState(10);
  const [settle, setSettle] = useState(3);
  const [marker, setMarker] = useState('');
  const [fcmProject, setFcmProject] = useState('');
  const [saFile, setSaFile] = useState<KeyFile>(undefined);
  const [keyId, setKeyId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [p8File, setP8File] = useState<KeyFile>(undefined);
  const [sandbox, setSandbox] = useState(false);
  const [rotating, setRotating] = useState(false);

  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });

  const apply = useCallback((c: PushConfig) => {
    setConfig(c);
    setEnabled(c.mobile_wake.enabled);
    setHold(c.mobile_wake.hold_seconds);
    setSettle(c.mobile_wake.settle_seconds);
    setMarker(c.mobile_wake.client_marker);
    setFcmProject(c.fcm.project_id);
    setKeyId(c.apns.key_id);
    setTeamId(c.apns.team_id);
    setBundleId(c.apns.bundle_id);
    setSandbox(c.apns.sandbox);
    setSaFile(undefined);
    setP8File(undefined);
    onLoadedRef.current?.(c);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api<PushConfig>('/api/push/config').then(apply).catch((e) => setLoadError(toApiError(e).message));
  }, [apply]);

  useEffect(() => { load(); }, [load]);

  const pickServiceAccount = async (file: File) => {
    const text = await file.text();
    setSaFile({ name: file.name, text });
    // Fill the project ID from the key when it is still empty.
    try {
      const info = JSON.parse(text);
      if (!fcmProject && typeof info?.project_id === 'string') setFcmProject(info.project_id);
    } catch { /* the server reports what is wrong with it */ }
  };

  const pickP8 = async (file: File) => {
    setP8File({ name: file.name, text: await file.text() });
    // Apple names the download AuthKey_<Key ID>.p8.
    const m = file.name.match(/AuthKey_([A-Z0-9]{10})\.p8$/i);
    if (m && !keyId) setKeyId(m[1].toUpperCase());
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const body: Record<string, unknown> = {
        enabled, hold_seconds: hold, settle_seconds: settle, client_marker: marker,
        fcm_project_id: fcmProject, apns_key_id: keyId, apns_team_id: teamId, apns_bundle_id: bundleId,
        apns_sandbox: sandbox,
      };
      if (saFile !== undefined) body.fcm_service_account = saFile ? saFile.text : '';
      if (p8File !== undefined) body.apns_auth_key = p8File ? p8File.text : '';
      apply(await api<PushConfig>('/api/push/config', { method: 'PUT', body }));
      setMessage({ type: 'success', text: t('mobileWake.saved', 'Saved. Asterisk dialplan reloaded.') });
    } catch (e) {
      // A 422 names every wrong field: each shows under its control, the summary below.
      const err = toApiError(e);
      setFieldErrors(err.fieldErrors());
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    if (!config) return;
    if (config.web.public_key) {
      const ok = await confirm({
        title: t('mobileWake.web.replace', 'Replace keys'),
        message: t('mobileWake.web.confirm', 'Every browser has to subscribe again. Continue?'),
        confirmLabel: t('mobileWake.web.replace', 'Replace keys'),
        cancelLabel: t('common.cancel', 'Cancel'),
      });
      if (!ok) return;
    }
    setRotating(true);
    setMessage(null);
    try {
      const res = await api<{ public_key: string; removed_subscriptions: number }>('/api/push/vapid/rotate', { method: 'POST' });
      setConfig((c) => c && { ...c, web: { ...c.web, public_key: res.public_key, ready: c.web.library_installed } });
      setMessage({
        type: 'success',
        text: t('mobileWake.web.rotated', 'New web push keys. {{count}} browser subscription(s) removed; browsers subscribe again on their next visit.', { count: res.removed_subscriptions }),
      });
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setRotating(false);
    }
  };

  // Re-reads only the device list, so unsaved timing or key edits survive a refresh.
  const [refreshing, setRefreshing] = useState(false);
  const refreshDevices = async () => {
    setRefreshing(true);
    try {
      const fresh = await api<PushConfig>('/api/push/config');
      setConfig((c) => c && { ...c, bindings: fresh.bindings });
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setRefreshing(false);
    }
  };

  const forget = async (b: PushBinding) => {
    try {
      await api(`/api/push/bindings/${b.id}`, { method: 'DELETE' });
      setConfig((c) => c && { ...c, bindings: c.bindings.filter((x) => x.id !== b.id) });
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
    }
  };

  const readyBadge = (ready: boolean) => (
    <Badge tone={ready ? 'success' : 'neutral'}>
      {ready ? t('mobileWake.ready', 'Ready') : t('mobileWake.notConfigured', 'Not configured')}
    </Badge>
  );

  const keyFileRow = (
    file: KeyFile, setFile: (f: KeyFile) => void, stored: boolean, storedLabel: string,
    source: 'ui' | 'env' | null, accept: string, onPick: (f: File) => void,
  ) => (
    <div className="u-col u-gap-2">
      <span className="u-text-sm u-fg-secondary u-truncate">
        {file
          ? t('mobileWake.fileNew', 'New: {{name}}', { name: file.name })
          : file === null
            ? t('mobileWake.fileRemoved', 'Will be removed')
            : stored
              ? `${storedLabel}${source === 'env' ? ` (${t('mobileWake.fromEnv', 'from .env')})` : ''}`
              : t('mobileWake.fileNone', 'No key uploaded')}
      </span>
      <div className="u-row u-gap-2 u-wrap">
        <FileUpload
          accept={accept}
          onFile={onPick}
          label={stored || file ? t('mobileWake.replace', 'Replace') : t('mobileWake.upload', 'Upload')}
        />
        {file !== undefined ? (
          <button type="button" className="btn" onClick={() => setFile(undefined)}>
            <Undo2 size={14} /> {t('mobileWake.keepExisting', 'Keep existing')}
          </button>
        ) : stored && source === 'ui' ? (
          <button type="button" className="btn" onClick={() => setFile(null)}>
            <Trash2 size={14} /> {t('common.remove', 'Remove')}
          </button>
        ) : null}
      </div>
    </div>
  );

  if (loadError) {
    return (
      <Card {...card}>
        <Alert tone="error" action={
          <button type="button" className="btn" onClick={load}>
            <RefreshCw size={14} /> {t('common.retry', 'Retry')}
          </button>
        }>{loadError}</Alert>
      </Card>
    );
  }
  if (!config) {
    return (
      <Card {...card}>
        <Loading size="sm" label={t('settings.loading', 'Loading…')} />
      </Card>
    );
  }

  const deviceColumns: Column<PushBinding>[] = [
    { key: 'extension', header: t('fields.extension', 'Extension'), primary: true, cell: b => b.extension },
    {
      key: 'provider', header: t('mobileWake.devices.provider', 'Provider'),
      cell: b => <>{b.provider}{b.param && <span className="u-fg-muted"> · {b.param}</span>}</>,
    },
    { key: 'token', header: t('mobileWake.devices.token', 'Token'), hideOnMobile: true, cell: b => <code className="u-mono u-text-sm">{b.token}</code> },
    { key: 'app', header: t('mobileWake.devices.app', 'App'), cell: b => b.user_agent || '—' },
    {
      key: 'seen', header: t('mobileWake.devices.lastSeen', 'Last seen'),
      cell: b => (b.last_seen_at ? new Date(b.last_seen_at).toLocaleString() : '—'),
    },
    {
      key: 'forget', header: '', label: t('mobileWake.devices.forget', 'Forget this device'), align: 'end',
      cell: b => (
        <button type="button" className="btn btn-ghost btn-danger btn-sm btn-icon" onClick={() => forget(b)}
          aria-label={t('mobileWake.devices.forget', 'Forget this device')}
          title={t('mobileWake.devices.forget', 'Forget this device')}>
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  // Devices act per row; only the timings and keys are saved by the footer button.
  const footer = tab !== 'wake-devices' ? (
    <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
      {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
      {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
    </button>
  ) : undefined;

  const actions = tab === 'wake-devices' ? (
    <>
      {card.actions}
      <button type="button" className="btn btn-ghost" onClick={refreshDevices} disabled={refreshing}>
        {refreshing ? <Loader2 size={14} className="spinner" /> : <RefreshCw size={14} />} {t('common.refresh', 'Refresh')}
      </button>
    </>
  ) : card.actions;

  return (
    <Card {...card} actions={actions} footer={footer}>
      <Tabs
        ariaLabel={t('settings.mobileWake.sections', 'Mobile wake sections')}
        tabs={[
          { key: 'wake-settings', label: t('settings.mobileWake.tabWake', 'Wake'), icon: <Timer size={14} /> },
          { key: 'wake-keys', label: t('settings.mobileWake.tabKeys', 'Push keys'), icon: <KeyRound size={14} /> },
          { key: 'wake-devices', label: t('settings.mobileWake.tabDevices', 'Devices'), icon: <Smartphone size={14} />, count: config.bindings.length },
        ]}
        active={tab}
        onChange={k => setTab(k as WakeTab)}
      />

      {/* Is it working? — at a glance, on every tab. */}
      <div className="u-row u-gap-2 u-wrap u-mb-4" role="status" aria-label={t('settings.mobileWake.statusLabel', 'Mobile wake status')}>
        {config.mobile_wake.enabled
          ? <Badge tone="success">{t('settings.mobileWake.on', 'Wake on')} · {config.mobile_wake.hold_seconds}s</Badge>
          : <Badge>{t('settings.mobileWake.off', 'Wake off')}</Badge>}
        <Badge tone={config.fcm.ready ? 'success' : 'neutral'}>
          {t('mobileWake.fcm.title', 'Android (FCM)')}: {config.fcm.ready ? t('mobileWake.ready', 'Ready') : t('mobileWake.notConfigured', 'Not configured')}
        </Badge>
        <Badge tone={config.apns.ready ? 'success' : 'neutral'}>
          {t('mobileWake.apns.title', 'iOS (APNs)')}: {config.apns.ready ? t('mobileWake.ready', 'Ready') : t('mobileWake.notConfigured', 'Not configured')}
        </Badge>
        <Badge tone={config.web.ready ? 'success' : 'neutral'}>
          {t('mobileWake.web.title', 'Web push (VAPID)')}: {config.web.ready ? t('mobileWake.ready', 'Ready') : t('mobileWake.notConfigured', 'Not configured')}
        </Badge>
        <Badge tone={config.bindings.length ? 'info' : 'neutral'}>
          {t('settings.mobileWake.rfcPhones', { defaultValue: 'RFC 8599 phones: {{count}}', count: config.bindings.length })}
        </Badge>
      </div>

      {tab === 'wake-settings' && (
        <div id="tabpanel-wake-settings" role="tabpanel" aria-labelledby="tab-wake-settings">
          <p className="u-text-sm u-fg-secondary u-mb-3">
            {t('mobileWake.description', 'Wake a closed mobile softphone for incoming calls (RFC 8599). The phone puts its push token in its SIP REGISTER; OpDesk pushes it, holds the call until it re-registers, then lets it ring.')}{' '}
            <a href={MEDUT_REPO_URL} target="_blank" rel="noopener noreferrer" className="u-fg-accent u-inline-row u-gap-1">
              {t('mobileWake.recommended', 'Recommended app: Medut Softphone')} <ExternalLink size={12} />
            </a>
          </p>
          <Toggle checked={enabled} onChange={setEnabled}
            label={t('common.enabled', 'Enabled')}
            description={t('mobileWake.enabledHint', 'Before an extension with a push binding is dialed, push it and hold the call while the app wakes up.')} />
          <FormRow>
            <FormField label={t('mobileWake.hold', 'Hold time (seconds)')} htmlFor="mw-hold" error={fieldErrors.hold_seconds}
              hint={t('mobileWake.holdHint', 'Longest the caller waits for the phone to wake and re-register. 8 to 30.')}>
              <input id="mw-hold" aria-invalid={!!fieldErrors.hold_seconds || undefined} type="number" className="form-input" dir="ltr" min={8} max={30} value={hold}
                onChange={(e) => setHold(Number(e.target.value))} />
            </FormField>
            <FormField label={t('mobileWake.settle', 'Settle window (seconds)')} htmlFor="mw-settle" error={fieldErrors.settle_seconds}
              hint={t('mobileWake.settleHint', 'Extra wait after the re-registration so the app is ready to ring. 0 to 10.')}>
              <input id="mw-settle" aria-invalid={!!fieldErrors.settle_seconds || undefined} type="number" className="form-input" dir="ltr" min={0} max={10} value={settle}
                onChange={(e) => setSettle(Number(e.target.value))} />
            </FormField>
          </FormRow>
          <FormRow single>
            <FormField label={t('mobileWake.marker', 'Mobile client marker')} htmlFor="mw-marker" error={fieldErrors.client_marker}
              hint={t('mobileWake.markerHint', 'Text in the SIP User-Agent that marks a mobile client, so a desk phone on the same extension does not count as the phone waking up. Contacts with RFC 8599 pn-* parameters always count.')}>
              <input id="mw-marker" aria-invalid={!!fieldErrors.client_marker || undefined} className="form-input" dir="ltr" value={marker} onChange={(e) => setMarker(e.target.value)} spellCheck={false} />
            </FormField>
          </FormRow>
        </div>
      )}

      {tab === 'wake-keys' && (
        <div id="tabpanel-wake-keys" role="tabpanel" aria-labelledby="tab-wake-keys">
          <FormSection title={t('mobileWake.fcm.title', 'Android (FCM)')} first>
            <div className="u-mb-3">{readyBadge(config.fcm.ready)}</div>
            <FormRow>
              <FormField label={t('mobileWake.fcm.project', 'FCM project ID')} htmlFor="mw-fcm-project" error={fieldErrors.fcm_project_id}
                hint={t('mobileWake.fcm.projectHint', 'Must match pn-param in the phone\'s REGISTER.')}>
                <input id="mw-fcm-project" aria-invalid={!!fieldErrors.fcm_project_id || undefined} className="form-input" dir="ltr" value={fcmProject} onChange={(e) => setFcmProject(e.target.value)} spellCheck={false} />
              </FormField>
              <FormField label={t('mobileWake.fcm.serviceAccount', 'Service account JSON')} error={fieldErrors.fcm_service_account}
                hint={t('mobileWake.fcm.serviceAccountHint', 'Firebase console → Project settings → Service accounts → Generate new private key.')}>
                {keyFileRow(saFile, setSaFile, config.fcm.has_service_account, config.fcm.service_account_email,
                  config.fcm.source, 'application/json,.json', pickServiceAccount)}
              </FormField>
            </FormRow>
          </FormSection>

          <FormSection title={t('mobileWake.apns.title', 'iOS (APNs)')}>
            <div className="u-mb-3">{readyBadge(config.apns.ready)}</div>
            <FormRow>
              <FormField label={t('mobileWake.apns.keyId', 'Key ID')} htmlFor="mw-key-id" error={fieldErrors.apns_key_id}>
                <input id="mw-key-id" aria-invalid={!!fieldErrors.apns_key_id || undefined} className="form-input" dir="ltr" maxLength={10} value={keyId} onChange={(e) => setKeyId(e.target.value.toUpperCase())} spellCheck={false} />
              </FormField>
              <FormField label={t('mobileWake.apns.teamId', 'Team ID')} htmlFor="mw-team-id" error={fieldErrors.apns_team_id}>
                <input id="mw-team-id" aria-invalid={!!fieldErrors.apns_team_id || undefined} className="form-input" dir="ltr" maxLength={10} value={teamId} onChange={(e) => setTeamId(e.target.value.toUpperCase())} spellCheck={false} />
              </FormField>
            </FormRow>
            <FormRow>
              <FormField label={t('mobileWake.apns.bundleId', 'Bundle ID')} htmlFor="mw-bundle" error={fieldErrors.apns_bundle_id}
                hint={t('mobileWake.apns.bundleHint', 'VoIP pushes go to <bundle ID>.voip unless the phone\'s pn-param names a topic.')}>
                <input id="mw-bundle" aria-invalid={!!fieldErrors.apns_bundle_id || undefined} className="form-input" dir="ltr" value={bundleId} onChange={(e) => setBundleId(e.target.value)} spellCheck={false} />
              </FormField>
              <FormField label={t('mobileWake.apns.authKey', 'Auth key (.p8)')} error={fieldErrors.apns_auth_key}
                hint={t('mobileWake.apns.authKeyHint', 'Apple Developer → Keys, with Apple Push Notifications service.')}>
                {keyFileRow(p8File, setP8File, config.apns.has_auth_key, t('mobileWake.apns.keyStored', 'Key stored'),
                  config.apns.source, '.p8', pickP8)}
              </FormField>
            </FormRow>
            <Toggle checked={sandbox} onChange={setSandbox}
              label={t('mobileWake.apns.sandbox', 'Use APNs sandbox')}
              description={t('mobileWake.apns.sandboxHint', 'For development builds whose binding says only "apns". A binding with pn-provider=apns-sandbox always uses the sandbox.')} />
          </FormSection>

          <FormSection title={t('mobileWake.web.title', 'Web push (VAPID)')}>
            <div className="u-row u-between u-wrap u-gap-3">
              <div className="u-col u-gap-1 u-min-w-0">
                <div>{readyBadge(config.web.ready)}</div>
                <span className="u-text-sm u-fg-secondary">
                  {config.web.public_key
                    ? <>{t('mobileWake.web.publicKey', 'Public key')}: <code className="u-mono">{config.web.public_key.slice(0, 24)}…</code></>
                    : t('mobileWake.web.noKeys', 'No keys yet: browser push stays off until you create them.')}
                  {!config.web.library_installed && <> {t('mobileWake.web.noLibrary', '(pywebpush is not installed on the server.)')}</>}
                </span>
              </div>
              <button type="button" className="btn" onClick={rotate} disabled={rotating}>
                {rotating ? <Loader2 size={14} className="spinner" /> : <RefreshCw size={14} />}
                {config.web.public_key ? t('mobileWake.web.replace', 'Replace keys') : t('mobileWake.web.create', 'Create keys')}
              </button>
            </div>
          </FormSection>
        </div>
      )}

      {tab === 'wake-devices' && (
        <div id="tabpanel-wake-devices" role="tabpanel" aria-labelledby="tab-wake-devices">
          <Table
            columns={deviceColumns}
            rows={config.bindings}
            rowKey={b => b.id}
            framed
            caption={t('mobileWake.devices.title', 'Registered devices (RFC 8599)')}
            empty={
              <EmptyState
                size="sm"
                icon={Smartphone}
                title={t('settings.pushKeys.devices.emptyTitle', 'No devices yet')}
                description={t('mobileWake.devices.none', 'None yet. A device appears here after it registers with pn-provider, pn-prid and pn-param in its Contact.')}
              />
            }
          />
        </div>
      )}

      <Alert tone={message?.type === 'success' ? 'success' : 'error'} className="u-mt-4">{message?.text}</Alert>
      {confirmDialog}
    </Card>
  );
}
