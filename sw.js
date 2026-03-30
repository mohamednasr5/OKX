// Service Worker — OKX Tracker PWA (Local Storage Only)
const CACHE = 'okx-tracker-v5';
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

  // لا كاش لأي طلب خارجي — دايماً من النت مباشرة
  if (
    url.includes('okx.com') ||
    url.includes('llm7.io') ||
    url.includes('anthropic.com') ||
    url.includes('googleapis.com') ||
    url.includes('gstatic.com') ||
    url.includes('fonts.google')
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  // الـ WebSocket مش بيمر من هنا أصلاً، بس لو حصل ignore
  if (e.request.headers.get('upgrade') === 'websocket') return;

  // باقي الطلبات (static assets): Cache-first ثم Network
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      // أضف للكاش لو كانت static asset
      if (res.ok && e.request.method === 'GET') {
        const resClone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, resClone));
      }
      return res;
    }))
  );
});
