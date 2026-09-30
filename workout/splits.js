// Splits & workouts — the training-plan model. Pure functions, no DOM / db.
//
// Naming (used everywhere — UI, code, coach prompts):
//   Workout — one planned session: { id, name, exercises:[{ name, category, restTime, sets }] }
//   Split   — an ORDERED list of workouts: { id, name, source, workouts:[…] }
//   Active split — the one split being run (only ever one). Key 'active-split'.
//   Session — one logged run of a workout ('session-<id>'); carries splitId +
//             workoutId when it was started from a split workout.
//
// Next workout = the one after the most recently logged session of the active
// split, in split order, wrapping. Nothing logged yet → the first. Order is the
// only rule: no recovery/overdue scoring.

// Session timestamp — startTime first so two sessions on the same date order
// correctly; falls back to the bare date.
export function sessionTs(s) {
  const t = Date.parse(s?.startTime || '') || Date.parse(s?.date || '');
  return isNaN(t) ? 0 : t;
}

// Index of the split workout a session ran, or -1. Tagged sessions match by
// workoutId alone (ids are unique, and a workout MOVED to another split keeps
// its id, so its history follows it); legacy untagged sessions (logged before
// splits existed) fall back to an exact title match.
export function sessionWorkoutIndex(s, split) {
  const ws = split?.workouts || [];
  if (s?.workoutId) return ws.findIndex(w => w.id === s.workoutId);
  const title = (s?.title || '').trim();
  return title ? ws.findIndex(w => w.name.trim() === title) : -1;
}

// → { workout, index, lastTsById: Map<workoutId, ts>, lastIndex } or null.
export function nextWorkout(split, sessions) {
  const ws = split?.workouts || [];
  if (!ws.length) return null;
  const lastTsById = new Map();
  let lastIndex = -1, lastTs = -1;
  for (const s of sessions || []) {
    const i = sessionWorkoutIndex(s, split);
    if (i < 0) continue;
    const ts = sessionTs(s);
    const id = ws[i].id;
    if (!(lastTsById.get(id) >= ts)) lastTsById.set(id, ts);
    if (ts > lastTs) { lastTs = ts; lastIndex = i; }
  }
  const index = lastIndex < 0 ? 0 : (lastIndex + 1) % ws.length;
  return { workout: ws[index], index, lastIndex, lastTsById };
}

// Plan-tab value for a day the user marked as rest (stored in `week-plan` in
// place of a workout id).
export const REST_DAY = 'rest';

// Fill the Plan week from the active split. Walks each day from `today` to
// `until` (YYYY-MM-DD, inclusive):
//   - a day with a logged session is done — the split order already counts it;
//   - a rest day gets nothing, so the rest of the split moves back one day;
//   - a day the user assigned keeps that workout, and the rotation carries on
//     after it if it's in the split;
//   - any other day gets the next workout in split order.
// → { 'YYYY-MM-DD': { rest:true } | { workoutId, auto } } for today onward
// (days with a session are left out). Past days aren't projected.
export function projectPlan({ split, sessions, planMap, today, until }) {
  const out = {};
  const ws = split?.workouts || [];
  const loggedDays = new Set((sessions || []).map(s => s.date || (s.startTime || '').slice(0, 10)));
  let idx = nextWorkout(split, sessions)?.index ?? 0;
  for (let ds = today; ds <= until; ds = addDays(ds, 1)) {
    if (loggedDays.has(ds)) continue;
    const v = planMap?.[ds];
    if (v === REST_DAY) { out[ds] = { rest: true }; continue; }
    if (v) {
      out[ds] = { workoutId: v, auto: false };
      const i = ws.findIndex(w => w.id === v);
      if (i >= 0) idx = i + 1;
      continue;
    }
    if (!ws.length) continue;
    out[ds] = { workoutId: ws[idx % ws.length].id, auto: true };
    idx++;
  }
  return out;
}

// 'YYYY-MM-DD' + n days (calendar arithmetic at local noon — DST-safe).
export function addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  const x = new Date(y, m - 1, d + n, 12);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// Deep-ish copy of a workout's exercises (library/coach data must never be
// shared by reference with stored splits).
// Plan-tab assignments are `{ 'YYYY-MM-DD': workoutId }`. Deleting a workout
// (or its whole split) left every day assigned to it pointing at an id that no
// longer resolves, so the day silently fell back to "Open" and the planned week
// quietly emptied. This returns the map with those days dropped. Pure, so the
// callers decide when to persist — and a MOVE between splits keeps the id, so it
// must not come through here.
export function pruneWeekPlan(map, removedIds) {
  const gone = new Set(removedIds || []);
  const out = {};
  let changed = false;
  for (const [date, id] of Object.entries(map || {})) {
    if (gone.has(id)) { changed = true; continue; }
    out[date] = id;
  }
  return { map: out, changed };
}

// Before splits existed, the coach's "Save all routines" wrote each day of a
// drafted split into the flat templates list, so the migration scattered them:
// days named like a My-split day lost to the original ("My 5-Day Split" takes
// the first template of a name), the rest went to a library split or "Other
// workouts", and the coach's split name was lost. This regroups them.
//   drafts — coach-drafted splits, newest first: [{ name, routines:[{ name, exercises }] }]
// A day matches a stored workout outside "My 5-Day Split" (the originals stay
// put) with the same name, preferring one with the same exercise list. A draft is restored only when
// every day matches (so it was actually saved). Matched workouts MOVE (ids kept,
// so logged sessions and Plan days follow them); splits left empty are dropped.
// → { splits, restored:[split] }. Pure: never mutates its inputs.
export function recoverCoachSplits(splits, drafts, { uid }) {
  let out = (splits || []).map(sp => ({ ...sp, workouts: [...(sp.workouts || [])] }));
  const restored = [];
  const exKey = exs => (exs || []).map(e => (e.name || '').trim().toLowerCase()).join('|');
  const nm = s => (s || '').trim().toLowerCase();
  const seen = new Set();
  for (const d of drafts || []) {
    const routines = d?.routines || [];
    const name = (d?.name || '').trim();
    if (!name || !routines.length || seen.has(nm(name))) continue;
    seen.add(nm(name));
    if (out.some(sp => sp.source === 'coach' && nm(sp.name) === nm(name))) continue;   // already a split
    const claimed = new Set();
    const find = pred => {
      for (const sp of out) for (const w of sp.workouts) if (!claimed.has(w.id) && pred(sp, w)) return w;
      return null;
    };
    const picks = [];
    for (const r of routines) {
      const w = find((sp, w) => sp.source !== 'my' && nm(w.name) === nm(r.name) && exKey(w.exercises) === exKey(r.exercises))
             || find((sp, w) => sp.source !== 'my' && nm(w.name) === nm(r.name));
      if (!w) break;
      claimed.add(w.id); picks.push(w);
    }
    if (picks.length !== routines.length) continue;
    out = out.map(sp => ({ ...sp, workouts: sp.workouts.filter(w => !claimed.has(w.id)) }))
             .filter(sp => sp.workouts.length || !['other', 'library'].some(p => (sp.source || '').startsWith(p)));
    const sp = { id: uid(), name, source: 'coach', workouts: picks };
    out.push(sp);
    restored.push(sp);
  }
  return { splits: out, restored };
}

export function copyExercises(exercises) {
  return (exercises || []).map(e => ({
    ...e,
    sets: (e.sets || []).map(s => ({ ...s })),
  }));
}

// One-time migration: the old flat `templates` list → splits.
//   1. MY_ROUTINES names → "My 5-Day Split" (in MY_ROUTINES order).
//   2. Names matching a library split's workouts → that split (library order);
//      the library split with the most matches claims shared names first.
//   3. Anything left → "Other workouts".
// Workout ids reuse the template ids so week-plan assignments keep resolving.
// Active: the split holding the most recently logged workout, else My split,
// else the first.
export function buildSplitsFromTemplates(templates, { myRoutines = [], library = [], sessions = [], uid }) {
  const pool = [...(templates || [])];
  const take = name => {
    const i = pool.findIndex(t => t.name.trim() === name.trim());
    return i < 0 ? null : pool.splice(i, 1)[0];
  };
  const toWorkout = t => ({ id: t.id || uid(), name: t.name, exercises: t.exercises || [] });
  const splits = [];

  const mine = myRoutines.map(d => take(d.name)).filter(Boolean);
  if (mine.length) splits.push({ id: uid(), name: 'My 5-Day Split', source: 'my', workouts: mine.map(toWorkout) });

  const libs = library
    .map(L => ({ L, n: L.days.filter(d => pool.some(t => t.name.trim() === d.name.trim())).length }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n);
  for (const { L } of libs) {
    const ws = L.days.map(d => take(d.name)).filter(Boolean);
    if (ws.length) splits.push({ id: uid(), name: L.name, source: `library:${L.id}`, workouts: ws.map(toWorkout) });
  }

  if (pool.length) splits.push({ id: uid(), name: 'Other workouts', source: 'other', workouts: pool.map(toWorkout) });

  let activeId = null, best = -1;
  for (const sp of splits) {
    if (sp.source === 'other') continue;
    const r = nextWorkout(sp, sessions);
    const ts = r && r.lastIndex >= 0 ? r.lastTsById.get(sp.workouts[r.lastIndex].id) : -1;
    if (ts > best) { best = ts; activeId = sp.id; }
  }
  if (!activeId) activeId = (splits.find(s => s.source === 'my') || splits.find(s => s.source !== 'other') || splits[0])?.id || null;
  return { splits, activeId };
}
