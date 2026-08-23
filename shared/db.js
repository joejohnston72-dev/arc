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

// ── Supabase remote ───────────────────────────────────────────────────────────
// Cache the user id. remoteSet used to call auth.getUser() (a network round-trip)
// on EVERY write — during a bulk import of hundreds of sessions that meant
// hundreds of concurrent auth calls, which rate-limited and silently dropped most
// of the cloud writes. Resolve it once and reuse the promise.
let _uidPromise = null;
function getUserId() {
  if (!_uidPromise) {
    _uidPromise = supabase.auth.getUser()
      .then(({ data }) => data?.user?.id ?? null)
      .catch(() => null);
  }
  return _uidPromise;
}

async function remoteSet(store, key, value) {
  const user_id = await getUserId();
  if (!user_id) return;
  await supabase.from('entries').upsert({ user_id, store, key, value });
}

async function remoteDel(store, key) {
  const user_id = await getUserId();
  if (!user_id) return;
  await supabase.from('entries').delete()
    .eq('user_id', user_id).eq('store', store).eq('key', key);
}

// Pull the cloud copy into IndexedDB. PAGINATED — PostgREST caps a select at
// 1000 rows, and the `entries` table holds every store (workout + calories + …),
// so an un-paged pull silently dropped rows once the account grew past 1000.
// That's exactly how history "vanished" while the few routine rows survived.
async function syncFromSupabase() {
  const user_id = await getUserId();
  if (!user_id) return 0;
  const PAGE = 1000;
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
      try { await idbSet(row.store, row.key, row.value); } catch (_) {}
    }
    total += data.length;
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return total;
}

// Push EVERYTHING in local IndexedDB up to the cloud, batched — a reliable
// "back up now" that also repairs any rows that failed to sync during a bulk
// import. Returns the number of rows written.
async function syncToSupabase() {
  const user_id = await getUserId();
  if (!user_id) return 0;
  let n = 0;
  for (const store of STORES) {
    let rows;
    try { rows = await idbGetAll(store); } catch (_) { continue; }
    const payload = rows.map(({ key, value }) => ({ user_id, store, key, value }));
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
};

export default db;
