import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { getToken, setUser, getUser, isFilteredScope, getMonitorModesLabel } from './auth';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { ActiveCallsPanel } from './components/ActiveCallsPanel';
import { QueuesPanel } from './components/QueuesPanel';
import { CallLogPanel } from './components/CallLogPanel';
import { UsersPanel } from './components/UsersPanel';
import { SupervisorModal } from './components/SupervisorModal';
import { CRMSettingsModal } from './components/CRMSettingsModal';
import { 
  Phone, 
  PhoneCall, 
  Users, 
  Radio,
  Activity,
  Wifi,
  WifiOff,
  RefreshCw,
  Settings,
  History,
  LogOut,
  UserCog,
  Monitor
} from 'lucide-react';

type TabType = 'extensions' | 'calls' | 'queues' | 'call-log' | 'users';

type AppProps = { onLogout: () => void };

function App({ onLogout }: AppProps) {
  const token = getToken();
  const { state, connected, lastUpdate, notifications, sendAction } = useWebSocket(token, {
    onAuthFailure: onLogout,
  });
  const [activeTab, setActiveTab] = useState<TabType>('extensions');
  const [supervisorModal, setSupervisorModal] = useState<{
    isOpen: boolean;
    mode: 'listen' | 'whisper' | 'barge';
    target: string;
  }>({ isOpen: false, mode: 'listen', target: '' });
  const [crmSettingsOpen, setCrmSettingsOpen] = useState(false);

  // Refresh user (role, extension, scope) from server so scope is up to date
  useEffect(() => {
    if (!token) return;
    const ac = new AbortController();
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setUser(data); })
      .catch(() => {});
    return () => ac.abort();
  }, [token]);

  const handleSupervisorAction = useCallback((
    mode: 'listen' | 'whisper' | 'barge', 
    target: string
  ) => {
    setSupervisorModal({ isOpen: true, mode, target });
  }, []);

  const executeSupervisorAction = useCallback((supervisor: string) => {
    sendAction({
      action: supervisorModal.mode,
      supervisor,
      target: supervisorModal.target,
    });
    setSupervisorModal(prev => ({ ...prev, isOpen: false }));
  }, [sendAction, supervisorModal.mode, supervisorModal.target]);

  const stats = state?.stats || {
    total_extensions: 0,
    active_calls_count: 0,
    total_queues: 0,
    total_waiting: 0,
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-brand">
          <div className="header-logo">
            <Radio size={20} />
          </div>
          <div>
            <h1 className="header-title">OpDesk</h1>
            <p className="header-subtitle">Asterisk Real-time Monitor</p>
          </div>
        </div>

        <div className="header-status">
          <div className="stats-bar">
            <div className="stat-item">
              <Phone size={16} className="stat-icon" />
              <div>
                <div className="stat-value">{stats.total_extensions}</div>
                <div className="stat-label">Extensions</div>
              </div>
            </div>
            <div className="stat-item">
              <PhoneCall size={16} className="stat-icon" />
              <div>
                <div className="stat-value">{stats.active_calls_count}</div>
                <div className="stat-label">Active Calls</div>
              </div>
            </div>
            <div className="stat-item">
              <Users size={16} className="stat-icon" />
              <div>
                <div className="stat-value">{stats.total_waiting}</div>
                <div className="stat-label">Waiting</div>
              </div>
            </div>
          </div>

          <span
            className="header-monitor-mode"
            title={`Monitor: ${getMonitorModesLabel(getUser()?.monitor_modes)}`}
          >
            <Monitor size={16} className="header-monitor-icon" />
            <span className="header-monitor-label">{getMonitorModesLabel(getUser()?.monitor_modes)}</span>
          </span>

          <button 
            className="btn" 
            onClick={() => sendAction({ action: 'sync' })}
            title="Sync all data"
          >
            <RefreshCw size={14} />
            Sync
          </button>

          <button 
            className="btn" 
            onClick={() => setCrmSettingsOpen(true)}
            title="CRM Settings"
          >
            <Settings size={14} />
          </button>

          <button 
            className="btn" 
            onClick={onLogout}
            title="Sign out"
          >
            <LogOut size={14} />
            Logout
          </button>

          <div className="connection-status">
            <div className={`connection-dot ${connected ? 'connected' : ''}`} />
            <span className="connection-text">
              {connected ? (
                <>
                  <Wifi size={14} style={{ marginRight: 6 }} />
                  Connected
                </>
              ) : (
                <>
                  <WifiOff size={14} style={{ marginRight: 6 }} />
                  Disconnected
                </>
              )}
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="main-content">
        {/* Tabs */}
        <div className="tabs">
          <button 
            className={`tab ${activeTab === 'extensions' ? 'active' : ''}`}
            onClick={() => setActiveTab('extensions')}
          >
            <Phone size={16} />
            Extensions
          </button>
          <button 
            className={`tab ${activeTab === 'calls' ? 'active' : ''}`}
            onClick={() => setActiveTab('calls')}
          >
            <PhoneCall size={16} />
            Active Calls
            {stats.active_calls_count > 0 && (
              <span style={{ 
                background: 'var(--status-call)',
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 11,
                marginLeft: 4,
              }}>
                {stats.active_calls_count}
              </span>
            )}
          </button>
          <button 
            className={`tab ${activeTab === 'queues' ? 'active' : ''}`}
            onClick={() => setActiveTab('queues')}
          >
            <Users size={16} />
            Queues
            {stats.total_waiting > 0 && (
              <span style={{ 
                background: 'var(--status-ringing)',
                padding: '2px 8px',
                borderRadius: 10,
                fontSize: 11,
                marginLeft: 4,
              }}>
                {stats.total_waiting}
              </span>
            )}
          </button>
          <button 
            className={`tab ${activeTab === 'call-log' ? 'active' : ''}`}
            onClick={() => setActiveTab('call-log')}
          >
            <History size={16} />
            Call History
          </button>
          {getUser()?.role === 'admin' && (
            <button 
              className={`tab ${activeTab === 'users' ? 'active' : ''}`}
              onClick={() => setActiveTab('users')}
            >
              <UserCog size={16} />
              Users
            </button>
          )}
        </div>

        {/* Tab Content */}
        {activeTab === 'extensions' && (
          <ExtensionsPanel 
            extensions={state?.extensions || {}}
            onSupervisorAction={handleSupervisorAction}
          />
        )}

        {activeTab === 'calls' && (
          <ActiveCallsPanel 
            calls={state?.active_calls || {}}
            onSupervisorAction={handleSupervisorAction}
          />
        )}

        {activeTab === 'queues' && (
          <QueuesPanel 
            queues={state?.queues || {}}
            members={state?.queue_members || {}}
            entries={state?.queue_entries || {}}
            sendAction={sendAction}
          />
        )}

        {activeTab === 'call-log' && (
          <CallLogPanel />
        )}

        {activeTab === 'users' && (
          <UsersPanel />
        )}

        {/* Last update timestamp */}
        {lastUpdate && (
          <div style={{ 
            textAlign: 'center', 
            fontSize: 12, 
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}>
            <Activity size={12} />
            Last update: {lastUpdate.toLocaleTimeString()}
          </div>
        )}
      </main>

      {/* Supervisor Modal */}
      {supervisorModal.isOpen && (
        <SupervisorModal
          mode={supervisorModal.mode}
          target={supervisorModal.target}
          onClose={() => setSupervisorModal(prev => ({ ...prev, isOpen: false }))}
          onSubmit={executeSupervisorAction}
        />
      )}

      {/* CRM Settings Modal */}
      <CRMSettingsModal
        isOpen={crmSettingsOpen}
        onClose={() => setCrmSettingsOpen(false)}
      />

      {/* Notifications */}
      <div className="notifications">
        {notifications.map((notification, index) => (
          <div key={index} className="notification">
            {notification}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;

