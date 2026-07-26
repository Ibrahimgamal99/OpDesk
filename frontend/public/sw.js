/**
 * OpDesk service worker.
 *
 * Scope: enable incoming-call notifications while the browser tab is backgrounded
 * (but still alive) via registration.showNotification(), route a notification tap
 * back to the app, AND — when Web Push (VAPID) is configured — wake a fully closed
 * tab via the `push` event and relay the payload to any open tab.
 */

// Activate immediately so notifications work on the first load without a reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Web Push: a message arrived from the server. Relay to open tabs (so a live app can
// ring immediately) and, for incoming calls, also show a notification.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_e) { payload = {}; }
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'opdesk:incoming-call', payload });
    }
    if (payload.type === 'incoming_call') {
      const title = payload.display_name || payload.caller || 'Incoming call';
      await self.registration.showNotification(title, {
        body: 'Incoming call',
        tag: payload.call_id || 'opdesk-call',
        data: payload,
        requireInteraction: true,
      });
    } else if (payload.type === 'alert') {
      await self.registration.showNotification(payload.title || 'OpDesk', {
        body: payload.body || '',
        data: payload,
      });
    }
  })());
});

// Rotated subscription — ask an open tab to re-subscribe and re-register.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({ type: 'opdesk:resubscribe' });
    }
  })());
});

// Tapping a notification focuses an existing app tab (relaying the action), or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        client.postMessage({ type: 'opdesk:notification-action', payload: data });
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
