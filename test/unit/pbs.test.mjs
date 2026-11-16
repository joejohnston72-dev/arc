// PB trophies: rep PBs count heavier history, and a set beaten later the same session loses its trophy.
//   node test/unit/pbs.test.mjs
import { buildRecords, sessionPBs } from '../../workout/records.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};
const EX = 'Seated Leg Press (Machine)';
const S = (id, weight, reps) => ({ id, weight, reps, done: true });
const hist = sets => buildRecords([{ id: 'h', exercises: [{ name: EX, sets }] }])[EX];
const ids = r => [...r.pbSetIds];

// The reported case: 97.5×10, 97.5×12, 102.5×12, 110×12 — trophy was on set 2.
const today = [S(1, 97.5, 10), S(2, 97.5, 12), S(3, 102.5, 12), S(4, 110, 12)];
{
  const r = sessionPBs(EX, today, hist([S('a', 97.5, 10), S('b', 110, 10), S('c', 120, 8)]));
  eq(ids(r), [4], 'only 110×12 gets the trophy (rep PB at ≥110)');
  eq(r.pbs.map(p => p.type), ['reps', 'e1rm'], '110×12 is a rep PB and e1RM PB (154 > 152)');
}
{
  // 12 reps at a heavier weight already in history → 97.5×12 is not a rep PB.
  const r = sessionPBs(EX, [S(1, 97.5, 12)], hist([S('a', 97.5, 10), S('b', 110, 12)]));
  eq(ids(r), [], 'no rep PB when heavier weight already done for as many reps');
}
{
  // Heaviest-ever weight PB still fires; earlier lighter PB in-session is superseded.
  const r = sessionPBs(EX, [S(1, 125, 5), S(2, 130, 5)], hist([S('a', 120, 8)]));
  eq(ids(r), [2], 'heavier same-reps set supersedes earlier weight PB');
}
{
  // Not dominated: lighter set with more reps keeps its trophy alongside a heavier one.
  const r = sessionPBs(EX, [S(1, 100, 15), S(2, 125, 5)], hist([S('a', 100, 12), S('b', 120, 8)]));
  eq(ids(r), [1, 2], 'non-dominated PBs both keep trophies');
}
{
  // Identical later set doesn't strip the first.
  const r = sessionPBs(EX, [S(1, 100, 13), S(2, 100, 13)], hist([S('a', 100, 12)]));
  eq(ids(r), [1], 'repeat of a PB set keeps trophy on the first');
}
{
  eq(ids(sessionPBs(EX, today, undefined)), [4], 'first session: only the best set vs earlier sets');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
