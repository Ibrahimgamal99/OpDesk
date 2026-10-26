import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebPhone } from './hooks/useWebPhone';
import { WebPhoneProvider } from './contexts/WebPhoneContext';
import { AgentPresenceProvider } from './contexts/AgentPresenceContext';
import { CallOutcomeProvider, type CallOutcome } from './contexts/CallOutcomeContext';
import { getToken, setUser, getUser, fetchWithAuth, type User as AuthUser } from './auth';
import { rlog } from './lib/remoteLog';
import { subscribeWebPush } from './lib/webPush';
import { DashboardPanel } from './components/DashboardPanel';
import { ExtensionsPanel } from './components/ExtensionsPanel';
import { ActiveCallsPanel } from './components/ActiveCallsPanel';
import { QueuesPanel } from './components/QueuesPanel';
import { CallLogPanel } from './components/CallLogPanel';
import { LogsPanel } from './components/LogsPanel';
import { RecordingsPanel } from './components/RecordingsPanel';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { UsersPanel } from './components/UsersPanel';
import { GroupsPanel } from './components/GroupsPanel';
import { SupervisorModal } from './components/SupervisorModal';
import { SettingsPanel } from './components/CRMSettingsModal';
import { ContactsPanel } from './components/ContactsPanel';
import { FloatingSoftphone } from './components/FloatingSoftphone';
import { ProfilePanel } from './components/ProfilePanel';
import {
  Phone,
  PhoneCall,
  User,
  Users,
  Radio,
  LayoutDashboard,
  Wifi,
  WifiOff,
  Settings,
  History,
  LogOut,
  UserCog,
  Monitor,
  Group,
  Bell,
  Clock,
  Check,
  CheckCheck,
  Archive,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Moon,
  Sun,
  Menu,
  X,
  ScrollText,
  BookUser,
  FileAudio,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge, EmptyState, Tabs } from './components/ui';
import { CallStatusBadge } from './components/CallStatusBadge';
import { callStatusLabel, isCallStatus } from './components/callStatus';
import { memberExtension } from './components/queueMemberState';
import { quickRanges, type DateRange } from './components/analyticsUtils';
import { raiseFor } from './lib/api';
import type { CallNotification } from './types';

type TabType = 'dashboard' | 'extensions' | 'calls' | 'queues' | 'call-log' | 'contacts' | 'groups' | 'users' | 'analytics' | 'recordings' | 'logs' | 'settings' | 'profile';
/** Kept in sync with the pre-paint theme script in index.html. */
const THEME_KEY = 'opdesk:theme';

// URL routing: each tab maps 1:1 to a path segment (e.g. 'call-log' -> '/call-log').
// Deriving the active tab from the URL is what makes a refresh stay on the same page
// and lets users navigate straight to /dashboard, /extensions, etc.
const TAB_PATHS: TabType[] = ['dashboard', 'extensions', 'calls', 'queues', 'call-log', 'contacts', 'groups', 'users', 'analytics', 'recordings', 'logs', 'settings', 'profile'];
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
  if (sec < 172800) return t('common.yesterday');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A notification's reason in words. A missed-call notification's reason is a call status
 *  and reads exactly as call history shows it (callStatus.ts); anything else the backend
 *  sends passes through as its own text. */
function reasonLabel(reason: string | null, t: TFunction): string {
  if (!reason) return '';
  return isCallStatus(reason) ? callStatusLabel(t, reason) : reason;
}

/** Outside numbers worth asking the phonebook/CRM about: more than an extension's digits. */
const isOutsideNumber = (n: string) => n.replace(/\D/g, '').length > 5;

/** Snapshot of user form when opening "Create new group" from Users tab (preserved in memory, no API). */
export interface PendingUserFormSnapshot {
  username: string;
  password: string;
  /** A new SIP secret typed for the extension ('' keeps the current one). */
  sipPassword?: string;
  name: string;
  extension: string;
  role: 'admin' | 'supervisor' | 'agent';
  monitor_modes: string[];
  group_ids: string[];
}

type AppProps = { onLogout: () => void };

interface NavItem {
  tab: TabType;
  /** Other routes that light this item up (Teams covers /users and /groups). */
  also?: TabType[];
  label: string;
  Icon: LucideIcon;
  badge?: number;
  badgeTone?: 'call' | 'ringing';
}
interface NavGroup { key: string; label: string; items: NavItem[] }

function App({ onLogout }: AppProps) {
  const { t } = useTranslation();
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
        Notification.requestPermission()
          .then((perm) => { if (perm === 'granted') subscribeWebPush().catch(() => {}); })
          .catch(() => {});
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

  // Assigned right after useWebSocket below; the logout handler is defined before that
  // hook, so the closing call goes through a ref.
  const wsDisconnectRef = useRef<() => void>(() => {});
  const handleLogout = useCallback(() => {
    disconnectRef.current('logout');
    wsDisconnectRef.current();
    onLogout();
  }, [onLogout]);

  const fetchNewNotifCount = useCallback(() => {
    fetchWithAuth('/api/call-notifications?status=new&limit=100')
      .then((r) => r.ok ? r.json() : { notifications: [] })
      // `total` counts every new notification, not just the page of 100 fetched here.
      .then((data) => setNewNotifCount(typeof data.total === 'number' ? data.total : (data.notifications || []).length))
      .catch(() => setNewNotifCount(0));
  }, []);

  // The status of this user's last finished call, pushed by the backend at hangup. Bumped
  // with a monotonic seq so two identical outcomes in a row still reach the softphone's
  // notice (CallOutcomeContext).
  const [callOutcome, setCallOutcome] = useState<CallOutcome | null>(null);
  const outcomeSeq = useRef(0);
  const handleCallOutcome = useCallback((msg: { extension: string; status: string; linkedid: string }) => {
    const myExt = String(getUser()?.extension ?? '');
    if (!myExt || msg.extension !== myExt || !msg.status) return;
    outcomeSeq.current += 1;
    setCallOutcome({ status: msg.status, linkedid: msg.linkedid, seq: outcomeSeq.current });
  }, []);

  const { state, connected, lastUpdate, notifications, sendAction, disconnect: wsDisconnect } = useWebSocket(token, {
    onAuthFailure: handleLogout,
    onCallNotificationNew: fetchNewNotifCount,
    onCallOutcome: handleCallOutcome,
  });
  wsDisconnectRef.current = wsDisconnect;
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = pathToTab(location.pathname);
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
  const [notifList, setNotifList] = useState<CallNotification[]>([]);
  // Contact names for the outside numbers in the open notification list, keyed by number.
  const [notifNames, setNotifNames] = useState<Record<string, string>>({});
  const [notifUpdatingId, setNotifUpdatingId] = useState<number | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const notifDropdownRef = useRef<HTMLDivElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Refresh user (role, extension, scope, display name) from the server so scope is up to
  // date. Stored over what login returned, so a field the server leaves out keeps its value;
  // the version bump re-renders the header with the fresh name.
  const [, setMeVersion] = useState(0);
  useEffect(() => {
    if (!token) return;
    const ac = new AbortController();
    fetchWithAuth('/api/auth/me', { signal: ac.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data: AuthUser | null) => {
        if (!data || typeof data !== 'object') return;
        setUser({ ...(getUser() ?? {}), ...data });
        setMeVersion((v) => v + 1);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [token]);

  // Web Push: subscribe once authenticated (no-op unless the server has VAPID keys and the
  // user granted notifications), and again when the softphone registers.
  useEffect(() => {
    if (!token) return;
    subscribeWebPush().catch(() => { /* optional feature */ });
  }, [token]);
  useEffect(() => {
    if (!isConnected) return;
    subscribeWebPush().catch(() => { /* optional feature */ });
  }, [isConnected]);

  // Service-worker messages: re-register SIP when the user taps a push / OS incoming-call
  // notification, and refresh the bell.
  //
  // 'opdesk:notification-action' arrives when the user taps an OS notification (the app had
  // been backgrounded or closed) and 'opdesk:incoming-call' when a push arrives while a tab
  // is still alive. A backgrounded or frozen tab's SIP-over-WSS registration silently lapses
  // (the socket dies while JS is frozen, yet the status can still read 'connected'), so the
  // INVITE would never reach the softphone and the call would never ring. On a tap we force a
  // fresh registration; on the plain push relay we only (re)connect when not registered, since
  // tearing down right as the INVITE lands would be counterproductive. A call that is already
  // ringing or up is never touched.
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const isConnectedRef = useRef(isConnected);
  isConnectedRef.current = isConnected;
  useEffect(() => {
    if (!token || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onSwMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; action?: string } | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'opdesk:resubscribe') {
        subscribeWebPush().catch(() => { /* ignore */ });
      } else if (msg.type === 'opdesk:notification-action') {
        rlog('push', `notification tap (${msg.action ?? 'open'}) -> re-register SIP`);
        if (!hasCallRef.current) connectRef.current({ force: true });
        fetchNewNotifCount();
      } else if (msg.type === 'opdesk:incoming-call') {
        rlog('push', `push relayed (connected=${isConnectedRef.current})`);
        if (!isConnectedRef.current && !hasCallRef.current) connectRef.current();
        fetchNewNotifCount();
      }
    };
    navigator.serviceWorker.addEventListener('message', onSwMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onSwMessage);
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
    let alive = true;
    fetchWithAuth('/api/call-notifications?status=new&limit=20')
      .then((r) => r.ok ? r.json() : { notifications: [] })
      .then((data) => {
        if (!alive) return;
        const list: CallNotification[] = data.notifications || [];
        setNotifList(list);
        // Name the outside callers from the phonebook/CRM, once per number. Internal
        // extensions are named from the live extension list at render instead.
        const numbers = [...new Set(list.map((n) => n.caller_from || '').filter(isOutsideNumber))];
        numbers.forEach((num) => {
          fetchWithAuth(`/api/crm/contact?phone=${encodeURIComponent(num)}`)
            .then((r) => r.ok ? r.json() : null)
            .then((c) => { if (alive && c?.name) setNotifNames((prev) => ({ ...prev, [num]: c.name })); })
            .catch(() => {});
        });
      })
      .catch(() => { if (alive) setNotifList([]); });
    return () => { alive = false; };
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
    const results = await Promise.all(ids.map((id) =>
      fetchWithAuth(`/api/call-notifications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status_flag: 'read' }),
      }).then((r) => r.ok).catch(() => false)
    ));
    // Keep any row whose update failed, so it is not silently lost from view.
    const failed = new Set(ids.filter((_, i) => !results[i]));
    setNotifList((prev) => prev.filter((n) => failed.has(n.id)));
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

  // An agent has the live pages (scoped by the server to their own extension plus the
  // members and queues of their groups), their own Call History, Contacts and profile;
  // redirect away from other tabs.
  const userRole = getUser()?.role;
  useEffect(() => {
    if (userRole === 'agent' && !['dashboard', 'extensions', 'calls', 'queues', 'call-log', 'contacts', 'profile'].includes(activeTab)) {
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
  // queue_members: the fallback for a backend that sends no `agent_states`.
  const memberPresence: Record<string, { queueOn: boolean; paused: boolean; reason: string }> = {};
  for (const m of Object.values(state?.queue_members || {})) {
    // "PJSIP/120", "SIP/120-0000001a" or "Local/120@from-queue/n" -> "120".
    const ext = memberExtension(m.interface || '').split('-')[0];
    if (!ext || !/^\d+$/.test(ext)) continue;
    const prev = memberPresence[ext];
    // A member can be in several queues; treat "logged in anywhere" as queueOn and
    // "paused everywhere it appears" as Not-Ready (any active queue → Ready wins).
    memberPresence[ext] = {
      queueOn: true,
      paused: prev ? prev.paused && !!m.paused : !!m.paused,
      reason: m.pause_reason || prev?.reason || '',
    };
  }

  // The signed-in user's own live presence, for the softphone status bar
  // (AgentPresenceContext). The agent-state manager's snapshot is the truth; `is_agent`
  // says whether the extension has queues (full Ready / Not-Ready band) or is a plain
  // extension (Available / DND / Offline).
  const myExt = String(getUser()?.extension || '');
  const myExtState = myExt ? state?.extensions?.[myExt] : undefined;
  const myPresence = myExt ? (state?.agent_states?.[myExt] ?? null) : null;
  const presenceValue = {
    myExt: myExt || null,
    isAgent: myPresence?.is_agent ?? getUser()?.is_agent ?? !!memberPresence[myExt],
    presence: myPresence,
    dnd: !!myExtState?.dnd,
    onCall: myExtState?.status === 'in_call' || myExtState?.status === 'dialing'
      || myExtState?.status === 'on_hold' || myExtState?.status === 'ringing',
    sendAction,
  };
  const role = getUser()?.role;
  const isAgentRole = role === 'agent';
  const isAdminRole = role === 'admin';
  const navGroups: NavGroup[] = ([
    { key: 'live', label: t('common.live', 'Live'), items: [
      { tab: 'dashboard', label: t('nav.dashboard', 'Dashboard'), Icon: LayoutDashboard },
      { tab: 'extensions', label: t('nav.extensions'), Icon: Phone },
      { tab: 'calls', label: t('nav.activeCalls'), Icon: PhoneCall, badge: stats.active_calls_count, badgeTone: 'call' },
      // Agents see their groups' queues (read-only); hidden when they have none.
      (!isAgentRole || Object.keys(state?.queues || {}).length > 0) && { tab: 'queues', label: t('nav.queues'), Icon: Users, badge: stats.total_waiting, badgeTone: 'ringing' },
    ] },
    { key: 'work', label: t('nav.group.work', 'Work'), items: [
      { tab: 'call-log', also: ['recordings'], label: t('nav.callHistory'), Icon: History },
      { tab: 'contacts', label: t('nav.contacts', 'Contacts'), Icon: BookUser },
    ] },
    { key: 'reports', label: t('nav.group.reports', 'Reports'), items: [
      !isAgentRole && { tab: 'analytics', label: t('nav.analytics'), Icon: BarChart3 },
    ] },
    { key: 'admin', label: t('nav.admin', 'Admin'), items: [
      isAdminRole && { tab: 'users', also: ['groups'], label: t('nav.teams', 'Teams'), Icon: Users },
      (isAdminRole || role === 'supervisor') && { tab: 'settings', label: t('header.settings', 'Settings'), Icon: Settings },
      isAdminRole && { tab: 'logs', label: t('nav.logs', 'Logs'), Icon: ScrollText },
    ] },
  ] as { key: string; label: string; items: (NavItem | false)[] }[])
    .map((g) => ({ ...g, items: g.items.filter((i): i is NavItem => !!i) }))
    .filter((g) => g.items.length > 0);

  // Users and Groups are one "Teams" page with two tabs. They stay two routes so
  // /users and /groups links keep working.
  const teamsTabs = (
    <Tabs
      ariaLabel={t('nav.teams', 'Teams')}
      tabs={[
        { key: 'users', label: t('nav.users'), icon: <UserCog size={14} /> },
        { key: 'groups', label: t('nav.groups'), icon: <Group size={14} /> },
      ]}
      active={activeTab}
      onChange={(k) => selectTab(k as TabType)}
    />
  );

  // Recordings is a tab of Call History, admins only, so other roles get no strip.
  // It stays its own route so /recordings links keep working, as Teams does.
  const callHistoryTabs = isAdminRole ? (
    <Tabs
      ariaLabel={t('nav.callHistory')}
      tabs={[
        { key: 'call-log', label: t('nav.calls', 'Calls'), icon: <History size={14} /> },
        { key: 'recordings', label: t('nav.recordings', 'Recordings'), icon: <FileAudio size={14} /> },
      ]}
      active={activeTab}
      onChange={(k) => selectTab(k as TabType)}
    />
  ) : undefined;

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
            {mobileNavOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div className="header-logo"><Radio size={16} /></div>
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
              className="btn btn-ghost btn-icon header-bell-btn"
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
                  <Bell size={16} />
                  <span>{t('header.notifications')}</span>
                  {newNotifCount > 0 && <Badge tone="warning">{newNotifCount}</Badge>}
                  {notifList.length > 0 && (
                    <button type="button" className="btn btn-ghost btn-sm u-push-end" onClick={markAllRead} title={t('header.markAllRead')}>
                      <CheckCheck size={14} />{t('header.markAllRead')}
                    </button>
                  )}
                </div>
                {notifList.length === 0 ? (
                  <EmptyState size="sm" icon={Bell} title={t('header.noNewNotifications')} />
                ) : (
                  <ul className="header-bell-list">
                    {notifList.map((n) => {
                      // "Omar · 1001" / "Ahmed · +2011…": the caller's name when known (a live
                      // extension, else the phonebook/CRM), then the number.
                      const callerName = n.caller_from
                        ? (state?.extensions?.[n.caller_from]?.name || notifNames[n.caller_from] || '')
                        : '';
                      const callerText = callerName && callerName !== n.caller_from
                        ? `${callerName} · ${n.caller_from}`
                        : n.caller_from || '';
                      return (
                      <li key={n.id} className="header-bell-item" role="listitem">
                        <div className="header-bell-item-details">
                          {/* Your own extension on every row says nothing; show it only when the list spans several. */}
                          {n.extension !== String(getUser()?.extension ?? '') && (
                            <div className="header-bell-item-row">
                              <Phone size={14} className="header-bell-item-icon" aria-hidden />
                              <span className="header-bell-item-label">{t('header.ext')}</span>
                              <span className="header-bell-item-value" title={n.extension}>{n.extension}</span>
                            </div>
                          )}
                          {callerText !== '' && (
                            <div className="header-bell-item-row">
                              <User size={14} className="header-bell-item-icon" aria-hidden />
                              <span className="header-bell-item-label">{t('header.from')}</span>
                              <span className="header-bell-item-value" title={callerText}>{callerText}</span>
                            </div>
                          )}
                          {n.queue != null && n.queue !== '' && (
                            <div className="header-bell-item-row">
                              <Users size={14} className="header-bell-item-icon" aria-hidden />
                              <span className="header-bell-item-label">{t('fields.queue')}</span>
                              <span className="header-bell-item-value" title={n.queue}>{n.queue}</span>
                            </div>
                          )}
                          <div className="header-bell-item-row header-bell-item-meta">
                            <Clock size={14} className="header-bell-item-icon" aria-hidden />
                            <span className="header-bell-item-time">{formatNotifTime(n.event_time, t)}</span>
                            {/* A call status wears the badge its call-history row has; the few
                                reasons that are not call statuses get a plain one. */}
                            {n.reason && (
                              <span className="u-push-end">
                                {isCallStatus(n.reason)
                                  ? <CallStatusBadge status={n.reason} />
                                  : <Badge tone="neutral">{reasonLabel(n.reason, t)}</Badge>}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="header-bell-item-actions">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => updateNotifStatus(n.id, 'read')} disabled={notifUpdatingId === n.id} title={t('header.markRead')}>
                            <Check size={14} />{t('header.read')}
                          </button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => updateNotifStatus(n.id, 'archived')} disabled={notifUpdatingId === n.id} title={t('header.archive')}>
                            <Archive size={14} />{t('header.archive')}
                          </button>
                        </div>
                      </li>
                      );
                    })}
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
                {/* Identity: opens the profile page (passwords, SIP, mobile QR, language). */}
                <button
                  type="button"
                  className="header-profile-identity"
                  onClick={() => { setProfileMenuOpen(false); selectTab('profile'); }}
                  title={t('profile.title', 'My Profile')}
                >
                  <span className="header-profile-avatar header-profile-avatar-lg"><User size={20} /></span>
                  <div className="header-profile-identity-text">
                    <div className="header-profile-identity-name">{getUser()?.name || getUser()?.username || getUser()?.extension}</div>
                    <div className="header-profile-identity-meta">
                      <span className="header-profile-role">{t(`users.roles.${getUser()?.role}`, { defaultValue: getUser()?.role || '' })}</span>
                      {getUser()?.extension && <span className="header-profile-ext">· {t('header.ext')} {getUser()?.extension}</span>}
                    </div>
                  </div>
                  <ChevronRight size={15} className="header-profile-identity-go" />
                </button>

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
          <nav className="sidebar-nav" aria-label={t('nav.main', 'Main navigation')}>
            {navGroups.map((g, gi) => (
              <div key={g.key} className="sidebar-section">
                {sidebarCollapsed
                  ? gi > 0 && <div className="sidebar-divider" />
                  : <span className="sidebar-section-label">{g.label}</span>}
                {g.items.map((it) => {
                  const active = activeTab === it.tab || !!it.also?.includes(activeTab);
                  return (
                    <button
                      key={it.tab}
                      type="button"
                      className={`sidebar-item${active ? ' active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => selectTab(it.tab)}
                      title={sidebarCollapsed ? it.label : undefined}
                    >
                      <it.Icon size={16} />{!sidebarCollapsed && it.label}
                      {!!it.badge && <span className={`sidebar-badge sidebar-badge--${it.badgeTone}`}>{it.badge}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          {/* ── Sidebar bottom: connection + toggle ── */}
          <div className="sidebar-bottom">
            <div className={`sidebar-connection${connected ? ' connected' : ''}`} title={sidebarCollapsed ? (connected ? t('header.connected') : t('header.disconnected')) : undefined}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
              {!sidebarCollapsed && <span>{connected ? t('header.connected') : t('header.disconnected')}</span>}
            </div>
            {/* Toggle button */}
            <button
              type="button"
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
              agentStates={state?.agent_states || {}}
              memberPresence={memberPresence}
              onSupervisorAction={handleSupervisorAction}
              onSync={() => sendAction({ action: isAdminRole ? 'sync' : 'sync_calls' })}
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
              onTransfer={(source, destination, ext) => sendAction({ action: 'transfer', source, destination, ext })}
              onTakeOver={(source, ext) => sendAction({ action: 'take_over', source, ext })}
              onSync={() => sendAction({ action: isAdminRole ? 'sync' : 'sync_calls' })}
            />
          )}
          {activeTab === 'queues' && (
            <QueuesPanel
              queues={state?.queues || {}}
              members={state?.queue_members || {}}
              entries={state?.queue_entries || {}}
              extensions={state?.extensions || {}}
              agentStates={state?.agent_states || {}}
              sendAction={sendAction}
              onSync={() => sendAction({ action: isAdminRole ? 'sync' : 'sync_queues' })}
            />
          )}
          {activeTab === 'call-log' && <CallLogPanel tabs={callHistoryTabs} dateRange={dateRange} onDateRangeChange={setDateRange} />}
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
              tabs={teamsTabs}
              initialGroupName={groupsTabIntent?.prefillGroupName ?? undefined}
              onConsumeIntent={groupsTabIntent ? () => setGroupsTabIntent(null) : undefined}
            />
          )}
          {activeTab === 'users' && (
            <UsersPanel
              tabs={teamsTabs}
              pendingUserForm={pendingUserForm}
              onClearPendingUserForm={() => setPendingUserForm(null)}
              onOpenCreateGroup={(formSnapshot: PendingUserFormSnapshot, prefillGroupName?: string) => {
                setPendingUserForm(formSnapshot);
                setGroupsTabIntent({ prefillGroupName: prefillGroupName ?? '' });
                navigate('/groups');
              }}
            />
          )}
          {activeTab === 'recordings' && getUser()?.role === 'admin' && (
            <RecordingsPanel tabs={callHistoryTabs} dateRange={dateRange} onDateRangeChange={setDateRange} />
          )}
          {activeTab === 'logs' && getUser()?.role === 'admin' && <LogsPanel />}
          {activeTab === 'profile' && <ProfilePanel />}
          {activeTab === 'settings' && (getUser()?.role === 'admin' || getUser()?.role === 'supervisor') && <SettingsPanel />}
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
      <AgentPresenceProvider value={presenceValue}>
        <CallOutcomeProvider value={callOutcome}>
          <FloatingSoftphone open={floatingPhoneOpen} onOpenChange={setFloatingPhoneOpen} />
        </CallOutcomeProvider>
      </AgentPresenceProvider>
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
