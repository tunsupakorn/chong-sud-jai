// Chong Sud Jai service worker: network-first for the app's own files, cache as offline fallback,
// plus the Android share target ("Share → ชงสุดใจ") for slip images and PDFs.
importScripts('version.js'); // self.APP_VERSION
const CACHE = 'kaa-' + self.APP_VERSION;
const SHARE = 'kaa-share';
const SHELL = ['./', 'index.html', 'version.js', 'styles.css', 'app.js', 'store.js', 'gemini.js', 'charts.js', 'sheets.js', 'qr.js', 'promptpay.js', 'guide.html',
  'firebase-config.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Files shared to the app arrive as a POST; park them in a cache and open the app, which picks them up.
async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter(f => f && typeof f === 'object' && f.size);
  const cache = await caches.open(SHARE);
  let i = 0;
  for (const f of files) {
    await cache.put(`shared/${Date.now()}-${i++}`, new Response(f, {
      headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `slip-${i}.jpg`) },
    }));
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request).catch(() => Response.redirect(new URL('./', self.registration.scope).href, 303)));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Firebase/Gemini/Apps Script go straight to network
  // 'no-cache' revalidates with the server, so a new version is picked up at once (not after the 10-min HTTP cache)
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

// ---- notifications: new LINE order / slip (Web Push without payload) ----
// the push wakes this worker; the text is fetched from the shop's Worker by a hash of this device's subscription
const LINE_API = 'https://jukjik-kaa-line.jukjik-kaa.workers.dev';
async function subId(endpoint) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msg = { title: '💚 ชงสุดใจ', body: 'มีออเดอร์ LINE ใหม่ แตะเพื่อดู' };
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) { const r = await fetch(`${LINE_API}/push/peek/${await subId(sub.endpoint)}`, { cache: 'no-store' }); if (r.ok) msg = await r.json(); }
    } catch {}
    await self.registration.showNotification(msg.title, { body: msg.body, tag: msg.tag || 'kaa-order', renotify: true,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: [200, 100, 200, 100, 200], requireInteraction: true });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find(w => new URL(w.url).pathname.startsWith(new URL(self.registration.scope).pathname) && !w.url.includes('/liff/'));
    if (app) { await app.focus(); app.postMessage({ go: 'orders' }); return; }
    await self.clients.openWindow(new URL('./?view=orders', self.registration.scope).href);
  })());
});
