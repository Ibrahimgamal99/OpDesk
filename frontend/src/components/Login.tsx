import { useState, FormEvent } from 'react';
import { Radio, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setToken, setUser } from '../auth';

type Props = {
  onSuccess: () => void;
};

export function Login({ onSuccess }: Props) {
  const { t } = useTranslation();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!login.trim() || !password) {
      setError(t('login.errorEmpty'));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || t('login.errorInvalid'));
        return;
      }
      if (data.access_token) {
        setToken(data.access_token);
        if (data.user) setUser(data.user);
        onSuccess();
      } else {
        setError(t('login.errorInvalidResponse'));
      }
    } catch (err) {
      setError(t('login.errorNetwork'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-logo">
            <Radio size={32} />
          </div>
          <h1 className="login-title">{t('login.title')}</h1>
          <p className="login-subtitle">{t('login.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-label">{t('login.extensionLabel')}</label>
          <input
            type="text"
            className="login-input"
            placeholder={t('login.extensionPlaceholder')}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
            autoFocus
            disabled={loading}
          />

          <label className="login-label">{t('login.passwordLabel')}</label>
          <input
            type="password"
            className="login-input"
            placeholder={t('login.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={loading}
          />

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? (
              <span className="login-spinner">{t('login.signingIn')}</span>
            ) : (
              <>
                <LogIn size={18} />
                {t('login.signIn')}
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
