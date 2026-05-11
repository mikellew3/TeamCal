// MGH PA Team Calendar — service worker.
// Strategies:
//   - HTML / API: network-first, fall back to cache for HTML so the app shell
//     still loads offline.
//   - Static assets (icons, manifest, fonts): cache-first.
// Bump CACHE_VERSION on any breaking change to force a refresh on all clients.

const CACHE_VERSION = 'pa-cal-v9';
const SHELL = [
  '/index.html',
  '/login.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Never cache API responses; let them hit the network.
  if (sameOrigin && url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 503 })));
    return;
  }

  const isHtml = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');
  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (sameOrigin && res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data?.text() || 'Update' }; }
  const title = data.title || 'PA Calendar';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'pa-cal',
    data: { entryId: data.entryId, url: data.url || '/index.html' },
    requireInteraction: false,
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let url = data.url || '/index.html';
  if (data.entryId && !url.includes('entry=')) {
    url = `/index.html?entry=${encodeURIComponent(data.entryId)}`;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
