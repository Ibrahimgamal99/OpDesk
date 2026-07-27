import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setLanguage } from './i18n';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebPhone } from './hooks/useWebPhone';
import { WebPhoneProvider } from './contexts/WebPhoneContext';
import { getToken, setUser, getUser, fetchWithAuth } from './auth';
import { rlog } from './lib/remoteLog';
import { subscribeWebPush } from './lib/webPush';
import { DashboardPanel } from './components/DashboardPanel';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { ActiveCallsPanel } from './components/ActiveCallsPanel';
import { QueuesPanel } from './components/QueuesPanel';
import { CallLogPanel } from './components/CallLogPanel';
import { LogsPanel } from './components/LogsPanel';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { UsersPanel } from './components/UsersPanel';
import { GroupsPanel } from './components/GroupsPanel';
import { SupervisorModal } from './components/SupervisorModal';
import { SettingsPanel, type SettingsTab } from './components/CRMSettingsModal';
import { ContactsPanel } from './components/ContactsPanel';
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
  ChevronDown,
  Moon,
  Sun,
  Menu,
  X,
  Plug,
  Signal,
  ShieldCheck,
  Smartphone,
  Disc,
  PauseCircle,
  Terminal,
  KeyRound,
  BookUser,
} from 'lucide-react';
import { quickRanges, type DateRange } from './components/analyticsUtils';
import { raiseFor } from './lib/api';

type TabType = 'dashboard' | 'extensions' | 'calls' | 'queues' | 'call-log' | 'contacts' | 'groups' | 'users' | 'analytics' | 'logs' | 'settings';
const LANGUAGE_OPTIONS = ['en', 'ar', 'es', 'pt'] as const;
/** Kept in sync with the pre-paint theme script in index.html. */
const THEME_KEY = 'opdesk:theme';

// URL routing: each tab maps 1:1 to a path segment (e.g. 'call-log' -> '/call-log').
// Deriving the active tab from the URL is what makes a refresh stay on the same page
// and lets users navigate straight to /dashboard, /extensions, etc.
const TAB_PATHS: TabType[] = ['dashboard', 'extensions', 'calls', 'queues', 'call-log', 'contacts', 'groups', 'users', 'analytics', 'logs', 'settings'];
const DEFAULT_TAB: TabType = 'dashboard';
function pathToTab(pathname: string): TabType {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  return (TAB_PATHS as string[]).includes(seg) ? (seg as TabType) : DEFAULT_TAB;
}

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
  const { connect, disconnect, canConnect, isConnected, configLoading, incomingCall, hasActiveCall } = webPhone;
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;
  // Tracks whether a call is ringing/active so the page-lifecycle teardown below
  // never unregisters SIP mid-call. On mobile, pagehide/freeze can fire while the
  // tab still looks foregrounded (notification overlay, screen-state change, memory
  // pressure); without this guard that kills a ringing incoming call.
  const hasCallRef = useRef(false);
  hasCallRef.current = !!incomingCall || hasActiveCall;

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
    disconnectRef.current('logout');
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
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const activeTab = pathToTab(location.pathname);
  const settingsSubTab = activeTab === 'settings' ? (searchParams.get('tab') || 'integrations') : 'integrations';
  // Theme. Default follows the device (prefers-color-scheme) until the user makes an
  // explicit choice, which is then persisted in localStorage and wins from then on.
  // Initial value is applied to <html data-theme> synchronously so there's no flash.
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
    let initial: 'dark' | 'light';
    if (stored === 'light' || stored === 'dark') {
      initial = stored;
    } else if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
      initial = 'light';
    } else {
      initial = 'dark';
    }
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = initial;
    return initial;
  });
  const selectTheme = useCallback((next: 'dark' | 'light') => {
    setTheme(prev => {
      if (prev === next) return prev;
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);
  // While the user hasn't explicitly chosen a theme, keep following the device so a
  // change in OS appearance (e.g. day/night auto-switch) is reflected live.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
      if (stored === 'light' || stored === 'dark') return; // user override wins
      const next: 'dark' | 'light' = e.matches ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [dateRange, setDateRange] = useState<DateRange>(() => quickRanges()['30d']);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [teamExpanded, setTeamExpanded] = useState(true);
  const [settingsExpanded, setSettingsExpanded] = useState(() => activeTab === 'settings');
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
  const [webrtcExtensions, setWebrtcExtensions] = useState<{ extension: string; name?: string; webrtc?: string }[]>([]);
  const [newNotifCount, setNewNotifCount] = useState(0);
  const [notifDropdownOpen, setNotifDropdownOpen] = useState(false);
  const [notifList, setNotifList] = useState<{ id: number; extension: string; caller_from: string | null; queue: string | null; status_flag: string; event_time: string; reason: string | null }[]>([]);
  const [notifUpdatingId, setNotifUpdatingId] = useState<number | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const notifDropdownRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

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

  // Web Push: subscribe once authenticated (no-op unless the server has VAPID keys) and
  // relay service-worker messages back into the app (a push can wake a closed tab).
  useEffect(() => {
    if (!token) return;
    subscribeWebPush().catch(() => { /* optional feature */ });
    const onSwMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'opdesk:resubscribe') {
        subscribeWebPush().catch(() => { /* ignore */ });
      } else if (msg.type === 'opdesk:incoming-call' || msg.type === 'opdesk:notification-action') {
        // Refresh notifications; the SIP/WebSocket layer handles the actual ring once the tab is live.
        fetchNewNotifCount();
      }
    };
    navigator.serviceWorker?.addEventListener?.('message', onSwMessage);
    return () => navigator.serviceWorker?.removeEventListener?.('message', onSwMessage);
  }, [token, fetchNewNotifCount]);

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
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) setProfileMenuOpen(false);
    };
    if (notifDropdownOpen || profileMenuOpen) {
      document.addEventListener('click', onOutside, true);
      return () => document.removeEventListener('click', onOutside, true);
    }
  }, [notifDropdownOpen, profileMenuOpen]);

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
    const onUnload = () => {
      // Don't tear down (and unregister) while a call is ringing/active — on mobile
      // pagehide fires spuriously and would drop the call. A real tab close lets the
      // WS die and the registration lapse on its own.
      if (hasCallRef.current) return;
      disconnectRef.current('pagehide/beforeunload');
    };
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
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    rlog('notify', `incoming call, Notification.permission=${perm}`);
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

    const title = t('common.incomingCall');
    const body = incomingCall.callerName
      ? `${incomingCall.callerName} (${incomingCall.callerNumber})`
      : incomingCall.callerNumber;
    // `vibrate` is valid for service-worker notifications but missing from the DOM
    // typings — vibration is our stand-in for a ringtone when the tab is backgrounded
    // (browsers won't autoplay looping audio in the background).
    const options: NotificationOptions & { vibrate?: number[] } = {
      body,
      icon: '/favicon.svg',
      tag: 'opdesk-incoming-call',
      requireInteraction: true,
      vibrate: [300, 150, 300, 150, 300],
    };

    let notification: Notification | null = null;
    let cancelled = false;

    // Mobile Chrome/Android FORBIDS `new Notification()` — it throws
    // "Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead".
    // That throw was previously uncaught, crashing the React tree → App unmounted →
    // the SIP stack was torn down mid-ring (the call would never connect). Prefer the
    // service-worker API, fall back to the constructor, and never let either throw.
    (async () => {
      try {
        const reg = await navigator.serviceWorker?.getRegistration?.();
        rlog('notify', `serviceWorker reg=${reg ? 'yes' : 'no'}, showNotification=${reg?.showNotification ? 'yes' : 'no'}`);
        if (cancelled) return;
        if (reg?.showNotification) {
          await reg.showNotification(title, options);
          rlog('notify', 'showNotification (service worker) succeeded');
          // Check cancelled again: cleanup may have run while showNotification awaited.
          if (cancelled) {
            reg.getNotifications?.({ tag: 'opdesk-incoming-call' })
              .then((ns) => ns?.forEach((n) => n.close()))
              .catch(() => {});
          }
          return;
        }
        notification = new Notification(title, options);
        rlog('notify', 'new Notification() succeeded');
        notification.onclick = () => {
          window.focus();
          notification?.close();
        };
      } catch (err) {
        // Notifications are best-effort; a failure here must never affect the call.
        rlog('notify', `notification FAILED: ${String(err)}`);
        console.warn('Incoming-call notification failed:', err);
      }
    })();

    // Note: we do NOT request permission here — browsers reject requestPermission()
    // outside a user gesture. Permission is requested in the AudioContext-unlock
    // handler (first click/keydown) instead.
    return () => {
      cancelled = true;
      notification?.close();
      navigator.serviceWorker?.getRegistration?.()
        .then((reg) => reg?.getNotifications?.({ tag: 'opdesk-incoming-call' }))
        .then((ns) => ns?.forEach((n) => n.close()))
        .catch(() => {});
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

  // Normalize bare "/" (and unknown paths) to the default tab so the URL always
  // reflects the visible panel and a refresh has a concrete route to land on.
  useEffect(() => {
    const seg = location.pathname.replace(/^\/+/, '').split('/')[0];
    if (!(TAB_PATHS as string[]).includes(seg)) {
      navigate(`/${DEFAULT_TAB}`, { replace: true });
    }
  }, [location.pathname, navigate]);

  // Agent only has Extensions, Active Calls, Call History; redirect away from other tabs
  const userRole = getUser()?.role;
  useEffect(() => {
    if (userRole === 'agent' && !['dashboard', 'extensions', 'calls', 'call-log', 'contacts'].includes(activeTab)) {
      navigate(`/${DEFAULT_TAB}`, { replace: true });
      return;
    }
    // Admin-only tabs. Without this a supervisor navigating to /logs gets a blank
    // <main> rather than being sent somewhere useful.
    if (userRole !== 'admin' && ['logs', 'groups', 'users'].includes(activeTab)) {
      navigate(`/${DEFAULT_TAB}`, { replace: true });
    }
  }, [userRole, activeTab, navigate]);

  // Select a tab (navigate to its route) and close the mobile drawer.
  const selectTab = useCallback((tab: TabType) => {
    navigate(`/${tab}`);
    setMobileNavOpen(false);
  }, [navigate]);

  // Open the Settings screen on a specific sub-tab (driven from the sidebar dropdown).
  const selectSettingsTab = useCallback((tab: string) => {
    navigate(`/settings?tab=${tab}`);
    setSettingsExpanded(true);
    setMobileNavOpen(false);
  }, [navigate]);

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

  // Per-extension queue presence (Ready / Not-Ready · reason) derived from the live
  // queue_members, so the Extensions grid reflects agent status like echo.
  const memberPresence: Record<string, { queueOn: boolean; paused: boolean; reason: string }> = {};
  for (const m of Object.values(state?.queue_members || {})) {
    const iface = m.interface || '';
    // interface looks like "PJSIP/120-xxxx" or "SIP/120" → pull the extension.
    const ext = iface.split('/').pop()?.split('-')[0] || '';
    if (!ext) continue;
    const prev = memberPresence[ext];
    // A member can be in several queues; treat "logged in anywhere" as queueOn and
    // "paused everywhere it appears" as Not-Ready (any active queue → Ready wins).
    memberPresence[ext] = {
      queueOn: true,
      paused: prev ? prev.paused && !!m.paused : !!m.paused,
      reason: m.pause_reason || prev?.reason || '',
    };
  }

  // Live agent presence for the softphone status bar (DND + queue login), derived
  // from the WebSocket state for the logged-in user's own extension.
  const myExt = String(getUser()?.extension || '');
  const agentPresence = myExt ? (() => {
    const e = state?.extensions?.[myExt];
    const member = Object.values(state?.queue_members || {}).find(
      (m) => (m.interface || '').split('/').pop()?.split('-')[0] === myExt || (m.interface || '').includes(`/${myExt}`)
    );
    return {
      ext: myExt,
      dnd: !!e?.dnd,
      queueOn: !!member,
      paused: !!member?.paused,
      reason: member?.pause_reason || '',
      onCall: e?.status === 'in_call' || e?.status === 'dialing' || e?.status === 'on_hold',
    };
  })() : null;


  const handleLangSwitch = (lang: string) => {
    setLanguage(lang);
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

          {/* Profile menu: identity + preferences (appearance, language) + sign out */}
          <div ref={profileMenuRef} className="header-profile">
            <button
              type="button"
              className="btn header-profile-btn"
              onClick={() => setProfileMenuOpen(o => !o)}
              title={t('header.profile')}
              aria-label={t('header.profile')}
              aria-expanded={profileMenuOpen}
            >
              <span className="header-profile-avatar"><User size={16} /></span>
              <span className="header-profile-name">{getUser()?.name || getUser()?.username || getUser()?.extension}</span>
              <ChevronDown size={14} className={`header-profile-caret${profileMenuOpen ? ' open' : ''}`} />
            </button>

            {profileMenuOpen && (
              <div className="header-profile-dropdown">
                {/* Identity */}
                <div className="header-profile-identity">
                  <span className="header-profile-avatar header-profile-avatar-lg"><User size={20} /></span>
                  <div className="header-profile-identity-text">
                    <div className="header-profile-identity-name">{getUser()?.name || getUser()?.username || getUser()?.extension}</div>
                    <div className="header-profile-identity-meta">
                      <span className="header-profile-role">{t(`users.roles.${getUser()?.role}`, { defaultValue: getUser()?.role || '' })}</span>
                      {getUser()?.extension && <span className="header-profile-ext">· {t('header.ext')} {getUser()?.extension}</span>}
                    </div>
                  </div>
                </div>

                <div className="header-profile-divider" />
                <div className="header-profile-section-label">{t('header.preferences')}</div>

                {/* Appearance (theme) */}
                <div className="header-profile-row">
                  <span className="header-profile-row-label">
                    {theme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
                    {t('header.appearance')}
                  </span>
                  <div className="header-profile-segmented" role="group" aria-label={t('header.appearance')}>
                    <button type="button" className={`header-profile-seg${theme === 'light' ? ' active' : ''}`} onClick={() => selectTheme('light')}>
                      <Sun size={13} />{t('header.light')}
                    </button>
                    <button type="button" className={`header-profile-seg${theme === 'dark' ? ' active' : ''}`} onClick={() => selectTheme('dark')}>
                      <Moon size={13} />{t('header.dark')}
                    </button>
                  </div>
                </div>

                {/* Language */}
                <div className="header-profile-row">
                  <span className="header-profile-row-label">
                    <Globe size={15} />{t('language.select')}
                  </span>
                  <div className="header-profile-segmented" role="group" aria-label={t('language.select')}>
                    {LANGUAGE_OPTIONS.map(lang => (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => handleLangSwitch(lang)}
                        className={`header-profile-seg${i18n.language === lang ? ' active' : ''}`}
                      >
                        {t(`language.${lang}`)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Monitor mode (non-agent only) */}
                {getUser()?.role !== 'agent' && (() => {
                  const modes = getUser()?.monitor_modes;
                  const modesLabel = (modes && modes.length > 0 ? modes : ['listen'])
                    .map(m => t(`users.monitor.${m}`, { defaultValue: m })).join(', ');
                  return (
                    <div className="header-profile-row">
                      <span className="header-profile-row-label"><Monitor size={15} />{t('header.monitor')}</span>
                      <span className="header-profile-row-value">{modesLabel}</span>
                    </div>
                  );
                })()}

                <div className="header-profile-divider" />

                {/* Sign out */}
                <button type="button" className="header-profile-signout" onClick={handleLogout}>
                  <LogOut size={15} />{t('header.signOut')}
                </button>
              </div>
            )}
          </div>
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

            <button className={`sidebar-item${activeTab === 'dashboard' ? ' active' : ''}`} onClick={() => selectTab('dashboard')} title={sidebarCollapsed ? t('nav.dashboard', 'Dashboard') : undefined}>
              <Activity size={16} />{!sidebarCollapsed && t('nav.dashboard', 'Dashboard')}
            </button>

            <button className={`sidebar-item${activeTab === 'extensions' ? ' active' : ''}`} onClick={() => selectTab('extensions')} title={sidebarCollapsed ? t('nav.extensions') : undefined}>
              <Phone size={16} />{!sidebarCollapsed && t('nav.extensions')}
            </button>

            <button className={`sidebar-item${activeTab === 'calls' ? ' active' : ''}`} onClick={() => selectTab('calls')} title={sidebarCollapsed ? t('nav.activeCalls') : undefined}>
              <PhoneCall size={16} />{!sidebarCollapsed && t('nav.activeCalls')}
              {stats.active_calls_count > 0 && (
                <span className="sidebar-badge" style={{ background: 'var(--status-call)', color: 'var(--text-on-accent)' }}>{stats.active_calls_count}</span>
              )}
            </button>

            {getUser()?.role !== 'agent' && (
              <button className={`sidebar-item${activeTab === 'queues' ? ' active' : ''}`} onClick={() => selectTab('queues')} title={sidebarCollapsed ? t('nav.queues') : undefined}>
                <Users size={16} />{!sidebarCollapsed && t('nav.queues')}
                {stats.total_waiting > 0 && (
                  <span className="sidebar-badge" style={{ background: 'var(--status-ringing)', color: 'var(--text-on-accent)' }}>{stats.total_waiting}</span>
                )}
              </button>
            )}

            <button className={`sidebar-item${activeTab === 'call-log' ? ' active' : ''}`} onClick={() => selectTab('call-log')} title={sidebarCollapsed ? t('nav.callHistory') : undefined}>
              <History size={16} />{!sidebarCollapsed && t('nav.callHistory')}
            </button>

            {/* Contacts — everyone can browse; editing is admin-only inside the panel */}
            <button className={`sidebar-item${activeTab === 'contacts' ? ' active' : ''}`} onClick={() => selectTab('contacts')} title={sidebarCollapsed ? t('nav.contacts', 'Contacts') : undefined}>
              <BookUser size={16} />{!sidebarCollapsed && t('nav.contacts', 'Contacts')}
            </button>

            {getUser()?.role !== 'agent' && (
              <button className={`sidebar-item${activeTab === 'analytics' ? ' active' : ''}`} onClick={() => selectTab('analytics')} title={sidebarCollapsed ? t('nav.analytics') : undefined}>
                <BarChart3 size={16} />{!sidebarCollapsed && t('nav.analytics')}
              </button>
            )}

            {getUser()?.role === 'admin' && (
              <>
                <div className="sidebar-divider" />

                {/* Team collapsible group — admin only */}
                {!sidebarCollapsed ? (
                  <div className="sidebar-group">
                    <button
                      className={`sidebar-group-header${(activeTab === 'groups' || activeTab === 'users') ? ' has-active' : ''}`}
                      onClick={() => setTeamExpanded(e => !e)}
                    >
                      <Users size={16} />
                      <span>{t('nav.team', 'Team')}</span>
                      <ChevronRight size={12} className={`sidebar-group-chevron${teamExpanded ? ' open' : ''}`} />
                    </button>
                    {teamExpanded && (
                      <>
                        <button className={`sidebar-subitem${activeTab === 'groups' ? ' active' : ''}`} onClick={() => selectTab('groups')}>
                          <Group size={14} />{t('nav.groups')}
                        </button>
                        <button className={`sidebar-subitem${activeTab === 'users' ? ' active' : ''}`} onClick={() => selectTab('users')}>
                          <UserCog size={14} />{t('nav.users')}
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    <button className={`sidebar-item${activeTab === 'groups' ? ' active' : ''}`} onClick={() => selectTab('groups')} title={t('nav.groups')}>
                      <Group size={16} />
                    </button>
                    <button className={`sidebar-item${activeTab === 'users' ? ' active' : ''}`} onClick={() => selectTab('users')} title={t('nav.users')}>
                      <UserCog size={16} />
                    </button>
                  </>
                )}

                {/* Logs — one route with in-panel tabs, so a flat item rather than a
                    collapsible group (Team/Settings are groups because they fan out
                    to several routes). */}
                <button
                  className={`sidebar-item${activeTab === 'logs' ? ' active' : ''}`}
                  onClick={() => selectTab('logs')}
                  title={sidebarCollapsed ? t('nav.logs', 'Logs') : undefined}
                >
                  <Terminal size={16} />{!sidebarCollapsed && t('nav.logs', 'Logs')}
                </button>
              </>
            )}

            {/* Settings — admin and supervisor. Collapsible dropdown of sub-tabs (echo-style). */}
            {(getUser()?.role === 'admin' || getUser()?.role === 'supervisor') && (
              <>
                {getUser()?.role === 'supervisor' && <div className="sidebar-divider" />}
                {sidebarCollapsed ? (
                  <button
                    className={`sidebar-item${activeTab === 'settings' ? ' active' : ''}`}
                    onClick={() => selectSettingsTab('integrations')}
                    title={t('header.settings', 'Settings')}
                  >
                    <Settings size={16} />
                  </button>
                ) : (
                  <div className="sidebar-group">
                    <button
                      className={`sidebar-group-header${activeTab === 'settings' ? ' has-active' : ''}`}
                      onClick={() => setSettingsExpanded(e => !e)}
                    >
                      <Settings size={16} />
                      <span>{t('header.settings', 'Settings')}</span>
                      <ChevronRight size={12} className={`sidebar-group-chevron${settingsExpanded ? ' open' : ''}`} />
                    </button>
                    {settingsExpanded && (
                      <>
                        {[
                          { key: 'integrations', icon: Plug, label: t('settings.tabs.integrations', 'Integrations / CRM') },
                          { key: 'api-keys', icon: KeyRound, label: t('settings.tabs.apiKeys', 'API Keys'), adminOnly: true },
                          { key: 'qos', icon: Signal, label: t('settings.tabs.qos', 'QoS') },
                          { key: 'analytics', icon: BarChart3, label: t('settings.tabs.analytics', 'Analytics') },
                          { key: 'sip-tls', icon: ShieldCheck, label: t('settings.tabs.sipTls', 'SIP TLS') },
                          { key: 'mobile-wake', icon: Smartphone, label: t('settings.tabs.mobileWake', 'Mobile Wake') },
                          { key: 'recording', icon: Disc, label: t('settings.tabs.recording', 'Recording') },
                          { key: 'not-ready-codes', icon: PauseCircle, label: t('notReady.title', 'Not-Ready Codes') },
                        ].filter(x => !(x as { adminOnly?: boolean }).adminOnly || getUser()?.role === 'admin')
                         .map(({ key, icon: Icon, label }) => (
                          <button
                            key={key}
                            className={`sidebar-subitem${activeTab === 'settings' && settingsSubTab === key ? ' active' : ''}`}
                            onClick={() => selectSettingsTab(key)}
                          >
                            <Icon size={14} />{label}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
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
          {activeTab === 'dashboard' && (
            <DashboardPanel state={state} connected={connected} lastUpdate={lastUpdate} />
          )}
          {activeTab === 'extensions' && (
            <ExtensionsPanel
              extensions={state?.extensions || {}}
              memberPresence={memberPresence}
              onSupervisorAction={handleSupervisorAction}
              onSync={() => sendAction({ action: 'sync' })}
              webrtcMap={Object.fromEntries(webrtcExtensions.map((e) => [e.extension, e.webrtc || 'no']))}
              allowedDndExtensions={new Set(webrtcExtensions.map((e) => e.extension))}
              onDndToggle={async (ext, enabled) => {
                const res = await fetchWithAuth(`/api/extensions/${ext}/dnd`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ enabled }),
                });
                if (!res.ok) await raiseFor(res);
                // DND state flip arrives via the WebSocket state broadcast.
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
              extensions={state?.extensions || {}}
              sendAction={sendAction}
              onSync={() => sendAction({ action: 'sync' })}
            />
          )}
          {activeTab === 'call-log' && <CallLogPanel dateRange={dateRange} onDateRangeChange={setDateRange} />}
          {activeTab === 'contacts' && (
            <ContactsPanel
              onDial={(phone) => {
                webPhone.setDialNumber(phone);
                setFloatingPhoneOpen(true);
              }}
            />
          )}
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
                navigate('/groups');
              }}
            />
          )}
          {activeTab === 'logs' && getUser()?.role === 'admin' && <LogsPanel />}
          {activeTab === 'settings' && (getUser()?.role === 'admin' || getUser()?.role === 'supervisor') && <SettingsPanel tab={settingsSubTab as SettingsTab} onTabChange={selectSettingsTab} />}
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
      <FloatingSoftphone open={floatingPhoneOpen} onOpenChange={setFloatingPhoneOpen} presence={agentPresence} />
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
