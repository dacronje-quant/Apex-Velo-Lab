// APEX VELO // LAB service worker - network-first for app files so updates are never
// masked by a stale cache; the cache is only a fallback when offline.
const CACHE_NAME = 'apex-velo-cache-v10';
const CORE = [
  './', './index.html', './manifest.json', './css/style.css',
  './data/divan_cycling_history.js',
  './js/velo-metrics.js', './js/velo-db.js', './js/velo-sound.js', './js/velo-pip.js', './js/velo-folder-sync.js',
  './js/velo-biomech.js', './js/velo-analytics.js', './js/velo-workouts.js', './js/velo-ai-architect.js',
  './js/velo-ai-coach.js', './js/velo-block-planner.js', './js/velo-sim.js', './js/velo-ble.js', './js/velo-erg.js', './js/velo-importer.js', './js/velo-export.js',
  './js/velo-clock.js', './js/velo-progress.js', './js/app.js', './js/app-analytics.js', './js/app-history.js', './js/app-coach.js', './js/app-block.js', './js/app-strava.js', './js/app-remote.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache the local coach API (/api/*) or cross-origin calls other than the Chart.js / font CDNs.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  const cacheableCdn = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (url.origin !== self.location.origin && !cacheableCdn) return;
  e.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && (resp.ok || resp.type === 'opaque')) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
