/* TripSpend service worker — offline app shell.
   App data lives in Firestore's IndexedDB cache, not here. */
const CACHE = 'tripspend-v6';
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './css/styles.css',
  './js/firebase-config.js', './js/store.js', './js/app.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Runtime-cache same-origin assets, Font Awesome and the Firebase SDK so the
// shell loads offline. Firestore's own network traffic is left untouched.
const RUNTIME_OK = url =>
  url.startsWith(self.location.origin) ||
  url.includes('cdnjs.cloudflare.com') ||
  url.includes('gstatic.com/firebasejs');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  // Never intercept Firebase/Google API calls — let them hit the network.
  if (/googleapis\.com|firebaseio\.com|firebasestorage|identitytoolkit|firebaseinstallations/.test(url)) return;
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      if (res.ok && RUNTIME_OK(url)) {
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached))
  );
});
