import { useState, FormEvent } from 'react';
import { Radio, LogIn, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setToken, setUser } from '../auth';
import { messageFrom } from '../lib/api';
import { Alert, Card, FormField, FormRow } from './ui';

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
        setError(messageFrom(data, t('login.errorInvalid')));
        return;
      }
      if (data.access_token) {
        setToken(data.access_token);
        if (data.user) setUser(data.user);
        onSuccess();
      } else {
        setError(t('login.errorInvalidResponse'));
      }
    } catch {
      setError(t('login.errorNetwork'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <Card
        className="login-panel"
        icon={Radio}
        title={t('app.title')}
        description={t('login.subtitle')}
      >
        <form onSubmit={handleSubmit} noValidate>
          <FormRow single>
            <FormField label={t('login.extensionLabel')} htmlFor="login-user">
              <input
                id="login-user"
                type="text"
                className="form-input"
                placeholder={t('login.extensionPlaceholder')}
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                autoFocus
                disabled={loading}
              />
            </FormField>
          </FormRow>
          <FormRow single>
            <FormField label={t('fields.password')} htmlFor="login-password">
              <input
                id="login-password"
                type="password"
                className="form-input"
                placeholder={t('fields.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading}
              />
            </FormField>
          </FormRow>

          <Alert className="u-mb-4">{error}</Alert>

          <button type="submit" className="btn btn-primary u-w-full" disabled={loading}>
            {loading ? (
              <>
                <Loader2 size={14} className="spinner" />
                {t('login.signingIn')}
              </>
            ) : (
              <>
                <LogIn size={14} />
                {t('login.signIn')}
              </>
            )}
          </button>
        </form>
      </Card>
    </div>
  );
}
