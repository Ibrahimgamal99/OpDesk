import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebPhone } from './hooks/useWebPhone';
import { WebPhoneProvider } from './contexts/WebPhoneContext';
import { getToken, setUser, getUser, getMonitorModesLabel } from './auth';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { ActiveCallsPanel } from './components/ActiveCallsPanel';
import { QueuesPanel } from './components/QueuesPanel';
import { CallLogPanel } from './components/CallLogPanel';
import { UsersPanel } from './components/UsersPanel';
import { GroupsPanel } from './components/GroupsPanel';
import { SupervisorModal } from './components/SupervisorModal';
import { CRMSettingsModal } from './components/CRMSettingsModal';
import { Softphone } from './components/Softphone';
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
  Headphones,
} from 'lucide-react';
import { getAuthHeaders } from './auth';

type TabType = 'extensions' | 'calls' | 'queues' | 'call-log' | 'groups' | 'users' | 'phone';

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
  const webPhone = useWebPhone();
  const { connect, disconnect, canConnect, isConnected, configLoading, incomingCall } = webPhone;
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;

  // AudioContext must be created/resumed after a user gesture (Chrome autoplay policy).
  // Unlock on first user interaction so ringtone can play when an incoming call arrives.
  const audioContextRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    const unlock = () => {
      if (audioContextRef.current) return;
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioContextRef.current = ctx;
      if (ctx.state === 'suspended') ctx.resume();
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, []);

  const handleLogout = useCallback(() => {
    disconnectRef.current();
    onLogout();
  }, [onLogout]);

  const { state, connected, lastUpdate, notifications, sendAction } = useWebSocket(token, {
    onAuthFailure: handleLogout,
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

  // Auto-connect softphone when logged in and config is ready
  useEffect(() => {
    if (!canConnect || isConnected || configLoading) return;
    connect();
  }, [canConnect, isConnected, configLoading, connect]);

  // Disconnect SIP on tab close
  useEffect(() => {
    const onUnload = () => { disconnectRef.current(); };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, []);

  // Redirect to softphone and show browser notification when incoming call
  useEffect(() => {
    if (!incomingCall) return;
    setActiveTab('phone');
    let notification: Notification | null = null;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const title = 'Incoming call';
      const body = incomingCall.callerName
        ? `${incomingCall.callerName} (${incomingCall.callerNumber})`
        : incomingCall.callerNumber;
      notification = new Notification(title, {
        body,
        icon: '/favicon.ico',
        tag: 'opdesk-incoming-call',
        requireInteraction: true,
      });
      notification.onclick = () => {
        window.focus();
        notification?.close();
      };
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    return () => {
      notification?.close();
    };
  }, [incomingCall]);

  // Play ringtone when incoming call is ringing (uses AudioContext unlocked by user gesture)
  useEffect(() => {
    if (!incomingCall) return;
    const ctx = audioContextRef.current;
    if (!ctx) return; // No user gesture yet; ringtone would be blocked by autoplay policy
    let stopped = false;
    const playRing = () => {
      if (stopped) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const playTone = (freq: number, start: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.15, start);
        gain.gain.exponentialRampToValueAtTime(0.01, start + duration);
        osc.start(start);
        osc.stop(start + duration);
      };
      playTone(440, 0, 0.2);
      playTone(440, 0.2, 0.2);
      playTone(480, 0.5, 0.2);
      playTone(480, 0.7, 0.2);
    };
    const interval = setInterval(playRing, 2000);
    playRing();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [incomingCall]);

  // Agent only has Extensions, Active Calls, Call History, Softphone; switch away from other tabs
  const userRole = getUser()?.role;
  useEffect(() => {
    if (userRole === 'agent' && !['extensions', 'calls', 'call-log', 'phone'].includes(activeTab)) {
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

  const openSoftphone = useCallback(() => {
    setActiveTab('phone');
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  return (
    <WebPhoneProvider value={webPhone}>
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
            <button
              type="button"
              className={`header-softphone-btn ${isConnected ? 'registered' : 'not-registered'}`}
              onClick={openSoftphone}
              title={isConnected ? 'Softphone (registered)' : 'Softphone (not registered)'}
              aria-label="Open Softphone"
            >
              <Headphones size={18} />
              <span>Softphone</span>
            </button>
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
            onClick={handleLogout}
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
          <button 
            className={`tab ${activeTab === 'phone' ? 'active' : ''}`}
            onClick={openSoftphone}
            title="WebRTC Softphone"
          >
            <Headphones size={16} />
            Softphone
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

        {activeTab === 'phone' && (
          <div className="softphone-wrap">
            <Softphone />
          </div>
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
    </WebPhoneProvider>
  );
}

export default App;

