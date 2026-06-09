import { useState, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Login } from './components/Login'
import { getToken, removeToken } from './auth'
import { rlog } from './lib/remoteLog'
import './i18n'
import './styles/index.css'

function Root() {
  const [token, setTokenState] = useState<string | null>(() => getToken())

  const onLoginSuccess = useCallback(() => {
    setTokenState(getToken())
  }, [])

  const onLogout = useCallback(() => {
    removeToken()
    setTokenState(null)
  }, [])

  useEffect(() => {
    const handler = () => setTokenState(null);
    window.addEventListener('opdesk:unauthorized', handler);
    return () => window.removeEventListener('opdesk:unauthorized', handler);
  }, [])

  if (!token) {
    return <Login onSuccess={onLoginSuccess} />
  }

  return <App onLogout={onLogout} />
}

// Register the service worker so incoming-call notifications can be shown while the
// tab is backgrounded (showNotification requires an active registration). Best-effort:
// a failure here must never block the app.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => rlog('sw', `registered scope=${reg.scope}`))
      .catch((e) => rlog('sw', `register failed: ${String(e)}`));
  });
} else {
  rlog('sw', 'serviceWorker not supported');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <Root />
)

