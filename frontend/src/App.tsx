import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from './i18n';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebPhone } from './hooks/useWebPhone';
import { WebPhoneProvider } from './contexts/WebPhoneContext';
import { getToken, setUser, getUser, fetchWithAuth } from './auth';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { ActiveCallsPanel } from './components/ActiveCallsPanel';
import { QueuesPanel } from './components/QueuesPanel';
import { CallLogPanel } from './components/CallLogPanel';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { UsersPanel } from './components/UsersPanel';
import { GroupsPanel } from './components/GroupsPanel';
import { SupervisorModal } from './components/SupervisorModal';
import { CRMSettingsModal } from './components/CRMSettingsModal';
import { FloatingSoftphone } from './components/FloatingSoftphone';
import {
  Phone,
  PhoneCall,
  User,
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
  Bell,
  PhoneMissed,
  Clock,
  Check,
  CheckCheck,
  Archive,
  Globe,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
} from 'lucide-react';
import { quickRanges, type DateRange } from './components/analyticsUtils';

type TabType = 'extensions' | 'calls' | 'queues' | 'call-log' | 'groups' | 'users' | 'analytics';
const LANGUAGE_OPTIONS = ['en', 'ar', 'es', 'pt'] as const;

function formatNotifTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(iso);
  const now = new Date();
  const sec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (sec < 60) return t('time.justNow');
  if (sec < 3600) return t('time.minutesAgo', { count: Math.floor(sec / 60) });
  if (sec < 86400) return t('time.hoursAgo', { count: Math.floor(sec / 3600) });
  if (sec < 172800) return t('time.yesterday');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function reasonLabel(reason: string | null, t: (key: string) => string): string {
  if (!reason) return '';
  const key = `reason.${reason}`;
  const translated = t(key);
  // If no translation found, return the raw reason
  return translated !== key ? translated : reason;
}

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
  const { t, i18n } = useTranslation();
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
      // Request notification permission here too: browsers only allow it from a
      // user-generated event handler, so requesting it later (e.g. on an incoming
      // call) is rejected. This unlock runs on the first click/keydown.
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
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

  const fetchNewNotifCount = useCallback(() => {
    fetchWithAuth('/api/call-notifications?status=new&limit=100')
      .then((r) => r.ok ? r.json() : { notifications: [] })
      .then((data) => setNewNotifCount((data.notifications || []).length))
      .catch(() => setNewNotifCount(0));
  }, []);

  const { state, connected, lastUpdate, notifications, sendAction } = useWebSocket(token, {
    onAuthFailure: handleLogout,
    onCallNotificationNew: fetchNewNotifCount,
  });
  const [activeTab, setActiveTab] = useState<TabType>('extensions');
  const [dateRange, setDateRange] = useState<DateRange>(() => quickRanges()['30d']);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [floatingPhoneOpen, setFloatingPhoneOpen] = useState(false);
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
  const [webrtcExtensions, setWebrtcExtensions] = useState<{ extension: string; name?: string; webrtc?: string }[]>([]);
  const [newNotifCount, setNewNotifCount] = useState(0);
  const [notifDropdownOpen, setNotifDropdownOpen] = useState(false);
  const [notifList, setNotifList] = useState<{ id: number; extension: string; caller_from: string | null; queue: string | null; status_flag: string; event_time: string; reason: string | null }[]>([]);
  const [notifUpdatingId, setNotifUpdatingId] = useState<number | null>(null);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const notifDropdownRef = useRef<HTMLDivElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);

  // Refresh user (role, extension, scope) from server so scope is up to date
  useEffect(() => {
    if (!token) return;
    const ac = new AbortController();
    fetchWithAuth('/api/auth/me', { signal: ac.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setUser(data); })
      .catch(() => {});
    return () => ac.abort();
  }, [token]);

  // Load WebRTC extension list for Extensions tab (who can toggle and current state)
  useEffect(() => {
    if (activeTab !== 'extensions') return;
    fetchWithAuth('/api/settings/extensions/webrtc')
      .then((r) => r.ok ? r.json() : { extensions: [] })
      .then((data) => setWebrtcExtensions(data.extensions || []))
      .catch(() => setWebrtcExtensions([]));
  }, [activeTab, token]);

  useEffect(() => { fetchNewNotifCount(); }, [fetchNewNotifCount]);

  useEffect(() => {
    if (!notifDropdownOpen) return;
    fetchWithAuth('/api/call-notifications?status=new&limit=20')
      .then((r) => r.ok ? r.json() : { notifications: [] })
      .then((data) => setNotifList(data.notifications || []))
      .catch(() => setNotifList([]));
  }, [notifDropdownOpen]);

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (notifDropdownRef.current && !notifDropdownRef.current.contains(e.target as Node)) setNotifDropdownOpen(false);
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) setLangMenuOpen(false);
    };
    if (notifDropdownOpen || langMenuOpen) {
      document.addEventListener('click', onOutside, true);
      return () => document.removeEventListener('click', onOutside, true);
    }
  }, [notifDropdownOpen, langMenuOpen]);

  const updateNotifStatus = useCallback(async (id: number, status: 'read' | 'archived') => {
    setNotifUpdatingId(id);
    try {
      const res = await fetchWithAuth(`/api/call-notifications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status_flag: status }),
      });
      if (!res.ok) return;
      setNotifList((prev) => prev.filter((n) => n.id !== id));
      fetchNewNotifCount();
    } finally {
      setNotifUpdatingId(null);
    }
  }, [fetchNewNotifCount]);

  const markAllRead = useCallback(async () => {
    const ids = notifList.map((n) => n.id);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) =>
      fetchWithAuth(`/api/call-notifications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status_flag: 'read' }),
      })
    ));
    setNotifList([]);
    fetchNewNotifCount();
  }, [notifList, fetchNewNotifCount]);

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

  // Show browser notification when incoming call (the floating dialer auto-opens itself).
  useEffect(() => {
    if (!incomingCall) return;
    let notification: Notification | null = null;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const title = t('common.incomingCall');
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
    // Note: we do NOT request permission here — browsers reject requestPermission()
    // outside a user gesture. Permission is requested in the AudioContext-unlock
    // handler (first click/keydown) instead.
    return () => {
      notification?.close();
    };
  }, [incomingCall, t]);

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
      const now = ctx.currentTime;
      const playTone = (freq: number, offset: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.4, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.01, now + offset + duration);
        osc.start(now + offset);
        osc.stop(now + offset + duration);
      };
      playTone(440, 0, 0.2);
      playTone(440, 0.25, 0.2);
      playTone(480, 0.55, 0.2);
      playTone(480, 0.8, 0.2);
    };
    const interval = setInterval(playRing, 2000);
    playRing();
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [incomingCall]);

  // Agent only has Extensions, Active Calls, Call History; switch away from other tabs
  const userRole = getUser()?.role;
  useEffect(() => {
    if (userRole === 'agent' && !['extensions', 'calls', 'call-log'].includes(activeTab)) {
      setActiveTab('extensions');
    }
  }, [userRole, activeTab]);

  // Select a tab and close the mobile drawer (no-op on desktop where it's never open)
  const selectTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    setMobileNavOpen(false);
  }, []);

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


  const handleLangSwitch = (lang: string) => {
    setLanguage(lang);
    setLangMenuOpen(false);
  };

  return (
    <WebPhoneProvider value={webPhone}>
    <div className="app">

      {/* ── Header: 56px compact bar ── */}
      <header className="header">
        <div className="header-brand">
          <button
            type="button"
            className="header-hamburger"
            onClick={() => setMobileNavOpen((o) => !o)}
            aria-label={mobileNavOpen ? t('nav.closeMenu') : t('nav.openMenu')}
            aria-expanded={mobileNavOpen}
          >
            {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="header-logo"><Radio size={20} /></div>
          <div>
            <h1 className="header-title">{t('app.title')}</h1>
            <p className="header-subtitle">{t('app.subtitle')}</p>
          </div>
        </div>

        <div className="header-status">
          {/* Notifications bell */}
          <div className="header-bell-wrap" ref={notifDropdownRef}>
            <button
              type="button"
              className="btn header-bell-btn"
              onClick={() => setNotifDropdownOpen((o) => !o)}
              title={t('header.callNotifications')}
              aria-label={newNotifCount ? t('header.newNotifications', { count: newNotifCount }) : t('header.notifications')}
            >
              <Bell size={18} />
              {newNotifCount > 0 && <span className="header-bell-badge">{newNotifCount > 99 ? '99+' : newNotifCount}</span>}
            </button>
            {notifDropdownOpen && (
              <div className="header-bell-dropdown">
                <div className="header-bell-dropdown-header">
                  <PhoneMissed size={16} />
                  <span>{t('header.missedBusyCalls')}</span>
                  {newNotifCount > 0 && <span className="header-bell-dropdown-count">{newNotifCount}</span>}
                  {notifList.length > 0 && (
                    <button type="button" className="btn btn-sm header-bell-action-btn header-bell-mark-all-btn" onClick={markAllRead} title={t('header.markAllRead')}>
                      <CheckCheck size={14} /><span>{t('header.markAllRead')}</span>
                    </button>
                  )}
                </div>
                {notifList.length === 0 ? (
                  <div className="header-bell-dropdown-empty">
                    <Phone size={20} />
                    <span>{t('header.noNewNotifications')}</span>
                  </div>
                ) : (
                  <ul className="header-bell-list">
                    {notifList.map((n) => (
                      <li key={n.id} className="header-bell-item" role="listitem">
                        <div className="header-bell-item-details">
                          <div className="header-bell-item-row">
                            <Phone size={12} className="header-bell-item-icon" aria-hidden />
                            <span className="header-bell-item-label">{t('header.ext')}</span>
                            <span className="header-bell-item-value" title={n.extension}>{n.extension}</span>
                          </div>
                          {n.caller_from != null && n.caller_from !== '' && (
                            <div className="header-bell-item-row">
                              <User size={12} className="header-bell-item-icon" aria-hidden />
                              <span className="header-bell-item-label">{t('header.from')}</span>
                              <span className="header-bell-item-value" title={n.caller_from}>{n.caller_from}</span>
                            </div>
                          )}
                          {n.queue != null && n.queue !== '' && (
                            <div className="header-bell-item-row">
                              <Users size={12} className="header-bell-item-icon" aria-hidden />
                              <span className="header-bell-item-label">{t('header.queue')}</span>
                              <span className="header-bell-item-value" title={n.queue}>{n.queue}</span>
                            </div>
                          )}
                          <div className="header-bell-item-row header-bell-item-meta">
                            <Clock size={12} className="header-bell-item-icon" aria-hidden />
                            <span className="header-bell-item-time">{formatNotifTime(n.event_time, t)}</span>
                            {n.reason && (
                              <span className={`header-bell-reason header-bell-reason-${String(n.reason).replace(/\s+/g, '_')}`} title={reasonLabel(n.reason, t)}>
                                {reasonLabel(n.reason, t)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="header-bell-item-actions">
                          <button type="button" className="btn btn-sm header-bell-action-btn" onClick={() => updateNotifStatus(n.id, 'read')} disabled={notifUpdatingId === n.id} title={t('header.markRead')}>
                            <Check size={14} /><span>{t('header.read')}</span>
                          </button>
                          <button type="button" className="btn btn-sm header-bell-action-btn" onClick={() => updateNotifStatus(n.id, 'archived')} disabled={notifUpdatingId === n.id} title={t('header.archive')}>
                            <Archive size={14} /><span>{t('header.archive')}</span>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Monitor mode badge */}
          {getUser()?.role !== 'agent' && (() => {
            const modes = getUser()?.monitor_modes;
            const modesLabel = (modes && modes.length > 0 ? modes : ['listen'])
              .map(m => t(`users.monitor.${m}`, { defaultValue: m })).join(', ');
            return (
              <span className="header-monitor-mode" title={`${t('header.monitor')}: ${modesLabel}`}>
                <Monitor size={16} className="header-monitor-icon" />
                <span className="header-monitor-label">{modesLabel}</span>
              </span>
            );
          })()}

          {/* Language switcher */}
          <div ref={langMenuRef} className="lang-menu">
            <button className="btn" onClick={() => setLangMenuOpen(o => !o)} title={t('language.select')} aria-label={t('language.select')}>
              <Globe size={14} />
            </button>
            {langMenuOpen && (
              <div className="lang-menu-dropdown">
                {LANGUAGE_OPTIONS.map(lang => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => handleLangSwitch(lang)}
                    className={`lang-menu-item${i18n.language === lang ? ' active' : ''}`}
                  >
                    {t(`language.${lang}`)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Settings */}
          {(getUser()?.role === 'admin' || getUser()?.role === 'supervisor') && (
            <button className="btn" onClick={() => setCrmSettingsOpen(true)} title={t('header.settings')}>
              <Settings size={14} />
            </button>
          )}

          {/* Logout */}
          <button className="btn" onClick={handleLogout} title={t('header.signOut')}>
            <LogOut size={14} />
            <span className="header-btn-label">{t('header.logout')}</span>
          </button>
        </div>
      </header>

      {/* ── Body: sidebar + content ── */}
      <div className="body-layout">

        {/* Mobile drawer backdrop */}
        {mobileNavOpen && (
          <div className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden />
        )}

        {/* ── Sidebar ── */}
        <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}${mobileNavOpen ? ' open' : ''}`}>
          <nav className="sidebar-nav">

            <button className={`sidebar-item${activeTab === 'extensions' ? ' active' : ''}`} onClick={() => selectTab('extensions')} title={sidebarCollapsed ? t('nav.extensions') : undefined}>
              <Phone size={16} />{!sidebarCollapsed && t('nav.extensions')}
            </button>

            <button className={`sidebar-item${activeTab === 'calls' ? ' active' : ''}`} onClick={() => selectTab('calls')} title={sidebarCollapsed ? t('nav.activeCalls') : undefined}>
              <PhoneCall size={16} />{!sidebarCollapsed && t('nav.activeCalls')}
              {stats.active_calls_count > 0 && (
                <span className="sidebar-badge" style={{ background: 'var(--status-call)', color: '#fff' }}>{stats.active_calls_count}</span>
              )}
            </button>

            {getUser()?.role !== 'agent' && (
              <button className={`sidebar-item${activeTab === 'queues' ? ' active' : ''}`} onClick={() => selectTab('queues')} title={sidebarCollapsed ? t('nav.queues') : undefined}>
                <Users size={16} />{!sidebarCollapsed && t('nav.queues')}
                {stats.total_waiting > 0 && (
                  <span className="sidebar-badge" style={{ background: 'var(--status-ringing)', color: '#fff' }}>{stats.total_waiting}</span>
                )}
              </button>
            )}

            <button className={`sidebar-item${activeTab === 'call-log' ? ' active' : ''}`} onClick={() => selectTab('call-log')} title={sidebarCollapsed ? t('nav.callHistory') : undefined}>
              <History size={16} />{!sidebarCollapsed && t('nav.callHistory')}
            </button>

            {getUser()?.role !== 'agent' && (
              <button className={`sidebar-item${activeTab === 'analytics' ? ' active' : ''}`} onClick={() => selectTab('analytics')} title={sidebarCollapsed ? t('nav.analytics') : undefined}>
                <BarChart3 size={16} />{!sidebarCollapsed && t('nav.analytics')}
              </button>
            )}

            {getUser()?.role === 'admin' && (
              <>
                <div className="sidebar-divider" />
                {!sidebarCollapsed && <span className="sidebar-section-label">{t('nav.admin', 'Admin')}</span>}
                <button className={`sidebar-item${activeTab === 'groups' ? ' active' : ''}`} onClick={() => selectTab('groups')} title={sidebarCollapsed ? t('nav.groups') : undefined}>
                  <Group size={16} />{!sidebarCollapsed && t('nav.groups')}
                </button>
                <button className={`sidebar-item${activeTab === 'users' ? ' active' : ''}`} onClick={() => selectTab('users')} title={sidebarCollapsed ? t('nav.users') : undefined}>
                  <UserCog size={16} />{!sidebarCollapsed && t('nav.users')}
                </button>
              </>
            )}
          </nav>

          {/* ── Sidebar bottom: stats + connection + toggle ── */}
          <div className="sidebar-bottom">
            <div className="sidebar-stats">
              <div className="sidebar-stat-item" title={sidebarCollapsed ? t('stats.extensions') : undefined}>
                <Phone size={14} className="sidebar-stat-icon" />
                {!sidebarCollapsed && <div><div className="sidebar-stat-value">{stats.total_extensions}</div><div className="sidebar-stat-label">{t('stats.extensions')}</div></div>}
                {sidebarCollapsed && <div className="sidebar-stat-value">{stats.total_extensions}</div>}
              </div>
              <div className="sidebar-stat-item" title={sidebarCollapsed ? t('stats.activeCalls') : undefined}>
                <PhoneCall size={14} className="sidebar-stat-icon" />
                {!sidebarCollapsed && <div><div className="sidebar-stat-value">{stats.active_calls_count}</div><div className="sidebar-stat-label">{t('stats.activeCalls')}</div></div>}
                {sidebarCollapsed && <div className="sidebar-stat-value">{stats.active_calls_count}</div>}
              </div>
              <div className="sidebar-stat-item" title={sidebarCollapsed ? t('stats.waiting') : undefined}>
                <Users size={14} className="sidebar-stat-icon" />
                {!sidebarCollapsed && <div><div className="sidebar-stat-value">{stats.total_waiting}</div><div className="sidebar-stat-label">{t('stats.waiting')}</div></div>}
                {sidebarCollapsed && <div className="sidebar-stat-value">{stats.total_waiting}</div>}
              </div>
            </div>
            <div className={`sidebar-connection${connected ? ' connected' : ''}`} title={sidebarCollapsed ? (connected ? t('header.connected') : t('header.disconnected')) : undefined}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
              {!sidebarCollapsed && <span>{connected ? t('header.connected') : t('header.disconnected')}</span>}
            </div>
            {!sidebarCollapsed && lastUpdate && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5, padding: '0 2px' }}>
                <Activity size={10} />
                {lastUpdate.toLocaleTimeString()}
              </div>
            )}
            {/* Toggle button */}
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarCollapsed(c => !c)}
              title={sidebarCollapsed ? t('nav.expandSidebar', 'Expand sidebar') : t('nav.collapseSidebar', 'Collapse sidebar')}
            >
              {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
              {!sidebarCollapsed && <span>{t('nav.collapseSidebar', 'Collapse')}</span>}
            </button>
          </div>
        </aside>

        {/* ── Main content (scrollable) ── */}
        <main className="main-content">
          {activeTab === 'extensions' && (
            <ExtensionsPanel
              extensions={state?.extensions || {}}
              onSupervisorAction={handleSupervisorAction}
              onSync={() => sendAction({ action: 'sync' })}
              webrtcMap={Object.fromEntries(webrtcExtensions.map((e) => [e.extension, e.webrtc || 'no']))}
              allowedWebrtcExtensions={new Set(webrtcExtensions.map((e) => e.extension))}
              onWebrtcToggle={async (ext, enabled) => {
                const res = await fetchWithAuth(`/api/settings/extensions/${ext}/webrtc`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled }),
                });
                if (!res.ok) throw new Error((await res.json()).detail || 'Failed');
                const list = await fetchWithAuth('/api/settings/extensions/webrtc');
                const data = await list.json();
                setWebrtcExtensions(data.extensions || []);
              }}
            />
          )}
          {activeTab === 'calls' && (
            <ActiveCallsPanel
              calls={state?.active_calls || {}}
              onSupervisorAction={handleSupervisorAction}
              onHangup={(target) => sendAction({ action: 'hangup', target })}
              onTransfer={(source, destination) => sendAction({ action: 'transfer', source, destination })}
              onTakeOver={(source) => sendAction({ action: 'take_over', source })}
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
          {activeTab === 'call-log' && <CallLogPanel dateRange={dateRange} onDateRangeChange={setDateRange} />}
          {activeTab === 'analytics' && <AnalyticsPanel dateRange={dateRange} onDateRangeChange={setDateRange} />}
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
        </main>
      </div>

      {supervisorModal.isOpen && (
        <SupervisorModal
          mode={supervisorModal.mode}
          target={supervisorModal.target}
          onClose={() => setSupervisorModal(prev => ({ ...prev, isOpen: false }))}
          onSubmit={executeSupervisorAction}
        />
      )}
      <CRMSettingsModal isOpen={crmSettingsOpen} onClose={() => setCrmSettingsOpen(false)} />
      <FloatingSoftphone open={floatingPhoneOpen} onOpenChange={setFloatingPhoneOpen} />
      <div className="notifications">
        {notifications.map((notification, index) => (
          <div key={index} className="notification">{notification}</div>
        ))}
      </div>
    </div>
    </WebPhoneProvider>
  );
}

export default App;
