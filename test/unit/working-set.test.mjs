// Warm-up / drop-set rows feed tracking through their working set.
//   node test/unit/working-set.test.mjs
import { asWorkingSet, workingSessions } from '../../workout/workingSet.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};

const warm = { id: 'a', type: 'warmup', weight: 40, reps: 10, weight2: 100, reps2: 6, done: true };
eq([asWorkingSet(warm).type, asWorkingSet(warm).weight, asWorkingSet(warm).reps, asWorkingSet(warm).id], ['normal', 100, 6, 'a'], 'warm-up row → its working set');
eq(asWorkingSet({ type: 'warmup', weight: 40, reps: 10 }).type, 'warmup', 'plain warm-up stays excluded');
const drop = { id: 'b', type: 'dropset', weight: 100, reps: 8, weight2: 70, reps2: 10, done: true };
eq([asWorkingSet(drop).type, asWorkingSet(drop).weight, asWorkingSet(drop).reps], ['normal', 100, 8], 'drop-set row → its main set');
const normal = { type: 'normal', weight: 90, reps: 5 };
eq(asWorkingSet(normal) === normal, true, 'normal set untouched');
const sess = [{ id: 's', exercises: [{ name: 'Bench', sets: [warm] }] }];
eq(workingSessions(sess)[0].exercises[0].sets[0].weight, 100, 'sessions mapped');
eq(sess[0].exercises[0].sets[0].weight, 40, 'input not mutated');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
