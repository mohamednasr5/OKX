// Service Worker - OKX Tracker PWA
const CACHE = 'okx-tracker-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('okx.com') || e.request.url.includes('llm7.io') || e.request.url.includes('fonts.googleapis')) {
    return; // never cache API calls
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
