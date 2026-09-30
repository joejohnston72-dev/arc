/**
 * Shared storage layer — IndexedDB as the local-first store, Supabase for
 * cross-device sync. All reads come from IndexedDB (fast, works offline).
 * Writes go to IndexedDB immediately then fire-and-forget to Supabase.
 * On module load (when authenticated) a full pull from Supabase merges any
 * changes made on other devices into the local store.
 */

import { supabase } from './supabase.js';

// Local-only IndexedDB database name. Kept as 'life-dashboard' on purpose even
// after the Arc rename / slug change — renaming it orphans every existing
// install's local data (it would start empty until the Supabase pull restores
// it). It never leaves the device, so the name is invisible to users.
const DB_NAME    = 'life-dashboard';
const DB_VERSION = 1;
const STORES     = ['calories', 'workout', 'habits'];

// ── IndexedDB ─────────────────────────────────────────────────────────────────
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(store, mode);
    const s   = t.objectStore(store);
    const req = fn(s);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function idbGet(store, key)        { return tx(store, 'readonly',  s => s.get(key)); }
function idbSet(store, key, value) { return tx(store, 'readwrite', s => s.put(value, key)); }
function idbDel(store, key)        { return tx(store, 'readwrite', s => s.delete(key)); }
function idbClear(store)           { return tx(store, 'readwrite', s => s.clear()); }

function idbGetAll(store) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const s = t.objectStore(store);
    const results = [];
    const cursor = s.openCursor();
    cursor.onsuccess = e => {
      const c = e.target.result;
      if (c) { results.push({ key: c.key, value: c.value }); c.continue(); }
      else resolve(results);
    };
    cursor.onerror = e => reject(e.target.error);
  }));
}

// Transient, device-local crash-recovery state that must NEVER touch the cloud.
// Syncing it was a bug: after a workout was finished (which clears these locally),
// the next launch's cloud pull could restore a stale copy and re-show the
// "Resume workout in progress?" prompt hours or days later, on any device. These
// keys stay purely on-device — resume is a per-device concept. Keyed "store:key".
const LOCAL_ONLY = new Set(['workout:active-session', 'workout:active-rest']);
const isLocalOnly = (store, key) => LOCAL_ONLY.has(`${store}:${key}`);

// ── Supabase remote ───────────────────────────────────────────────────────────
// Cache the user id. remoteSet used to call auth.getUser() (a network round-trip)
// on EVERY write — during a bulk import of hundreds of sessions that meant
// hundreds of concurrent auth calls, which rate-limited and silently dropped most
// of the cloud writes. Resolve it once and reuse the promise.
// Only a real id is cached. getUser() needed the network, and one failed call
// (opening the app with no signal at the gym) cached null for the life of the
// page — an iOS PWA can stay alive for days, so every write in that time stayed
// on the device. getSession() reads the stored session, and a null is retried.
let _uidPromise = null;
function getUserId() {
  if (!_uidPromise) {
    _uidPromise = supabase.auth.getSession()
      .then(({ data }) => data?.session?.user?.id ?? null)
      .catch(() => null)
      .then(id => { if (!id) _uidPromise = null; return id; });
  }
  return _uidPromise;
}

// Writes that haven't reached the cloud yet, as "store:key". Kept in
// localStorage so they survive a reload. While a key is pending, the cloud pull
// skips it (the cloud copy is older), and flushPending() retries it on the next
// launch, on reconnect and before every backup. Before this, a failed upsert was
// dropped silently and the next pull overwrote the newer local value.
const PENDING_KEY = 'arc-unsynced';
function readPending() {
  try { return new Set(JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')); } catch (_) { return new Set(); }
}
function writePending(set) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify([...set])); } catch (_) {}
}
const _writeSeq = new Map();   // "store:key" → latest write number, so an older write finishing can't clear a newer one
function markPending(id) { const p = readPending(); p.add(id); writePending(p); const n = (_writeSeq.get(id) || 0) + 1; _writeSeq.set(id, n); return n; }
function clearPending(id, n) {
  if (n != null && _writeSeq.get(id) !== n) return;
  const p = readPending(); if (p.delete(id)) writePending(p);
}

async function remoteSet(store, key, value) {
  if (isLocalOnly(store, key)) return;   // device-local crash-recovery state — never sync
  const id = `${store}:${key}`;
  const n = markPending(id);
  const user_id = await getUserId();
  if (!user_id) return;
  try {
    const { error } = await supabase.from('entries').upsert({ user_id, store, key, value });
    if (!error) clearPending(id, n);
  } catch (_) {}
}

async function remoteDel(store, key) {
  const id = `${store}:${key}`;
  const n = markPending(id);
  const user_id = await getUserId();
  if (!user_id) return;
  try {
    const { error } = await supabase.from('entries').delete()
      .eq('user_id', user_id).eq('store', store).eq('key', key);
    if (!error) clearPending(id, n);
  } catch (_) {}
}

// Retry every pending write: upsert the current local value, or delete the
// cloud row if the key is gone locally. Returns the number still pending.
let _flushing = null;
function flushPending() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    const user_id = await getUserId();
    if (!user_id) return readPending().size;
    for (const id of readPending()) {
      const i = id.indexOf(':');
      const store = id.slice(0, i), key = id.slice(i + 1);
      if (!STORES.includes(store)) { clearPending(id); continue; }
      const n = _writeSeq.get(id);
      try {
        const value = await idbGet(store, key);
        const { error } = value === undefined
          ? await supabase.from('entries').delete().eq('user_id', user_id).eq('store', store).eq('key', key)
          : await supabase.from('entries').upsert({ user_id, store, key, value });
        if (!error) clearPending(id, n);
      } catch (_) {}
    }
    return readPending().size;
  })().finally(() => { _flushing = null; });
  return _flushing;
}
if (typeof window !== 'undefined') window.addEventListener('online', () => { flushPending(); });

// Pull the cloud copy into IndexedDB. PAGINATED — PostgREST caps a select at
// 1000 rows, and the `entries` table holds every store (workout + calories + …),
// so an un-paged pull silently dropped rows once the account grew past 1000.
// That's exactly how history "vanished" while the few routine rows survived.
async function syncFromSupabase() {
  const user_id = await getUserId();
  if (!user_id) return 0;
  const PAGE = 1000;
  const pending = readPending();
  let from = 0, total = 0;
  for (;;) {
    const { data, error } = await supabase.from('entries')
      .select('store, key, value')
      .eq('user_id', user_id)
      .order('store', { ascending: true })
      .order('key',   { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || !data.length) break;
    for (const row of data) {
      // Skip rows for stores this DB doesn't have (e.g. leftover 'finance' rows
      // from a removed module). Writing to a non-existent object store throws
      // "object store not found" and would abort the WHOLE restore — that's what
      // was wiping out the workout rows. Also guard each write so one bad row
      // can never take down the batch.
      if (!STORES.includes(row.store)) continue;
      // Never let a stale cloud copy resurrect device-local resume state.
      if (isLocalOnly(row.store, row.key)) continue;
      // A local write that hasn't reached the cloud is newer than this row.
      if (pending.has(`${row.store}:${row.key}`)) continue;
      try { await idbSet(row.store, row.key, row.value); } catch (_) {}
    }
    total += data.length;
    if (data.length < PAGE) break;
    from += PAGE;
  }
  flushPending();   // now push up whatever the device still holds that the cloud doesn't
  return total;
}

// Push EVERYTHING in local IndexedDB up to the cloud, batched — a reliable
// "back up now" that also repairs any rows that failed to sync during a bulk
// import. Returns the number of rows written.
async function syncToSupabase() {
  const user_id = await getUserId();
  if (!user_id) return 0;
  await flushPending();   // deletes only reach the cloud through here
  let n = 0;
  for (const store of STORES) {
    let rows;
    try { rows = await idbGetAll(store); } catch (_) { continue; }
    const payload = rows
      .filter(({ key }) => !isLocalOnly(store, key))   // don't back up transient resume state
      .map(({ key, value }) => ({ user_id, store, key, value }));
    for (let i = 0; i < payload.length; i += 200) {
      const chunk = payload.slice(i, i + 200);
      const { error } = await supabase.from('entries').upsert(chunk);
      if (!error) n += chunk.length;
    }
  }
  return n;
}

// Initial cloud pull, kicked off at import time but exposed as a PROMISE so the
// app can wait for it before its first render. Critical for reinstalls / cleared
// browsers: iOS wipes a PWA's IndexedDB when its home-screen icon is removed, so
// a fresh launch starts empty — without awaiting this, the UI paints empty and
// looks like all history was lost even though the cloud copy is intact.
// Resolves to the number of rows restored (0 if no session / nothing to pull).
export const initialSync = supabase.auth.getSession()
  .then(({ data: { session } }) => (session ? syncFromSupabase() : 0))
  .catch(() => 0);

// ── Public API (same interface as before) ─────────────────────────────────────
const db = {
  get:    idbGet,
  getAll: idbGetAll,

  async set(store, key, value) {
    await idbSet(store, key, value);
    remoteSet(store, key, value);
  },

  async delete(store, key) {
    await idbDel(store, key);
    remoteDel(store, key);
  },

  clear:  idbClear,
  sync:   syncFromSupabase,   // cloud → device (paginated)
  backup: syncToSupabase,     // device → cloud (batched)
  flush:  flushPending,       // retry writes that didn't reach the cloud; → count still pending
  pendingCount: () => readPending().size,
};

export default db;
