// pruneWeekPlan — dropping Plan-tab days that point at deleted workouts.
// splits.js is a pure module with no imports, so this runs under plain Node:
//   node test/unit/week-plan.test.mjs
import { pruneWeekPlan } from '../../workout/splits.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};

const week = { '2026-09-28': 'push', '2026-09-29': 'pull', '2026-09-30': 'legs', '2026-10-01': 'push' };

// Removing one workout drops every day assigned to it, and only those days.
let r = pruneWeekPlan(week, ['push']);
eq(r.map, { '2026-09-29': 'pull', '2026-09-30': 'legs' }, 'every day assigned to a removed workout is dropped');
eq(r.changed, true, 'and it reports the change');

// Deleting a whole split removes all its workouts at once.
r = pruneWeekPlan(week, ['push', 'pull']);
eq(r.map, { '2026-09-30': 'legs' }, 'deleting a split drops all of its workouts\' days');

// Nothing assigned to the removed workout: untouched, and says so, so the
// caller can skip a pointless write and cloud backup.
r = pruneWeekPlan(week, ['arms']);
eq(r.map, week, 'an id with no plan days leaves the map as it was');
eq(r.changed, false, 'and reports no change');

// It never mutates the caller's map.
const before = JSON.stringify(week);
pruneWeekPlan(week, ['push']);
eq(JSON.stringify(week), before, 'the input map is not mutated');

// Defensive inputs — a fresh install has no week-plan key at all.
eq(pruneWeekPlan(undefined, ['push']), { map: {}, changed: false }, 'a missing map is treated as empty');
eq(pruneWeekPlan(week, undefined).changed, false, 'no ids removes nothing');
eq(pruneWeekPlan(week, []).changed, false, 'an empty id list removes nothing');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
