'use strict';

const CACHE_VERSION = 'v11';
const CACHE_NAME = `escoresheet-${CACHE_VERSION}`;

const CORE_ASSETS = [
  '/escoresheet/',
  '/escoresheet/index.html',
  '/escoresheet/manifest.json',
  '/escoresheet/css/app.css',
  '/escoresheet/js/app.js',
  '/escoresheet/icons/icon-192.png',
  '/escoresheet/icons/icon-512.png',
  '/escoresheet/icons/icon-512-maskable.png',
  '/escoresheet/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell, with runtime caching of anything new fetched
// while online — keeps the shell installable/offline without a network round
// trip on every load, per the whole point of this app.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
