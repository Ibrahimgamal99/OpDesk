import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserCircle, Globe, KeyRound, Phone, QrCode, User } from 'lucide-react';
import { getUser } from '../auth';
import { setLanguage } from '../i18n';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import { Card, Dropdown, Page } from './ui';
import { PasswordForm } from './ChangePasswordModal';
import { MobileSetupBody } from './MobileSetupQR';
import '../styles/account.css';

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
  // A regional tag such as en-US still selects its base language.
  const currentLang = LANGUAGE_OPTIONS.find((l) => i18n.language === l || i18n.language?.startsWith(`${l}-`)) ?? i18n.language;

  const facts: { key: string; label: string; value: string }[] = [
    { key: 'name', label: t('fields.name', 'Name'), value: user?.name || '—' },
    { key: 'username', label: t('fields.username', 'Username'), value: user?.username || '—' },
    { key: 'role', label: t('fields.role', 'Role'), value: t(`users.roles.${user?.role}`, { defaultValue: user?.role || '—' }) },
    { key: 'ext', label: t('header.ext'), value: user?.extension || '—' },
  ];

  return (
    <Page icon={UserCircle} title={t('profile.title', 'My Profile')}>
      <div className="acct-profile-grid">
        <div className="acct-profile-col">
          <Card icon={User} title={t('common.account', 'Account')} description={t('profile.accountDesc', 'Your sign-in details.')}>
            <div className="crmx-meta acct-facts">
              {facts.map((f) => (
                <div className="crmx-meta-cell" key={f.key}>
                  <span className="crmx-meta-k">{f.label}</span>
                  <span className="crmx-meta-v" title={f.value}>{f.value}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            icon={Globe}
            title={t('language.select')}
            description={t('profile.languageDesc', 'The language OpDesk is shown in on this browser.')}
          >
            <Dropdown
              size="md"
              value={currentLang}
              onChange={(lang) => setLanguage(lang)}
              ariaLabel={t('language.select')}
              icon={Globe}
              options={LANGUAGE_OPTIONS.map((lang) => ({ value: lang, label: t(`language.${lang}`) }))}
            />
          </Card>

          <Card
            icon={KeyRound}
            title={t('common.changePassword', 'Change password')}
            description={t('profile.passwordDesc', 'The password you sign in to OpDesk with.')}
          >
            <PasswordForm sip={false} />
          </Card>

          {hasExt && (
            <Card
              icon={Phone}
              title={t('account.sipPassword', 'Change SIP password')}
              description={t('profile.sipDesc', 'The password your phones and softphones register with.')}
            >
              <PasswordForm
                sip
                onSipChanged={() => { void refetchConfig(); setQrKey((k) => k + 1); }}
                onShowQr={() => qrRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
            </Card>
          )}
        </div>

        {hasExt && (
          <div className="acct-profile-col" ref={qrRef}>
            <Card
              icon={QrCode}
              title={t('mobileSetup.title', 'Set up the mobile app')}
              description={t('profile.qrDesc', 'Scan with Medut Softphone to add your extension.')}
            >
              <MobileSetupBody key={qrKey} />
            </Card>
          </div>
        )}
      </div>
    </Page>
  );
}
