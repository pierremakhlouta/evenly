/*
 * Evenly service worker: caches the app shell only (HTML, scripts, styles, icons) so
 * the app opens without a connection. It never caches data: requests to the
 * database are on another origin and are not touched, so balances are always live.
 *
 * - Pages: network first, falling back to the cached page when offline.
 * - Built assets (/assets/, hashed file names): cache first; they never change.
 * - Other same-origin files (icons, manifest): stale while revalidate.
 */
const CACHE = 'evenly-shell-v1';
const SHELL = [
  './',
  './manifest.webmanifest',
  './icon.svg',
  './apple-touch-icon.png',
  './icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});

// ---------------------------------------------------------------------------
// Push notifications. The payload is {title, body, tag, url}, built by the
// database; a newer notification about the same entry replaces the older one.
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Evenly', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: new URL(data.url || './', self.registration.scope).href },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      return open ? open.focus() : self.clients.openWindow(url);
    }),
  );
});
