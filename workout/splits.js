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
