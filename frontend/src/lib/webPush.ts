/**
 * Browser Web Push (VAPID) subscription helper.
 *
 * Registers the browser's push subscription as a platform='web' device token so the
 * backend can wake a closed/backgrounded tab for incoming calls. All functions are
 * safe no-ops when Web Push is unsupported or unconfigured (no VAPID key) — the app
 * keeps working with the in-tab WebSocket notifications as before.
 */
import { fetchWithAuth } from '../auth';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function webPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Subscribe to Web Push and register the subscription with the backend.
 * Returns true if a subscription is active (new or existing), false otherwise.
 */
export async function subscribeWebPush(): Promise<boolean> {
  if (!webPushSupported()) return false;
  try {
    // Fetch the server's VAPID public key; if Web Push is disabled server-side, stop.
    const res = await fetchWithAuth('/api/push/vapid-public-key');
    if (!res.ok) return false;
    const { enabled, public_key } = await res.json();
    if (!enabled || !public_key) return false;

    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
    } else if (Notification.permission !== 'granted') {
      return false;
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key) as BufferSource,
      });
    }

    const token = JSON.stringify(sub.toJSON());
    const reg2 = await fetchWithAuth('/api/device-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, platform: 'web', token_type: 'alert' }),
    });
    return reg2.ok;
  } catch {
    return false;
  }
}

/** Unsubscribe locally and tell the backend to drop the token (call on logout). */
export async function unsubscribeWebPush(): Promise<void> {
  if (!webPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const token = JSON.stringify(sub.toJSON());
    await fetchWithAuth('/api/device-tokens', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).catch(() => { /* ignore */ });
    await sub.unsubscribe().catch(() => { /* ignore */ });
  } catch {
    /* ignore */
  }
}
