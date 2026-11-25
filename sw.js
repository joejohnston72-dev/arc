const CACHE = 'arc-v99';
// Pinned supabase-js (keep in sync with shared/supabase.js). Every module the app
// imports must be in the cache or the whole app fails to start with no signal.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';
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
  './workout/splits.js',
  './workout/stats.js',
  './workout/achievements.js',
  './workout/records.js',
  './workout/streak.js',
  './workout/coach.js',
  './workout/exportData.js',
  './workout/categorize.js',
  './workout/workingSet.js',
  './workout/manifest.json',
  './workout/icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).then(() => c.add(new Request(SUPABASE_JS, { mode: 'cors' })).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // Only prune ARC's own caches: the github.io origin is shared with ARC Fuel
      // (calorieai-*), whose offline cache must survive an ARC update.
      .then(keys => Promise.all(keys.filter(k => (k.startsWith('arc-') || k.startsWith('life-dashboard-')) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try the network so deployed updates land immediately.
// Fall back to cache only when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Pinned CDN files never change, so serve them cache-first. The imports inside
  // the supabase-js bundle are cached the first time they load online.
  if (url.origin === CDN_ORIGIN) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
        return res;
      }))
    );
    return;
  }
  if (url.origin !== self.location.origin) return; // don't intercept Supabase API calls

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
        // Only cache good responses: a 404/5xx (e.g. a Pages hiccup mid-deploy)
        // would otherwise replace the working offline copy.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })
        // ".../workout/" (the start_url) is only precached as ".../workout/index.html".
        .then(hit => hit || (url.pathname.endsWith('/') ? caches.match(url.origin + url.pathname + 'index.html') : undefined)))
  );
});
