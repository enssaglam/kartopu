const CACHE_NAME = 'kartopu-v5';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './logos/doas.png',
  './logos/tuprs.png',
  './logos/aksa.png',
  './logos/schd.png',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) { return cache.addAll(ASSETS); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(event) {
  const url = event.request.url;
  if (url.indexOf('frankfurter.app') !== -1 || url.indexOf('/api/quotes') !== -1 || url.indexOf('/.netlify/functions/') !== -1) {
    event.respondWith(
      fetch(event.request).catch(function() { return caches.match(event.request); })
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(function(cached) { return cached || fetch(event.request); })
  );
});
