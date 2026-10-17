import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, Loader2, AlertCircle, Copy, ClipboardCheck, Download, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal';
import { Toggle } from './ui/Toggle';
import { api, toApiError } from '../lib/api';

export const MEDUT_REPO_URL = 'https://github.com/Ibrahimgamal99/medut-softphone';
const ACCOUNT_FORMAT_URL = `${MEDUT_REPO_URL}/blob/main/docs/account-setup.md`;

interface MobileSetup {
  extension: string;
  display_name: string;
  password: string;
  host: string;
  verify_tls: boolean;
}

/**
 * The Medut account JSON (medut-softphone docs/account-setup.md) with no transport:
 * the app then signs in on "Auto", trying TLS, TCP, UDP and secure WebSocket at once
 * and keeping the first that registers. The text must not contain the word
 * "transport" anywhere, or the app stops auto-detecting.
 */
export function buildMedutAccount(s: MobileSetup, includePassword: boolean): Record<string, unknown> {
  const account: Record<string, unknown> = { name: `OpDesk ${s.extension}`, uri: `${s.extension}@${s.host}` };
  if (includePassword && s.password) account.password = s.password;
  if (s.display_name) account.display_name = s.display_name;
  // Without a public certificate (self-signed), TLS and WSS would fail the app's check.
  if (!s.verify_tls) account.verify_tls = false;
  return account;
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

  useEffect(() => {
    let cancelled = false;
    api<MobileSetup>(userId != null ? `/api/settings/users/${userId}/mobile-setup` : '/api/mobile-setup')
      .then((data) => { if (!cancelled) setSetup(data); })
      .catch((e) => { if (!cancelled) setError(toApiError(e).message); });
    return () => { cancelled = true; };
  }, [userId]);

  const account = useMemo(() => (setup ? buildMedutAccount(setup, includePassword) : null), [setup, includePassword]);
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
    return <div className="up-alert error"><AlertCircle size={18} /><span>{error}</span></div>;
  }
  if (!setup) {
    return <div className="mw-qr-loading"><Loader2 size={20} className="spinner" /></div>;
  }

  return (
    <div className="mw-qr">
      <p className="up-hint mw-qr-intro">
        {t('mobileSetup.introAuto', 'Scan this code in Medut Softphone (sign-in screen → Scan QR) to add extension {{ext}}. The app finds the best connection by itself.', { ext: setup.extension })}{' '}
        <a href={MEDUT_REPO_URL} target="_blank" rel="noopener noreferrer" className="mw-link">
          {t('mobileSetup.getApp', 'Get Medut Softphone')} <ExternalLink size={12} />
        </a>
      </p>

      <div className="mw-qr-code mw-qr-code-center">
        {qr ? <img src={qr} alt={t('mobileSetup.qrAlt', 'Account QR code')} /> : <Loader2 size={20} className="spinner" />}
      </div>

      <div className="mw-qr-options">
        <Toggle
          checked={includePassword}
          onChange={setIncludePassword}
          label={t('mobileSetup.includePassword', 'Include the password')}
          description={includePassword
            ? t('mobileSetup.passwordOn', 'One scan signs in. Treat the code like the password itself.')
            : t('mobileSetup.passwordOff', 'Safe to print or share: the app asks for the password.')}
        />
      </div>

      <div className="mw-qr-json">
        <div className="mw-qr-json-head">
          <span>{t('mobileSetup.json', 'Account JSON')}</span>
          <span className="mw-qr-json-actions">
            <button type="button" className="btn" onClick={copy}>
              {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
              {copied ? t('mobileSetup.copied', 'Copied') : t('mobileSetup.copy', 'Copy')}
            </button>
            {qr && (
              <a className="btn" href={qr} download={`medut-${setup.extension}.png`}>
                <Download size={14} /> {t('mobileSetup.download', 'PNG')}
              </a>
            )}
          </span>
        </div>
        <pre>{json}</pre>
        <span className="up-hint">
          <a href={ACCOUNT_FORMAT_URL} target="_blank" rel="noopener noreferrer" className="mw-link">
            {t('mobileSetup.formatLink', 'Account format reference')} <ExternalLink size={12} />
          </a>
        </span>
      </div>
    </div>
  );
}
