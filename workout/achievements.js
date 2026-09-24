// Personal bests, milestones and the weekly streak.
// Pure functions over session records + a small settings blob in db.
import db from '../shared/db.js';

const STORE = 'workout';

export const e1RM = (w, r) => (r > 0 ? w * (1 + r / 30) : w); // Epley

// A drop set is a continuation of the set before it (lighter weight, to failure),
// not a standalone effort — so it never counts toward PBs/records, same as warmups.
const isWorkingSet = s => s && s.done && (s.weight || 0) > 0 && s.type !== 'warmup' && s.type !== 'dropset';

// ── Records ───────────────────────────────────────────────────────────────────
// Build per-exercise all-time records from past sessions.
// -> { [name]: { maxWeight, maxE1rm, repsAtWeight: {weight: bestReps} } }
export function buildRecords(sessions, excludeId = null) {
  const rec = {};
  for (const s of sessions) {
    if (!s?.exercises || s.id === excludeId) continue;
    for (const ex of s.exercises) {
      const r = (rec[ex.name] ||= { maxWeight: 0, maxE1rm: 0, repsAtWeight: {} });
      for (const set of ex.sets || []) {
        if (!isWorkingSet(set)) continue;
        if (set.weight > r.maxWeight) r.maxWeight = set.weight;
        const est = e1RM(set.weight, set.reps || 1);
        if (est > r.maxE1rm) r.maxE1rm = est;
        const key = String(set.weight);
        if ((set.reps || 0) > (r.repsAtWeight[key] || 0)) r.repsAtWeight[key] = set.reps || 0;
      }
    }
  }
  return rec;
}

// Detect PBs for one just-completed set vs the records map. Returns [] or PB list.
export function detectPBs(exName, set, records) {
  if (!isWorkingSet(set)) return [];
  const r = records[exName];
  const pbs = [];
  if (!r) return pbs; // first ever session of this exercise — no baseline, no fanfare
  if (set.weight > r.maxWeight) {
    pbs.push({ exercise: exName, type: 'weight', label: `${set.weight} kg — heaviest ever` });
  } else if ((set.reps || 0) > (r.repsAtWeight[String(set.weight)] || 0) && r.repsAtWeight[String(set.weight)]) {
    pbs.push({ exercise: exName, type: 'reps', label: `${set.reps} reps @ ${set.weight} kg — rep PB` });
  }
  const est = e1RM(set.weight, set.reps || 1);
  if (r.maxE1rm && est > r.maxE1rm && !pbs.some(p => p.type === 'weight')) {
    pbs.push({ exercise: exName, type: 'e1rm', label: `Est. 1RM ${Math.round(est)} kg — new best` });
  }
  return pbs;
}

// Live-update a records map after a PB so repeated sets don't re-trigger.
export function absorbSet(exName, set, records) {
  if (!isWorkingSet(set)) return;
  const r = (records[exName] ||= { maxWeight: 0, maxE1rm: 0, repsAtWeight: {} });
  if (set.weight > r.maxWeight) r.maxWeight = set.weight;
  const est = e1RM(set.weight, set.reps || 1);
  if (est > r.maxE1rm) r.maxE1rm = est;
  const key = String(set.weight);
  if ((set.reps || 0) > (r.repsAtWeight[key] || 0)) r.repsAtWeight[key] = set.reps || 0;
}

// ── Weekly streak ─────────────────────────────────────────────────────────────
export async function getStreakSettings() {
  const s = (await db.get(STORE, 'streak-settings')) || {};
  return { seed: s.seed || 0, seedDate: s.seedDate || null, target: s.target || 3 };
}
export async function saveStreakSettings(settings) {
  await db.set(STORE, 'streak-settings', settings);
}

// Local YYYY-MM-DD. Not toISOString(): that's UTC, which at UTC+13/+14 turns local
// noon into the previous day and shifts every week key off Monday.
export const ymd = x =>
  `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

function mondayOf(d) {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - day);
  return ymd(x);
}
function weekBefore(mondayIso) {
  const x = new Date(mondayIso + 'T12:00:00');
  x.setDate(x.getDate() - 7);
  return ymd(x);
}

// Consecutive weeks (ending now) with >= target workouts. The in-progress week
// counts if already met, and never breaks the chain while pending. If the
// unbroken chain reaches back to the week the seed was set, the seed is added.
export function computeStreak(sessions, { seed = 0, seedDate = null, target = 3 } = {}) {
  const counts = {};
  for (const s of sessions) {
    const d = s.date || (s.startTime || '').slice(0, 10);
    if (!d) continue;
    const wk = mondayOf(new Date(d + 'T12:00:00'));
    counts[wk] = (counts[wk] || 0) + 1;
  }

  const thisWeek = mondayOf(new Date());
  let weeks = 0;
  let cursor = thisWeek;
  if ((counts[cursor] || 0) >= target) { weeks++; }
  cursor = weekBefore(cursor); // pending current week never breaks the chain
  while ((counts[cursor] || 0) >= target) { weeks++; cursor = weekBefore(cursor); }

  // cursor is now the first week that FAILED. Seed bridges if every week after
  // the seed week met the target (or the seed was set this/last week).
  let total = weeks;
  if (seed > 0 && seedDate) {
    const seedWeek = mondayOf(new Date(seedDate + 'T12:00:00'));
    if (cursor <= seedWeek) total = weeks + seed;
  }
  return { weeks: total, thisWeekCount: counts[thisWeek] || 0, target };
}

// ── Milestones ────────────────────────────────────────────────────────────────
const WORKOUT_MARKS = [1, 5, 10, 25, 50, 100, 150, 200, 300, 365, 500];
const STREAK_MARKS  = [4, 8, 12, 26, 52, 78, 104];
const VOLUME_MARKS  = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000];

export function computeMilestones(sessions, streakWeeks) {
  const workouts = sessions.length;
  const volume = sessions.reduce((a, s) =>
    a + (s.exercises || []).flatMap(e => e.sets || [])
        .filter(st => st.done)
        .reduce((v, st) => v + (st.weight || 0) * (st.reps || 1), 0), 0);

  const earned = [];
  for (const m of WORKOUT_MARKS) if (workouts >= m) earned.push({ icon: '🏋️', label: `${m} workouts` });
  for (const m of STREAK_MARKS)  if (streakWeeks >= m) earned.push({ icon: '🔥', label: `${m}-week streak` });
  for (const m of VOLUME_MARKS)  if (volume >= m) earned.push({ icon: '⚡', label: `${(m/1000).toLocaleString()}t lifted` });
  return { earned, workouts, volume };
}
