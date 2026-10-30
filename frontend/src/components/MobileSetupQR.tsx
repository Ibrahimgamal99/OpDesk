import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, Loader2, Copy, ClipboardCheck, Download, ExternalLink, Save, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, FormField, Loading, Modal, Toggle } from './ui';
import { api, toApiError } from '../lib/api';
import { getUser } from '../auth';
import '../styles/account.css';

export const MEDUT_REPO_URL = 'https://github.com/Ibrahimgamal99/medut-softphone';
const ACCOUNT_FORMAT_URL = `${MEDUT_REPO_URL}/blob/main/docs/account-setup.md`;

interface MobileSetup {
  extension: string;
  display_name: string;
  password: string;
  host: string;
  verify_tls: boolean;
  /** The port the PBX transport listens on; null for a WebSocket transport. */
  pbx_sip_port: number | null;
  /** The admin-saved port for this transport, already written into account.uri; null = none. */
  saved_sip_port: number | null;
  /** The full Medut account JSON, built by the server from the extension's PBX settings. */
  account: Record<string, unknown>;
}

/**
 * The Medut account JSON (medut-softphone docs/account-setup.md) as the server built it:
 * transport, web link, media encryption, ICE, STUN/TURN and the certificate check all
 * written, so the phone connects the way the extension accepts calls instead of "Auto"
 * keeping whichever transport registers first. Without the password, the app asks for it.
 */
export function buildMedutAccount(s: MobileSetup, includePassword: boolean, sipPort?: number | null): Record<string, unknown> {
  const account = { ...s.account };
  if (!includePassword || !account.password) delete account.password;
  if (sipPort) account.uri = withSipPort(String(account.uri ?? ''), sipPort);
  return account;
}

/** WebSocket transports carry their port in server_url, not in the SIP uri. */
function usesSipPort(account: Record<string, unknown>): boolean {
  return account.transport !== 'ws' && account.transport !== 'wss';
}

/** The port written in "ext@host[:port]", or the transport's default (5061 TLS, else 5060). */
function sipPortOf(account: Record<string, unknown>): number {
  const m = /:(\d+)$/.exec(String(account.uri ?? ''));
  if (m) return Number(m[1]);
  return account.transport === 'tls' ? 5061 : 5060;
}

/** "ext@host[:port]" with the port replaced by `port`. */
function withSipPort(uri: string, port: number): string {
  return `${uri.replace(/:\d+$/, '')}:${port}`;
}

function isValidPort(v: string): boolean {
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Admin view of another user's extension; omit for the current user's own. */
  userId?: number;
  /** Shown in the title, e.g. the username. */
  label?: string;
}

export function MobileSetupQR({ open, onClose, userId, label }: Props) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      width="md"
      icon={<QrCode size={18} />}
      title={label
        ? t('mobileSetup.titleFor', 'Mobile app setup — {{name}}', { name: label })
        : t('mobileSetup.title', 'Set up the mobile app')}
    >
      {/* Mounted per opening, so every opening starts from fresh data. */}
      {open && <MobileSetupBody userId={userId} />}
    </Modal>
  );
}

/** The QR + account JSON on its own, for the modal and the My Profile page. */
export function MobileSetupBody({ userId }: { userId?: number }) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<MobileSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includePassword, setIncludePassword] = useState(true);
  const [qr, setQr] = useState<string>('');
  const [copied, setCopied] = useState(false);
  // The SIP port written into "uri"; '' until the setup loads. Edit it when the phone
  // reaches the PBX on another port than it listens on (NAT port forward).
  const [portInput, setPortInput] = useState('');
  // The saved per-transport default, kept here so saving updates the screen without a refetch.
  const [savedPort, setSavedPort] = useState<number | null>(null);
  const [savingPort, setSavingPort] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const isAdmin = getUser()?.role === 'admin';

  useEffect(() => {
    let cancelled = false;
    api<MobileSetup>(userId != null ? `/api/settings/users/${userId}/mobile-setup` : '/api/mobile-setup')
      .then((data) => {
        if (cancelled) return;
        setSetup(data);
        setSavedPort(data.saved_sip_port ?? null);
        setPortInput(String(sipPortOf(data.account)));
      })
      .catch((e) => { if (!cancelled) setError(toApiError(e).message); });
    return () => { cancelled = true; };
  }, [userId]);

  const showPort = setup ? usesSipPort(setup.account) : false;
  const portValid = isValidPort(portInput);
  // Only rewrite the uri when the port was changed; otherwise keep the server's.
  const sipPort = showPort && portValid && setup && Number(portInput) !== sipPortOf(setup.account) ? Number(portInput) : null;
  const account = useMemo(
    () => (setup ? buildMedutAccount(setup, includePassword, sipPort) : null),
    [setup, includePassword, sipPort],
  );
  const json = account ? JSON.stringify(account, null, 2) : '';

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    // The compact form keeps the code small enough to scan from a screen.
    QRCode.toDataURL(JSON.stringify(account), { errorCorrectionLevel: 'M', margin: 2, width: 320 })
      .then((url) => { if (!cancelled) setQr(url); })
      .catch(() => { if (!cancelled) setQr(''); });
    return () => { cancelled = true; };
  }, [account]);

  const transport = String(setup?.account.transport ?? '');
  const transportLabel = transport.toUpperCase();
  const pbxPort = setup?.pbx_sip_port ?? null;
  const defaultPort = savedPort ?? pbxPort;

  /** Save `port` as this transport's default for every setup QR; null (or the PBX's own port) clears it. */
  const saveDefaultPort = async (port: number | null) => {
    const value = port === pbxPort ? null : port;
    setSavingPort(true);
    setPortError(null);
    try {
      await api('/api/settings/mobile-sip-port', { method: 'PUT', body: { transport, port: value } });
      setSavedPort(value);
      if (port === null && pbxPort !== null) setPortInput(String(pbxPort));
    } catch (e) {
      setPortError(toApiError(e).message);
    } finally {
      setSavingPort(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (http, permissions): the JSON stays selectable below */
    }
  };

  if (error) {
    return <Alert>{error}</Alert>;
  }
  if (!setup) {
    return <Loading size="sm" />;
  }

  return (
    <div className="u-col u-gap-4">
      <p className="u-text-sm u-fg-secondary u-mt-0 u-mb-0">
        {t('mobileSetup.intro', 'Scan this code in Medut Softphone (sign-in screen → Scan QR) to add extension {{ext}}. It carries the connection the PBX expects for this extension: transport, encryption and ICE.', { ext: setup.extension })}{' '}
        <a href={MEDUT_REPO_URL} target="_blank" rel="noopener noreferrer" className="acct-link">
          {t('mobileSetup.getApp', 'Get Medut Softphone')} <ExternalLink size={12} />
        </a>
      </p>

      <div className="acct-qr-code">
        {qr ? <img src={qr} alt={t('mobileSetup.qrAlt', 'Account QR code')} /> : <Loader2 size={20} className="spinner" />}
      </div>

      {showPort && (
        <FormField
          label={t('mobileSetup.sipPort', 'SIP port')}
          htmlFor="mobile-setup-port"
          hint={savedPort !== null
            ? t('mobileSetup.sipPortSavedHint', 'Saved default for {{transport}} extensions: {{port}} (the PBX listens on {{pbx}}). Change it here for this code only.', { transport: transportLabel, port: savedPort, pbx: pbxPort })
            : t('mobileSetup.sipPortHint', 'The port the phone connects to. Change it when the PBX is reached through a forwarded port (e.g. 5162 instead of 5060).')}
          error={!portValid ? t('mobileSetup.sipPortInvalid', 'Enter a port from 1 to 65535.') : portError ?? undefined}
        >
          <div className="u-row u-gap-2">
            <input id="mobile-setup-port" type="number" className="form-input" dir="ltr" min={1} max={65535}
              value={portInput} onChange={(e) => setPortInput(e.target.value)} />
            {isAdmin && portValid && Number(portInput) !== defaultPort && (
              <button type="button" className="btn btn-sm" disabled={savingPort}
                onClick={() => saveDefaultPort(Number(portInput))}
                title={t('mobileSetup.sipPortSaveHint', 'Every setup code for a {{transport}} extension uses this port.', { transport: transportLabel })}>
                {savingPort ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                {t('mobileSetup.sipPortSave', 'Save for all {{transport}}', { transport: transportLabel })}
              </button>
            )}
            {isAdmin && savedPort !== null && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={savingPort}
                onClick={() => saveDefaultPort(null)}>
                <RotateCcw size={14} />
                {t('mobileSetup.sipPortReset', 'Use PBX port ({{pbx}})', { pbx: pbxPort })}
              </button>
            )}
          </div>
        </FormField>
      )}

      <Toggle
        checked={includePassword}
        onChange={setIncludePassword}
        label={t('mobileSetup.includePassword', 'Include the password')}
        description={includePassword
          ? t('mobileSetup.passwordOn', 'One scan signs in. Treat the code like the password itself.')
          : t('mobileSetup.passwordOff', 'Safe to print or share: the app asks for the password.')}
      />

      <div>
        <div className="u-row u-between u-gap-2 u-mb-1h">
          <span className="u-text-xs u-semibold u-upper u-fg-muted">{t('mobileSetup.json', 'Account JSON')}</span>
          <span className="u-row u-gap-1h">
            <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
              {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
              {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
            </button>
            {qr && (
              <a className="btn btn-ghost btn-sm" href={qr} download={`medut-${setup.extension}.png`}>
                <Download size={14} /> {t('mobileSetup.download', 'PNG')}
              </a>
            )}
          </span>
        </div>
        <pre className="crmx-json acct-qr-json">{json}</pre>
        <a href={ACCOUNT_FORMAT_URL} target="_blank" rel="noopener noreferrer" className="acct-link u-text-sm u-mt-1h">
          {t('mobileSetup.formatLink', 'Account format reference')} <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
