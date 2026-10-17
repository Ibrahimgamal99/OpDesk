import { useState, type FormEvent } from 'react';
import { KeyRound, Phone, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff, Wand2, QrCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal';
import { FormField } from './ui/Form';
import { api, toApiError } from '../lib/api';

export type PasswordKind = 'login' | 'sip';

/** 16 characters from letters and digits: always passes the server's SIP rule. */
function generateSipPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  if (!/\d/.test(out)) out = out.slice(0, -1) + '7';
  if (!/[A-Za-z]/.test(out)) out = 'k' + out.slice(1);
  return out;
}

interface Props {
  kind: PasswordKind | null;
  onClose: () => void;
  /** After a SIP password change: the web softphone re-reads its credentials. */
  onSipChanged?: () => void;
  /** After a SIP password change: open the new mobile QR. */
  onShowQr?: () => void;
}

export function ChangePasswordModal({ kind, onClose, onSipChanged, onShowQr }: Props) {
  const { t } = useTranslation();
  const sip = kind === 'sip';
  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      width="sm"
      icon={sip ? <Phone size={18} /> : <KeyRound size={18} />}
      title={sip ? t('account.sipPassword', 'Change SIP password') : t('account.loginPassword', 'Change password')}
    >
      {kind && <PasswordForm key={kind} sip={sip} onSipChanged={onSipChanged} onShowQr={onShowQr} />}
    </Modal>
  );
}

/** The change-password form on its own, for the modal and the My Profile page. */
export function PasswordForm({ sip, onSipChanged, onShowQr }: { sip: boolean; onSipChanged?: () => void; onShowQr?: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mismatch = confirm !== '' && confirm !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ message: string }>(sip ? '/api/me/sip-password' : '/api/me/password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      });
      setDone(res.message);
      if (sip) onSipChanged?.();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div>
        <div className="up-alert success"><CheckCircle2 size={18} /><span>{done}</span></div>
        {sip && onShowQr && (
          <button type="button" className="btn btn-primary acct-wide-btn" onClick={onShowQr}>
            <QrCode size={14} /> {t('account.showNewQr', 'Show the new mobile QR')}
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="acct-form">
      {sip && (
        <p className="up-hint acct-note">
          {t('account.sipNote', 'Every phone and softphone on your extension signs out and has to sign in again with the new password (scan the new QR).')}
        </p>
      )}
      <FormField label={t('account.current', 'Current OpDesk password')} htmlFor="acct-current"
        hint={sip ? t('account.currentSipHint', 'Your sign-in password, to confirm it is you.') : undefined}>
        <input id="acct-current" className="form-input" type="password" autoComplete="current-password"
          value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </FormField>
      <FormField label={sip ? t('account.newSip', 'New SIP password') : t('account.new', 'New password')} htmlFor="acct-new"
        hint={sip
          ? t('account.sipRule', '8 to 64 characters, letters and digits, no spaces or quotes.')
          : t('account.loginRule', 'At least 8 characters.')}>
        <div className="acct-input-row">
          <input id="acct-new" className="form-input" type={show ? 'text' : 'password'} autoComplete="new-password"
            value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
          <button type="button" className="btn" onClick={() => setShow((s) => !s)}
            title={show ? t('account.hide', 'Hide') : t('account.show', 'Show')}>
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          {sip && (
            <button type="button" className="btn" title={t('account.generate', 'Generate')}
              onClick={() => { const p = generateSipPassword(); setNext(p); setConfirm(p); setShow(true); }}>
              <Wand2 size={14} />
            </button>
          )}
        </div>
      </FormField>
      <FormField label={t('account.confirm', 'Confirm new password')} htmlFor="acct-confirm"
        hint={mismatch ? t('account.mismatch', 'The passwords do not match.') : undefined}>
        <input id="acct-confirm" className="form-input" type={show ? 'text' : 'password'} autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </FormField>
      {error && <div className="up-alert error"><AlertCircle size={18} /><span>{error}</span></div>}
      <button type="submit" className="btn btn-primary acct-wide-btn" disabled={saving || !current || !next || next !== confirm}>
        {saving ? <Loader2 size={14} className="spinner" /> : <KeyRound size={14} />}
        {saving ? t('account.saving', 'Saving…') : t('account.save', 'Change password')}
      </button>
    </form>
  );
}
