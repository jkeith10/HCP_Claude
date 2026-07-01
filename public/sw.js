// Minimal service worker: caches the static shell so the app is installable
// and loads fast. API calls are always network (never cached).
const CACHE = 'hvac-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache API traffic.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  // Network-first: always try to fetch the latest, fall back to cache offline.
  // This guarantees new deploys (e.g. updated app.js) show up immediately
  // instead of being pinned to a stale cached copy.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
