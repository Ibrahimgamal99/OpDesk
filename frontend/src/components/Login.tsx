import { useState, FormEvent } from 'react';
import { Radio, LogIn } from 'lucide-react';
import { setToken, setUser } from '../auth';

type Props = {
  onSuccess: () => void;
};

export function Login({ onSuccess }: Props) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!login.trim() || !password) {
      setError('Enter extension/username and password');
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
        setError(data.detail || 'Invalid extension/username or password');
        return;
      }
      if (data.access_token) {
        setToken(data.access_token);
        if (data.user) setUser(data.user);
        onSuccess();
      } else {
        setError('Invalid response from server');
      }
    } catch (err) {
      setError('Network error. Please try again.');
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
          <h1 className="login-title">OpDesk</h1>
          <p className="login-subtitle">Asterisk Operator Panel</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-label">Extension or username</label>
          <input
            type="text"
            className="login-input"
            placeholder="e.g. 1001 or admin"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
            autoFocus
            disabled={loading}
          />

          <label className="login-label">Password</label>
          <input
            type="password"
            className="login-input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={loading}
          />

          {error && <div className="login-error">{error}</div>}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? (
              <span className="login-spinner">Signing in…</span>
            ) : (
              <>
                <LogIn size={18} />
                Sign in
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
