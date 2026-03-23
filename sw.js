// Service Worker — OKX Tracker PWA
const CACHE = 'okx-tracker-v3';
const ASSETS = ['./', './index.html', './app.js', './manifest.json'];

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
  // لا تكاش API calls أبداً
  if (
    e.request.url.includes('okx.com') ||
    e.request.url.includes('llm7.io') ||
    e.request.url.includes('anthropic.com') ||
    e.request.url.includes('firebaseio.com') ||
    e.request.url.includes('googleapis.com') ||
    e.request.url.includes('gstatic.com') ||
    e.request.url.includes('fonts.google')
  ) return;

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
