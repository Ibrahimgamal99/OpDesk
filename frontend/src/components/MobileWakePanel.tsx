import React, { useEffect, useRef, useState } from 'react';
import {
  Smartphone, Loader2, Save, CheckCircle2, AlertCircle, Upload, Trash2, RefreshCw, KeyRound, ExternalLink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Toggle } from './ui/Toggle';
import { FormSection, FormRow, FormField } from './ui/Form';
import { api, toApiError } from '../lib/api';
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

interface PushConfig {
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

export function MobileWakePanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  const saInput = useRef<HTMLInputElement>(null);
  const p8Input = useRef<HTMLInputElement>(null);

  const apply = (c: PushConfig) => {
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
  };

  useEffect(() => {
    api<PushConfig>('/api/push/config').then(apply).catch((e) => setLoadError(toApiError(e).message));
  }, []);

  const pickServiceAccount = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    setSaFile({ name: file.name, text });
    // Fill the project ID from the key when it is still empty.
    try {
      const info = JSON.parse(text);
      if (!fcmProject && typeof info?.project_id === 'string') setFcmProject(info.project_id);
    } catch { /* the server reports what is wrong with it */ }
  };

  const pickP8 = async (file?: File) => {
    if (!file) return;
    setP8File({ name: file.name, text: await file.text() });
    // Apple names the download AuthKey_<Key ID>.p8.
    const m = file.name.match(/AuthKey_([A-Z0-9]{10})\.p8$/i);
    if (m && !keyId) setKeyId(m[1].toUpperCase());
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
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
      setMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
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
      setConfirmRotate(false);
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

  const status = (ready: boolean) => (
    <span className={`badge ${ready ? 'badge-success' : 'badge-muted'}`}>
      {ready ? t('mobileWake.ready', 'Ready') : t('mobileWake.notConfigured', 'Not configured')}
    </span>
  );

  const keyFileRow = (
    file: KeyFile, setFile: (f: KeyFile) => void, stored: boolean, storedLabel: string,
    source: 'ui' | 'env' | null, input: React.RefObject<HTMLInputElement>, accept: string,
    onPick: (f?: File) => void,
  ) => (
    <div className="mw-file">
      <span className="mw-file-state">
        {file
          ? t('mobileWake.fileNew', 'New: {{name}}', { name: file.name })
          : file === null
            ? t('mobileWake.fileRemoved', 'Will be removed')
            : stored
              ? `${storedLabel}${source === 'env' ? ` (${t('mobileWake.fromEnv', 'from .env')})` : ''}`
              : t('mobileWake.fileNone', 'No key uploaded')}
      </span>
      <input ref={input} type="file" accept={accept} hidden
        onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }} />
      <button type="button" className="btn" onClick={() => input.current?.click()}>
        <Upload size={14} /> {stored || file ? t('mobileWake.replace', 'Replace') : t('mobileWake.upload', 'Upload')}
      </button>
      {file !== undefined ? (
        <button type="button" className="btn" onClick={() => setFile(undefined)}>
          {t('mobileWake.keepExisting', 'Keep existing')}
        </button>
      ) : stored && source === 'ui' ? (
        <button type="button" className="btn" onClick={() => setFile(null)} title={t('mobileWake.remove', 'Remove')}>
          <Trash2 size={14} />
        </button>
      ) : null}
    </div>
  );

  if (loadError) {
    return (
      <div className="up-add-card"><div className="up-add-body">
        <div className="up-alert error"><AlertCircle size={20} /><span>{loadError}</span></div>
      </div></div>
    );
  }
  if (!config) {
    return <div className="up-add-card"><div className="up-add-body mw-qr-loading"><Loader2 size={20} className="spinner" /></div></div>;
  }

  return (
    <div className="up-add-card">
      <div className="up-add-header">
        <div className="up-add-icon"><Smartphone size={24} /></div>
        <div>
          <h2 className="up-add-title">{t('mobileWake.title', 'Mobile Wake')}</h2>
          <p className="up-add-desc">
            {t('mobileWake.description', 'Wake a closed mobile softphone for incoming calls (RFC 8599). The phone puts its push token in its SIP REGISTER; OpDesk pushes it, holds the call until it re-registers, then lets it ring.')}{' '}
            <a href={MEDUT_REPO_URL} target="_blank" rel="noopener noreferrer" className="mw-link">
              {t('mobileWake.recommended', 'Recommended app: Medut Softphone')} <ExternalLink size={12} />
            </a>
          </p>
        </div>
      </div>

      <div className="up-add-body">
        <FormSection title={t('mobileWake.general', 'Mobile Wake')} first>
          <Toggle checked={enabled} onChange={setEnabled}
            label={t('mobileWake.enabled', 'Enabled')}
            description={t('mobileWake.enabledHint', 'Before an extension with a push binding is dialed, push it and hold the call while the app wakes up.')} />
          <FormRow>
            <FormField label={t('mobileWake.hold', 'Hold time (seconds)')} htmlFor="mw-hold"
              hint={t('mobileWake.holdHint', 'Longest the caller waits for the phone to wake and re-register. 8 to 30.')}>
              <input id="mw-hold" type="number" className="form-input" min={8} max={30} value={hold}
                onChange={(e) => setHold(Number(e.target.value))} />
            </FormField>
            <FormField label={t('mobileWake.settle', 'Settle window (seconds)')} htmlFor="mw-settle"
              hint={t('mobileWake.settleHint', 'Extra wait after the re-registration so the app is ready to ring. 0 to 10.')}>
              <input id="mw-settle" type="number" className="form-input" min={0} max={10} value={settle}
                onChange={(e) => setSettle(Number(e.target.value))} />
            </FormField>
          </FormRow>
          <FormRow single>
            <FormField label={t('mobileWake.marker', 'Mobile client marker')} htmlFor="mw-marker"
              hint={t('mobileWake.markerHint', 'Text in the SIP User-Agent that marks a mobile client, so a desk phone on the same extension does not count as the phone waking up. Contacts with RFC 8599 pn-* parameters always count.')}>
              <input id="mw-marker" className="form-input" value={marker} onChange={(e) => setMarker(e.target.value)} spellCheck={false} />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection title={t('mobileWake.fcm.title', 'Android (FCM)')}>
          <div className="mw-status">{status(config.fcm.ready)}</div>
          <FormRow>
            <FormField label={t('mobileWake.fcm.project', 'FCM project ID')} htmlFor="mw-fcm-project"
              hint={t('mobileWake.fcm.projectHint', 'Must match pn-param in the phone\'s REGISTER.')}>
              <input id="mw-fcm-project" className="form-input" value={fcmProject} onChange={(e) => setFcmProject(e.target.value)} spellCheck={false} />
            </FormField>
            <FormField label={t('mobileWake.fcm.serviceAccount', 'Service account JSON')}
              hint={t('mobileWake.fcm.serviceAccountHint', 'Firebase console → Project settings → Service accounts → Generate new private key.')}>
              {keyFileRow(saFile, setSaFile, config.fcm.has_service_account, config.fcm.service_account_email,
                config.fcm.source, saInput, 'application/json,.json', pickServiceAccount)}
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection title={t('mobileWake.apns.title', 'iOS (APNs)')}>
          <div className="mw-status">{status(config.apns.ready)}</div>
          <FormRow>
            <FormField label={t('mobileWake.apns.keyId', 'Key ID')} htmlFor="mw-key-id">
              <input id="mw-key-id" className="form-input" maxLength={10} value={keyId} onChange={(e) => setKeyId(e.target.value.toUpperCase())} spellCheck={false} />
            </FormField>
            <FormField label={t('mobileWake.apns.teamId', 'Team ID')} htmlFor="mw-team-id">
              <input id="mw-team-id" className="form-input" maxLength={10} value={teamId} onChange={(e) => setTeamId(e.target.value.toUpperCase())} spellCheck={false} />
            </FormField>
          </FormRow>
          <FormRow>
            <FormField label={t('mobileWake.apns.bundleId', 'Bundle ID')} htmlFor="mw-bundle"
              hint={t('mobileWake.apns.bundleHint', 'VoIP pushes go to <bundle ID>.voip unless the phone\'s pn-param names a topic.')}>
              <input id="mw-bundle" className="form-input" value={bundleId} onChange={(e) => setBundleId(e.target.value)} spellCheck={false} />
            </FormField>
            <FormField label={t('mobileWake.apns.authKey', 'Auth key (.p8)')}
              hint={t('mobileWake.apns.authKeyHint', 'Apple Developer → Keys, with Apple Push Notifications service.')}>
              {keyFileRow(p8File, setP8File, config.apns.has_auth_key, t('mobileWake.apns.keyStored', 'Key stored'),
                config.apns.source, p8Input, '.p8', pickP8)}
            </FormField>
          </FormRow>
          <Toggle checked={sandbox} onChange={setSandbox}
            label={t('mobileWake.apns.sandbox', 'Use APNs sandbox')}
            description={t('mobileWake.apns.sandboxHint', 'For development builds whose binding says only "apns". A binding with pn-provider=apns-sandbox always uses the sandbox.')} />
        </FormSection>

        <FormSection title={t('mobileWake.web.title', 'Web push (VAPID)')}>
          <div className="mw-status">{status(config.web.ready)}</div>
          <p className="up-hint">
            {config.web.public_key
              ? <>{t('mobileWake.web.publicKey', 'Public key')}: <code className="mw-code">{config.web.public_key.slice(0, 24)}…</code></>
              : t('mobileWake.web.noKeys', 'No keys yet: browser push stays off until you create them.')}
            {!config.web.library_installed && <> {t('mobileWake.web.noLibrary', '(pywebpush is not installed on the server.)')}</>}
          </p>
          <div className="mw-actions">
            {confirmRotate ? (
              <>
                <span className="up-hint">{t('mobileWake.web.confirm', 'Every browser has to subscribe again. Continue?')}</span>
                <button type="button" className="btn btn-primary" onClick={rotate} disabled={rotating}>
                  {rotating ? <Loader2 size={14} className="spinner" /> : <KeyRound size={14} />}
                  {config.web.public_key ? t('mobileWake.web.replace', 'Replace keys') : t('mobileWake.web.create', 'Create keys')}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmRotate(false)} disabled={rotating}>
                  {t('common.cancel', 'Cancel')}
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => (config.web.public_key ? setConfirmRotate(true) : rotate())} disabled={rotating}>
                <RefreshCw size={14} /> {config.web.public_key ? t('mobileWake.web.replace', 'Replace keys') : t('mobileWake.web.create', 'Create keys')}
              </button>
            )}
          </div>
        </FormSection>

        <FormSection title={t('mobileWake.devices.title', 'Registered devices (RFC 8599)')}>
          {config.bindings.length === 0 ? (
            <p className="up-hint">{t('mobileWake.devices.none', 'None yet. A device appears here after it registers with pn-provider, pn-prid and pn-param in its Contact.')}</p>
          ) : (
            <div className="mw-table-wrap">
              <table className="mw-table">
                <thead>
                  <tr>
                    <th>{t('mobileWake.devices.extension', 'Extension')}</th>
                    <th>{t('mobileWake.devices.provider', 'Provider')}</th>
                    <th>{t('mobileWake.devices.token', 'Token')}</th>
                    <th>{t('mobileWake.devices.app', 'App')}</th>
                    <th>{t('mobileWake.devices.lastSeen', 'Last seen')}</th>
                    <th aria-label={t('mobileWake.remove', 'Remove')} />
                  </tr>
                </thead>
                <tbody>
                  {config.bindings.map((b) => (
                    <tr key={b.id}>
                      <td>{b.extension}</td>
                      <td>{b.provider}{b.param ? <span className="up-hint"> · {b.param}</span> : null}</td>
                      <td><code className="mw-code">{b.token}</code></td>
                      <td>{b.user_agent || '—'}</td>
                      <td>{b.last_seen_at ? new Date(b.last_seen_at).toLocaleString() : '—'}</td>
                      <td>
                        <button type="button" className="btn" onClick={() => forget(b)} title={t('mobileWake.devices.forget', 'Forget this device')}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </FormSection>

        {message && (
          <div className={`up-alert ${message.type}`} style={{ marginTop: 16 }}>
            {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span>{message.text}</span>
          </div>
        )}
        <div className="mw-actions mw-save">
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
            {saving ? t('mobileWake.saving', 'Saving…') : t('mobileWake.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
