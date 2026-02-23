import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { getToken, setUser, getUser, isFilteredScope, getMonitorModesLabel } from './auth';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { ActiveCallsPanel } from './components/ActiveCallsPanel';
import { QueuesPanel } from './components/QueuesPanel';
import { CallLogPanel } from './components/CallLogPanel';
import { UsersPanel } from './components/UsersPanel';
import { GroupsPanel } from './components/GroupsPanel';
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
  Settings,
  History,
  LogOut,
  UserCog,
  Monitor,
  Group,
  KeyRound,
  X,
  Save,
  Loader2,
} from 'lucide-react';
import { getAuthHeaders } from './auth';

type TabType = 'extensions' | 'calls' | 'queues' | 'call-log' | 'groups' | 'users';

/** Snapshot of user form when opening "Create new group" from Users tab (preserved in memory, no API). */
export interface PendingUserFormSnapshot {
  username: string;
  password: string;
  name: string;
  extension: string;
  role: 'admin' | 'supervisor' | 'agent';
  monitor_modes: string[];
  group_ids: string[];
}

type AppProps = { onLogout: () => void };

function App({ onLogout }: AppProps) {
  const token = getToken();
  const { state, connected, lastUpdate, notifications, sendAction } = useWebSocket(token, {
    onAuthFailure: onLogout,
  });
  const [activeTab, setActiveTab] = useState<TabType>('extensions');
  /** User form preserved when switching to Groups to create a new group (no API call). */
  const [pendingUserForm, setPendingUserForm] = useState<PendingUserFormSnapshot | null>(null);
  /** When set, Groups tab opens create form with this name pre-filled; consumed after applied. */
  const [groupsTabIntent, setGroupsTabIntent] = useState<{ prefillGroupName: string } | null>(null);
  const [supervisorModal, setSupervisorModal] = useState<{
    isOpen: boolean;
    mode: 'listen' | 'whisper' | 'barge';
    target: string;
  }>({ isOpen: false, mode: 'listen', target: '' });
  const [crmSettingsOpen, setCrmSettingsOpen] = useState(false);
  const [extensionSecretOpen, setExtensionSecretOpen] = useState(false);
  const [extensionSecretValue, setExtensionSecretValue] = useState('');
  const [extensionSecretSaving, setExtensionSecretSaving] = useState(false);
  const [extensionSecretMessage, setExtensionSecretMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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

  // Agent only has Extensions, Active Calls, Call History; switch away from other tabs
  const userRole = getUser()?.role;
  useEffect(() => {
    if (userRole === 'agent' && !['extensions', 'calls', 'call-log'].includes(activeTab)) {
      setActiveTab('extensions');
    }
  }, [userRole, activeTab]);

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

  const saveExtensionSecret = useCallback(async () => {
    setExtensionSecretSaving(true);
    setExtensionSecretMessage(null);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ extension_secret: extensionSecretValue }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setExtensionSecretMessage({ type: 'success', text: data.message || 'Extension secret saved' });
        setExtensionSecretValue('');
        setTimeout(() => setExtensionSecretOpen(false), 1200);
      } else {
        setExtensionSecretMessage({ type: 'error', text: data.detail || 'Failed to save' });
      }
    } catch (e) {
      setExtensionSecretMessage({ type: 'error', text: 'Failed to save extension secret' });
    } finally {
      setExtensionSecretSaving(false);
    }
  }, [extensionSecretValue]);

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

          {getUser()?.role !== 'agent' && (
            <span
              className="header-monitor-mode"
              title={`Monitor: ${getMonitorModesLabel(getUser()?.monitor_modes)}`}
            >
              <Monitor size={16} className="header-monitor-icon" />
              <span className="header-monitor-label">{getMonitorModesLabel(getUser()?.monitor_modes)}</span>
            </span>
          )}

          <div className={`connection-status ${connected ? 'connected' : ''}`}>
            <span className="connection-icon" aria-hidden>
              {connected ? (
                <Wifi size={16} />
              ) : (
                <WifiOff size={16} />
              )}
            </span>
            <span className="connection-text">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {getUser()?.role === 'admin' && (
            <button 
              className="btn" 
              onClick={() => setCrmSettingsOpen(true)}
              title="CRM Settings"
            >
              <Settings size={14} />
            </button>
          )}

          <button 
            className="btn" 
            onClick={onLogout}
            title="Sign out"
          >
            <LogOut size={14} />
            Logout
          </button>
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
            type="button"
            className="btn btn-tab-icon"
            onClick={() => { setExtensionSecretMessage(null); setExtensionSecretValue(''); setExtensionSecretOpen(true); }}
            title="Extension secret (WebRTC)"
            aria-label="Set extension secret"
          >
            <KeyRound size={16} />
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
          {getUser()?.role !== 'agent' && (
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
          )}
          <button 
            className={`tab ${activeTab === 'call-log' ? 'active' : ''}`}
            onClick={() => setActiveTab('call-log')}
          >
            <History size={16} />
            Call History
          </button>
          {getUser()?.role === 'admin' && (
            <>
              <button 
                className={`tab ${activeTab === 'groups' ? 'active' : ''}`}
                onClick={() => setActiveTab('groups')}
              >
                <Group size={16} />
                Groups
              </button>
              <button 
                className={`tab ${activeTab === 'users' ? 'active' : ''}`}
                onClick={() => setActiveTab('users')}
              >
                <UserCog size={16} />
                Users
              </button>
            </>
          )}
        </div>

        {/* Tab Content */}
        {activeTab === 'extensions' && (
          <ExtensionsPanel 
            extensions={state?.extensions || {}}
            onSupervisorAction={handleSupervisorAction}
            onSync={() => sendAction({ action: 'sync' })}
          />
        )}

        {activeTab === 'calls' && (
          <ActiveCallsPanel 
            calls={state?.active_calls || {}}
            onSupervisorAction={handleSupervisorAction}
            onSync={() => sendAction({ action: 'sync' })}
          />
        )}

        {activeTab === 'queues' && (
          <QueuesPanel 
            queues={state?.queues || {}}
            members={state?.queue_members || {}}
            entries={state?.queue_entries || {}}
            sendAction={sendAction}
            onSync={() => sendAction({ action: 'sync' })}
          />
        )}

        {activeTab === 'call-log' && (
          <CallLogPanel />
        )}

        {activeTab === 'groups' && (
          <GroupsPanel
            initialGroupName={groupsTabIntent?.prefillGroupName ?? undefined}
            onConsumeIntent={groupsTabIntent ? () => setGroupsTabIntent(null) : undefined}
          />
        )}

        {activeTab === 'users' && (
          <UsersPanel
            pendingUserForm={pendingUserForm}
            onClearPendingUserForm={() => setPendingUserForm(null)}
            onOpenCreateGroup={(formSnapshot: PendingUserFormSnapshot, prefillGroupName?: string) => {
              setPendingUserForm(formSnapshot);
              setGroupsTabIntent({ prefillGroupName: prefillGroupName ?? '' });
              setActiveTab('groups');
            }}
          />
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

      {/* Extension secret modal */}
      {extensionSecretOpen && (
        <div className="modal-overlay" onClick={() => setExtensionSecretOpen(false)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <KeyRound size={20} style={{ color: 'var(--accent-primary)' }} />
                Extension secret
              </h3>
              <button type="button" className="modal-close" onClick={() => setExtensionSecretOpen(false)} aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div style={{ padding: 16 }}>
              <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 12 }}>
                Set the secret for your extension (used for WebRTC registration). Stored in your user account.
              </p>
              <div className="form-group">
                <label className="form-label">Extension secret</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Your extension secret"
                  value={extensionSecretValue}
                  onChange={(e) => setExtensionSecretValue(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {extensionSecretMessage && (
                <div className={`settings-alert ${extensionSecretMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 12 }}>
                  {extensionSecretMessage.text}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => setExtensionSecretOpen(false)} disabled={extensionSecretSaving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={saveExtensionSecret}
                disabled={extensionSecretSaving}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {extensionSecretSaving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                {extensionSecretSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

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

