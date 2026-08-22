const CACHE = 'life-dashboard-v60';
const PRECACHE = [
  '/life-dashboard/',
  '/life-dashboard/index.html',
  '/life-dashboard/styles.css',
  '/life-dashboard/shared/db.js',
  '/life-dashboard/shared/supabase.js',
  '/life-dashboard/shared/suggestions.js',
  '/life-dashboard/shared/icons.js',
  '/life-dashboard/manifest.json',
  '/life-dashboard/icon.png',
  '/life-dashboard/workout/index.html',
  '/life-dashboard/workout/app.js',
  '/life-dashboard/workout/exercises.js',
  '/life-dashboard/workout/repRanges.js',
  '/life-dashboard/workout/cues.js',
  '/life-dashboard/workout/routineLibrary.js',
  '/life-dashboard/workout/myRoutines.js',
  '/life-dashboard/workout/stats.js',
  '/life-dashboard/workout/achievements.js',
  '/life-dashboard/workout/coach.js',
  '/life-dashboard/workout/manifest.json',
  '/life-dashboard/workout/icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try the network so deployed updates land immediately.
// Fall back to cache only when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // don't intercept Supabase/CDN

  // Bypass the browser HTTP cache so freshly deployed files land immediately,
  // not after GitHub Pages' ~10-minute max-age expires.
  const req = new Request(e.request.url, {
    method: 'GET',
    headers: e.request.headers,
    mode: e.request.mode === 'navigate' ? 'same-origin' : e.request.mode,
    credentials: e.request.credentials,
    cache: 'no-cache',
  });

  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
