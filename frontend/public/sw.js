/**
 * OpDesk service worker.
 *
 * Scope: enable incoming-call notifications while the browser tab is backgrounded
 * (but still alive) via registration.showNotification(), and route a notification
 * tap back to the app. There is intentionally NO push handler here — waking a fully
 * frozen/closed tab requires Web Push (VAPID), which is out of scope for this build.
 */

// Activate immediately so notifications work on the first load without a reload.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Tapping the incoming-call notification focuses an existing app tab, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
