// Service Worker — OKX Tracker PWA (Local Storage Only)
const CACHE = 'okx-tracker-v4';
const ASSETS = ['./', './app.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // لا تكاش API calls أبداً — دايماً اجلبها من النت
  if (
    url.includes('okx.com') ||
    url.includes('llm7.io') ||
    url.includes('anthropic.com') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('fonts.google')
  ) return;

  // باقي الطلبات: Cache-first ثم Network
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
