/* Service worker – offline cache pro PWA „Rytíři a Nemrtví" */
const CACHE = 'rytiri-v25';
const SHELL = [
  './',
  './index.html',
  './data.js?v=25',
  './engine.js?v=25',
  './game.js?v=25',
  './net.js?v=25',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network-first: online vždy nejnovější verze; offline se použije cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
