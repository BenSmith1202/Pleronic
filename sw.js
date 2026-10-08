const CACHE_NAME = 'pleronic-v30';
const ASSETS = [
  './',
  './index.html',
  './README.md',
  './app.mjs',
  './github.mjs',
  './obsidian.mjs',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './vendor/marked.esm.js',
  './vendor/idb-keyval.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys 
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('api.github.com')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok && event.request.url.startsWith(self.location.origin)) {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .catch((error) => console.error('Could not cache a fetched asset:', error));
        }
        return response;
      }).catch((error) => {
        // Only document navigations may fall back to the app shell; scripts and images must fail as themselves.
        if (event.request.mode !== 'navigate') throw error;
        return caches.match('./index.html').then((fallback) => {
          if (!fallback) throw error;
          return fallback;
        });
      });
    })
  );
});
