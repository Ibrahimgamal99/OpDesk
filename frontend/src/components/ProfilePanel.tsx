import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserCircle, Globe, KeyRound, Phone, QrCode, User } from 'lucide-react';
import { getUser } from '../auth';
import { setLanguage } from '../i18n';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import { Page } from './ui';
import { PasswordForm } from './ChangePasswordModal';
import { MobileSetupBody } from './MobileSetupQR';

const LANGUAGE_OPTIONS = ['en', 'ar', 'es', 'pt', 'uk'] as const;

/**
 * My Profile — the current user's own account in one place: who they are, the UI
 * language, their sign-in password and, when they have an extension, their SIP
 * password and the mobile-app QR. Opened from the header profile dropdown.
 */
export function ProfilePanel() {
  const { t, i18n } = useTranslation();
  const { refetchConfig } = useWebPhoneContext();
  const user = getUser();
  const hasExt = !!user?.extension;
  // Bumped after a SIP password change so the QR re-reads the new credentials.
  const [qrKey, setQrKey] = useState(0);
  const qrRef = useRef<HTMLDivElement>(null);

  const section = (Icon: typeof User, title: string, desc: string) => (
    <div className="settings-section-header">
      <div className="settings-section-icon"><Icon size={20} /></div>
      <div>
        <div className="settings-section-title">{title}</div>
        <div className="settings-section-desc">{desc}</div>
      </div>
    </div>
  );

  return (
    <Page icon={<UserCircle />} title={t('profile.title', 'My Profile')}>
      <div className="profile-grid">
        <div className="profile-col">
          <div className="settings-section">
            {section(User, t('profile.account', 'Account'), t('profile.accountDesc', 'Your sign-in details.'))}
            <dl className="profile-facts">
              <dt>{t('profile.name', 'Name')}</dt>
              <dd>{user?.name || '—'}</dd>
              <dt>{t('profile.username', 'Username')}</dt>
              <dd>{user?.username || '—'}</dd>
              <dt>{t('profile.role', 'Role')}</dt>
              <dd>{t(`users.roles.${user?.role}`, { defaultValue: user?.role || '—' })}</dd>
              <dt>{t('header.ext')}</dt>
              <dd>{user?.extension || '—'}</dd>
            </dl>
          </div>

          <div className="settings-section">
            {section(Globe, t('language.select'), t('profile.languageDesc', 'The language OpDesk is shown in on this browser.'))}
            <div className="header-profile-segmented profile-lang" role="group" aria-label={t('language.select')}>
              {LANGUAGE_OPTIONS.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setLanguage(lang)}
                  className={`header-profile-seg${i18n.language === lang ? ' active' : ''}`}
                  aria-pressed={i18n.language === lang}
                >
                  {t(`language.${lang}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            {section(KeyRound, t('account.loginPassword', 'Change password'), t('profile.passwordDesc', 'The password you sign in to OpDesk with.'))}
            <PasswordForm sip={false} />
          </div>

          {hasExt && (
            <div className="settings-section">
              {section(Phone, t('account.sipPassword', 'Change SIP password'), t('profile.sipDesc', 'The password your phones and softphones register with.'))}
              <PasswordForm
                sip
                onSipChanged={() => { void refetchConfig(); setQrKey((k) => k + 1); }}
                onShowQr={() => qrRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
            </div>
          )}
        </div>

        {hasExt && (
          <div className="profile-col">
            <div className="settings-section" ref={qrRef}>
              {section(QrCode, t('mobileSetup.title', 'Set up the mobile app'), t('profile.qrDesc', 'Scan with Medut Softphone to add your extension.'))}
              <MobileSetupBody key={qrKey} />
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
