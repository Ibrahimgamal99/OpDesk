/**
 * Mobile-browser diagnostic logger.
 *
 * Mobile browsers give no reachable devtools, and the events we care about (the SIP
 * unregister + WebSocket close that kills a ringing call) happen right as the page is
 * frozen/torn down — when a normal fetch would be cancelled. So we batch log entries and
 * ship them with navigator.sendBeacon(), which the browser guarantees to deliver even
 * during pagehide/freeze. Everything lands in the backend log as `CLIENT[session] tag: msg`.
 *
 * Disabled by default. Enable on the phone by opening the app with `?debug=1` once
 * (persisted to localStorage), or run `localStorage.opdesk_debug='1'` and reload.
 */

const STORAGE_KEY = 'opdesk_debug';

function computeEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') localStorage.setItem(STORAGE_KEY, '1');
    if (params.get('debug') === '0') localStorage.removeItem(STORAGE_KEY);
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const enabled = computeEnabled();

interface Entry {
  t: number;
  tag: string;
  msg: string;
  data?: unknown;
}

// A short random id so a session's entries group together in the backend log.
const session = (() => {
  try {
    const ua = navigator.userAgent.slice(0, 24);
    return `${ua.replace(/[^a-zA-Z0-9]/g, '')}-${Math.floor(performance.now())}`.slice(0, 40);
  } catch {
    return 'web';
  }
})();

let buffer: Entry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (!enabled || buffer.length === 0) return;
  const entries = buffer;
  buffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const blob = new Blob([JSON.stringify({ session, entries })], { type: 'application/json' });
    // sendBeacon survives pagehide/freeze; fall back to keepalive fetch if unavailable.
    if (navigator.sendBeacon?.('/api/client-log', blob)) return;
    fetch('/api/client-log', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  } catch {
    // never let logging break the app
  }
}

/** Record a diagnostic entry. No-op unless debug logging is enabled. */
export function rlog(tag: string, msg: string, data?: unknown): void {
  if (!enabled) return;
  buffer.push({ t: Date.now(), tag, msg, data });
  // Coalesce bursts, but flush soon — a 1.5 s window is short enough that the entry
  // before a teardown is still pending when the pagehide/freeze flush fires.
  if (!flushTimer) flushTimer = setTimeout(flush, 1500);
  if (buffer.length >= 25) flush();
}

export const remoteLogEnabled = enabled;

if (enabled) {
  // Capture the page-lifecycle and network transitions that cause mobile teardowns,
  // and flush immediately on each so nothing is lost when the page is frozen/closed.
  const onLifecycle = (name: string) => () => {
    rlog('lifecycle', name, {
      visibility: document.visibilityState,
      online: navigator.onLine,
    });
    flush();
  };
  document.addEventListener('visibilitychange', onLifecycle('visibilitychange'));
  window.addEventListener('pagehide', onLifecycle('pagehide'));
  window.addEventListener('pageshow', onLifecycle('pageshow'));
  window.addEventListener('freeze', onLifecycle('freeze'));
  window.addEventListener('resume', onLifecycle('resume'));
  window.addEventListener('online', onLifecycle('online'));
  window.addEventListener('offline', onLifecycle('offline'));
  // Surface uncaught errors that might be tearing down the SIP stack.
  window.addEventListener('error', (e) => { rlog('window.error', String(e.message)); flush(); });
  window.addEventListener('unhandledrejection', (e) => {
    rlog('unhandledrejection', String((e as PromiseRejectionEvent).reason));
    flush();
  });
  rlog('boot', 'remote logging enabled', { ua: navigator.userAgent });
}
