const CACHE_NAME = 'pgjps-v4';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/admin.html',
  '/teacher.html',
  '/tabulation.html',
  '/appearance.html',
  '/firebase-config.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for Firebase calls and app HTML/JS (so deploys aren't stuck behind stale cache),
// cache-first for static assets (icons, manifest, logo).
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go network for Firebase / auth requests
  if (url.hostname.includes('firebase') || url.hostname.includes('google')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  const isAppShell = url.origin === self.location.origin &&
    (e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js'));

  if (isAppShell) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res && res.status === 200 && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      }
      return res;
    }))
  );
});
