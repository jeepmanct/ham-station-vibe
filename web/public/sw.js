// Web Push service worker -- registered only from /admin's "Enable on this
// device" flow (see admin.astro), not site-wide, since only the site owner
// has any reason to subscribe. Scope is the site root by default (file
// lives at /sw.js), which is what lets a push arrive regardless of which
// page happens to be open when it fires.

self.addEventListener('push', (event) => {
  let data = { title: 'HamStation Alert', body: '' };
  try {
    if (event.data) data = event.data.json();
  } catch {
    if (event.data) data.body = event.data.text();
  }
  const title = data.title || 'HamStation Alert';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    }),
  );
});
