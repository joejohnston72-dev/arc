// projectPlan (Plan auto-fill + rest days) and recoverCoachSplits (regroup a
// coach split the templates → splits migration scattered).
//   node test/unit/plan-recovery.test.mjs
import { projectPlan, recoverCoachSplits, addDays, REST_DAY } from '../../workout/splits.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};
const ids = plan => Object.fromEntries(Object.entries(plan).map(([d, v]) => [d, v.rest ? 'REST' : v.workoutId]));

// ── addDays ──
eq(addDays('2026-09-30', 1), '2026-10-01', 'month rollover');
eq(addDays('2026-10-24', 2), '2026-10-26', 'across the UK clock change');

// ── projectPlan ──
const split = { id: 's', workouts: ['U', 'L', 'P1', 'P2', 'Lg'].map(id => ({ id, name: id })) };
const ses = (date, workoutId) => ({ date, startTime: `${date}T18:00:00`, workoutId, title: workoutId });

// Last logged L on Monday → Tue onward runs P1, P2, Lg, U, L…
let p = projectPlan({ split, sessions: [ses('2026-09-28', 'L')], planMap: {}, today: '2026-09-29', until: '2026-10-04' });
eq(ids(p), { '2026-09-29': 'P1', '2026-09-30': 'P2', '2026-10-01': 'Lg', '2026-10-02': 'U', '2026-10-03': 'L', '2026-10-04': 'P1' },
  'auto-fills in split order after the last logged workout');
eq(p['2026-09-29'].auto, true, 'auto days are flagged');

// A rest day pushes the rest of the split back one day.
p = projectPlan({ split, sessions: [ses('2026-09-28', 'L')], planMap: { '2026-09-30': REST_DAY }, today: '2026-09-29', until: '2026-10-02' });
eq(ids(p), { '2026-09-29': 'P1', '2026-09-30': 'REST', '2026-10-01': 'P2', '2026-10-02': 'Lg' }, 'rest day shifts the split');

// Today already logged → skipped; tomorrow is next.
p = projectPlan({ split, sessions: [ses('2026-09-28', 'L'), ses('2026-09-29', 'P1')], planMap: {}, today: '2026-09-29', until: '2026-09-30' });
eq(ids(p), { '2026-09-30': 'P2' }, 'a trained day is left out and the rotation continues');

// A manual pick is kept and the rotation continues after it.
p = projectPlan({ split, sessions: [], planMap: { '2026-09-30': 'Lg' }, today: '2026-09-29', until: '2026-10-01' });
eq(ids(p), { '2026-09-29': 'U', '2026-09-30': 'Lg', '2026-10-01': 'U' }, 'manual day resets the rotation after it');
eq(p['2026-09-30'].auto, false, 'manual days are not auto');

// A manual pick from another split doesn't move the rotation.
p = projectPlan({ split, sessions: [], planMap: { '2026-09-29': 'x' }, today: '2026-09-29', until: '2026-09-30' });
eq(ids(p), { '2026-09-29': 'x', '2026-09-30': 'U' }, 'off-split pick leaves the rotation alone');

// No split → only manual/rest days.
p = projectPlan({ split: null, sessions: [], planMap: { '2026-09-30': REST_DAY }, today: '2026-09-29', until: '2026-09-30' });
eq(ids(p), { '2026-09-30': 'REST' }, 'no active split projects nothing');

// ── recoverCoachSplits ──
let n = 0; const uid = () => `new${++n}`;
const ex = (...names) => names.map(name => ({ name }));
const orig = { id: 'my', name: 'My 5-Day Split', source: 'my', workouts: [
  { id: 'm1', name: 'Upper Strength (Chest Bias)', exercises: ex('Bench') },
  { id: 'm2', name: 'Push Hypertrophy (Delts)', exercises: ex('OHP') },
] };
const other = { id: 'oth', name: 'Other workouts', source: 'other', workouts: [
  { id: 'c1', name: 'Upper Strength (Chest Bias)', exercises: ex('Incline Bench', 'Row') },
  { id: 'c2', name: 'Lower', exercises: ex('Squat') },
  { id: 'z', name: 'Arms', exercises: ex('Curl') },
] };
const lib = { id: 'lib', name: 'Push / Pull / Legs (3-day)', source: 'library:ppl-3day', workouts: [
  { id: 'c3', name: 'Push', exercises: ex('Bench', 'Dips') },
] };
const draft = { name: 'Optimised ULPPL', routines: [
  { name: 'Upper Strength (Chest Bias)', exercises: ex('Incline Bench', 'Row') },
  { name: 'Lower', exercises: ex('Squat') },
  { name: 'Push', exercises: ex('Bench', 'Dips') },
] };
const before = JSON.stringify([orig, other, lib]);
let r = recoverCoachSplits([orig, other, lib], [draft], { uid });
eq(r.restored.map(s => [s.name, s.source, s.workouts.map(w => w.id)]), [['Optimised ULPPL', 'coach', ['c1', 'c2', 'c3']]],
  'regroups the coach days in draft order, keeping their ids (not the My-split original)');
eq(r.splits.map(s => [s.id, s.workouts.map(w => w.id)]), [['my', ['m1', 'm2']], ['oth', ['z']], ['new1', ['c1', 'c2', 'c3']]],
  'moves them out of their old splits; an emptied library split is dropped');
eq(JSON.stringify([orig, other, lib]), before, 'inputs are not mutated');

r = recoverCoachSplits(r.splits, [draft], { uid });
eq(r.restored.length, 0, 'running again does nothing (already a coach split of that name)');

r = recoverCoachSplits([orig, other], [draft], { uid });
eq(r.restored.length, 0, 'a draft that was never fully saved is not restored');

r = recoverCoachSplits([orig], [{ name: 'X', routines: [{ name: 'Push Hypertrophy (Delts)', exercises: ex('OHP') }] }], { uid });
eq(r.restored.length, 0, 'never takes a workout from My 5-Day Split');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
