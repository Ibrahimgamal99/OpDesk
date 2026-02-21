import { useState, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { Login } from './components/Login'
import { getToken, removeToken } from './auth'
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

  if (!token) {
    return <Login onSuccess={onLoginSuccess} />
  }

  return <App onLogout={onLogout} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <Root />
)

