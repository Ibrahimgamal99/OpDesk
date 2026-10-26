import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, Loader2, Copy, ClipboardCheck, Download, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, Loading, Modal, Toggle } from './ui';
import { api, toApiError } from '../lib/api';
import '../styles/account.css';

export const MEDUT_REPO_URL = 'https://github.com/Ibrahimgamal99/medut-softphone';
const ACCOUNT_FORMAT_URL = `${MEDUT_REPO_URL}/blob/main/docs/account-setup.md`;

interface MobileSetup {
  extension: string;
  display_name: string;
  password: string;
  host: string;
  verify_tls: boolean;
  /** The full Medut account JSON, built by the server from the extension's PBX settings. */
  account: Record<string, unknown>;
}

/**
 * The Medut account JSON (medut-softphone docs/account-setup.md) as the server built it:
 * transport, web link, media encryption, ICE, STUN/TURN and the certificate check all
 * written, so the phone connects the way the extension accepts calls instead of "Auto"
 * keeping whichever transport registers first. Without the password, the app asks for it.
 */
export function buildMedutAccount(s: MobileSetup, includePassword: boolean): Record<string, unknown> {
  const account = { ...s.account };
  if (!includePassword || !account.password) delete account.password;
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
