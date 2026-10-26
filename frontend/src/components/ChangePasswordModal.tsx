import { useState, type FormEvent } from 'react';
import { KeyRound, Phone, Loader2, Eye, EyeOff, Wand2, QrCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, FormField, FormRow, Modal } from './ui';
import { api, toApiError } from '../lib/api';
import '../styles/account.css';

export type PasswordKind = 'login' | 'sip';

/** 16 characters from letters and digits: always passes the server's SIP rule. */
export function generateSipPassword(): string {
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
      title={sip ? t('account.sipPassword', 'Change SIP password') : t('common.changePassword', 'Change password')}
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
  // Distinct ids per kind: My Profile renders both forms on one page.
  const idp = sip ? 'acct-sip' : 'acct-login';

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
      <div className="u-col u-gap-3">
        <Alert tone="success">{done}</Alert>
        {sip && onShowQr && (
          <button type="button" className="btn btn-primary u-w-full" onClick={onShowQr}>
            <QrCode size={14} /> {t('account.showNewQr', 'Show the new mobile QR')}
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="acct-form">
      {sip && (
        <Alert tone="info" className="u-mb-4">
          {t('account.sipNote', 'Every phone and softphone on your extension signs out and has to sign in again with the new password (scan the new QR).')}
        </Alert>
      )}
      <FormRow single>
        <FormField
          label={t('account.current', 'Current OpDesk password')}
          htmlFor={`${idp}-current`}
          hint={sip ? t('account.currentSipHint', 'Your sign-in password, to confirm it is you.') : undefined}
          required
        >
          <input id={`${idp}-current`} className="form-input" type="password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </FormField>
      </FormRow>
      <FormRow single>
        <FormField
          label={sip ? t('account.newSip', 'New SIP password') : t('account.new', 'New password')}
          htmlFor={`${idp}-new`}
          hint={sip
            ? t('account.sipRule', '8 to 64 characters, letters and digits, no spaces or quotes.')
            : t('account.loginRule', 'At least 8 characters.')}
          required
        >
          <div className="acct-input-row">
            <input id={`${idp}-new`} className="form-input" type={show ? 'text' : 'password'} autoComplete="new-password"
              value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />
            <button type="button" className="btn btn-icon" onClick={() => setShow((s) => !s)}
              title={show ? t('account.hide', 'Hide') : t('account.show', 'Show')}
              aria-label={show ? t('account.hide', 'Hide') : t('account.show', 'Show')}
              aria-pressed={show}>
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            {sip && (
              <button type="button" className="btn btn-icon"
                title={t('account.generate', 'Generate')} aria-label={t('account.generate', 'Generate')}
                onClick={() => { const p = generateSipPassword(); setNext(p); setConfirm(p); setShow(true); }}>
                <Wand2 size={14} />
              </button>
            )}
          </div>
        </FormField>
      </FormRow>
      <FormRow single>
        <FormField label={t('account.confirm', 'Confirm new password')} htmlFor={`${idp}-confirm`} required>
          <input id={`${idp}-confirm`} className="form-input" type={show ? 'text' : 'password'} autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required aria-invalid={mismatch || undefined} />
          {mismatch && (
            <Alert variant="inline" className="u-mt-1h">{t('account.mismatch', 'The passwords do not match.')}</Alert>
          )}
        </FormField>
      </FormRow>
      <Alert className="u-mb-4">{error}</Alert>
      <div className="u-row u-justify-end">
        <button type="submit" className="btn btn-primary" disabled={saving || !current || !next || next !== confirm}>
          {saving ? <Loader2 size={14} className="spinner" /> : <KeyRound size={14} />}
          {saving ? t('common.saving', 'Saving…') : t('common.changePassword', 'Change password')}
        </button>
      </div>
    </form>
  );
}
