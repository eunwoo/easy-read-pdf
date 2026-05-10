// Easy Read PDF — Service Worker
// Caches the app shell so it works offline after first visit.

const CACHE_NAME = 'easy-read-pdf-v16';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './pdf.js',
  './pdf.worker.patched.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// CDN resources we'd like to cache opportunistically
const CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Some entries (icons) might 404 on first deploy; don't fail install
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('SW: skip cache', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Strategy: cache-first for app shell, stale-while-revalidate for CDN.
  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (CDN_HOSTS.includes(url.host)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Default: try network, fall back to cache
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    return caches.match('./index.html');
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}
