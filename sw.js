const CACHE = 'arc-v65';
// Paths are RELATIVE to this service worker's URL (its own directory is the SW
// scope), so they resolve correctly whatever the repo/deploy slug is —
// /life-dashboard/ today, /arc/ once the GitHub repo is renamed — with no code
// change and no breakage window.
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './shared/db.js',
  './shared/supabase.js',
  './shared/suggestions.js',
  './shared/icons.js',
  './manifest.json',
  './icon.png',
  './workout/index.html',
  './workout/app.js',
  './workout/exercises.js',
  './workout/repRanges.js',
  './workout/cues.js',
  './workout/routineLibrary.js',
  './workout/myRoutines.js',
  './workout/stats.js',
  './workout/achievements.js',
  './workout/coach.js',
  './workout/manifest.json',
  './workout/icon.png',
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
