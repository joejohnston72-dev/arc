// computeStreak with illness pauses.
//   node test/unit/streak.test.mjs
import { computeStreak, sickWeeks, currentIllness } from '../../workout/streak.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};
// Three sessions in the week starting each given Monday.
const wk = mon => [0, 2, 4].map(o => { const d = new Date(mon + 'T12:00:00'); d.setDate(d.getDate() + o); return { date: d.toISOString().slice(0, 10) }; });
const now = new Date('2026-10-03T12:00:00'); // Sat; week of Mon 2026-09-28

// Baseline: 3 full weeks before this one, this week empty (pending).
const base = [...wk('2026-09-07'), ...wk('2026-09-14'), ...wk('2026-09-21')];
eq(computeStreak(base, {}, now).weeks, 3, 'pending week never breaks');

// A missed week breaks the chain…
const gap = [...wk('2026-08-31'), ...wk('2026-09-07'), ...wk('2026-09-21')];
eq(computeStreak(gap, {}, now).weeks, 1, 'missed week breaks');
// …unless the user was unwell that week: paused, not counted.
let r = computeStreak(gap, { sick: [{ from: '2026-09-15', to: '2026-09-18' }] }, now);
eq([r.weeks, r.pausedWeeks], [3, 1], 'sick week bridges the gap without adding');

// A partial sick week (1 session) is still paused.
r = computeStreak([...gap, { date: '2026-09-16' }], { sick: [{ from: '2026-09-16', to: '2026-09-16' }] }, now);
eq(r.weeks, 3, 'one sick day pauses a short week');

// Ongoing illness (to=null) runs to today and pauses the current week.
r = computeStreak(base, { sick: [{ from: '2026-10-01', to: null }] }, now);
eq([r.weeks, r.pausedNow], [3, true], 'ongoing illness pauses this week');

// Multi-week illness, then a seed carried from before it.
const long = [...wk('2026-08-24'), ...wk('2026-09-21')];
r = computeStreak(long, { seed: 10, seedDate: '2026-08-25', sick: [{ from: '2026-08-31', to: '2026-09-19' }] }, now);
eq([r.weeks, r.pausedWeeks], [12, 3], 'seed survives a multi-week illness');

eq([...sickWeeks([{ from: '2026-09-27', to: '2026-09-28' }])], ['2026-09-21', '2026-09-28'], 'Sun→Mon spans two weeks');
eq(currentIllness([{ from: '2026-09-01', to: '2026-09-02' }, { from: '2026-10-01', to: null }]), { from: '2026-10-01', to: null }, 'finds open period');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
