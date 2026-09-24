import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  e1RM, buildRecords, detectPBs, absorbSet, computeStreak, computeMilestones,
  getStreakSettings, saveStreakSettings,
} from '../workout/achievements.js';

const set = (weight, reps, extra = {}) => ({ weight, reps, done: true, ...extra });
const session = (id, date, exercises) => ({ id, date, exercises });

const isoDaysAgo = n => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mondayOffset = () => (new Date().getDay() + 6) % 7; // days since this Monday; base+1..base+7 = last week

test('e1RM uses Epley and passes weight through for 0 reps', () => {
  assert.equal(e1RM(100, 30), 200);
  assert.equal(e1RM(80, 0), 80);
});

test('buildRecords skips warmups, drop sets, undone sets and excluded session', () => {
  const sessions = [
    session('a', '2026-01-01', [{ name: 'Squat', sets: [
      set(100, 5), set(140, 1, { type: 'warmup' }), set(150, 1, { type: 'dropset' }), set(200, 1, { done: false }),
    ] }]),
    session('b', '2026-01-08', [{ name: 'Squat', sets: [set(120, 3)] }]),
  ];
  const all = buildRecords(sessions);
  assert.equal(all.Squat.maxWeight, 120);
  assert.deepEqual(all.Squat.repsAtWeight, { 100: 5, 120: 3 });
  assert.equal(buildRecords(sessions, 'b').Squat.maxWeight, 100);
});

test('detectPBs: no fanfare without a baseline', () => {
  assert.deepEqual(detectPBs('Squat', set(100, 5), {}), []);
});

test('detectPBs: weight PB suppresses the e1RM PB', () => {
  const rec = buildRecords([session('a', '2026-01-01', [{ name: 'Squat', sets: [set(100, 5)] }])]);
  const pbs = detectPBs('Squat', set(110, 5), rec);
  assert.deepEqual(pbs.map(p => p.type), ['weight']);
});

test('detectPBs: rep PB at a known weight also flags e1RM', () => {
  const rec = buildRecords([session('a', '2026-01-01', [{ name: 'Squat', sets: [set(100, 5)] }])]);
  assert.deepEqual(detectPBs('Squat', set(100, 6), rec).map(p => p.type), ['reps', 'e1rm']);
});

test('absorbSet stops a repeated set re-triggering a PB', () => {
  const rec = buildRecords([session('a', '2026-01-01', [{ name: 'Squat', sets: [set(100, 5)] }])]);
  absorbSet('Squat', set(110, 5), rec);
  assert.deepEqual(detectPBs('Squat', set(110, 5), rec), []);
});

test('computeStreak: pending current week does not break the chain', () => {
  // Three sessions in each of the last two full weeks, none this week.
  const base = mondayOffset();
  const days = [1, 2, 3, 8, 9, 10].map(n => isoDaysAgo(base + n));
  const r = computeStreak(days.map((d, i) => session(String(i), d, [])), { target: 3 });
  assert.equal(r.weeks, 2);
  assert.equal(r.thisWeekCount, 0);
});

test('computeStreak: seed only bridges when the chain reaches the seed week', () => {
  const base = mondayOffset();
  const sessions = [1, 2, 3].map((n, i) => session(String(i), isoDaysAgo(base + n), []));
  assert.equal(computeStreak(sessions, { seed: 5, seedDate: isoDaysAgo(base + 1), target: 3 }).weeks, 6);
  assert.equal(computeStreak(sessions, { seed: 5, seedDate: isoDaysAgo(base + 28), target: 3 }).weeks, 1);
});

test('computeMilestones counts workouts, streak and volume marks', () => {
  const sessions = Array.from({ length: 5 }, (_, i) =>
    session(String(i), '2026-01-01', [{ name: 'Squat', sets: [set(100, 20), set(500, 1, { done: false })] }]));
  const m = computeMilestones(sessions, 4);
  assert.equal(m.volume, 10_000);
  assert.deepEqual(m.earned.map(e => e.label), ['1 workouts', '5 workouts', '4-week streak', '10t lifted']);
});

test('streak settings round-trip through db with defaults', async () => {
  assert.deepEqual(await getStreakSettings(), { seed: 0, seedDate: null, target: 3 });
  await saveStreakSettings({ seed: 2, seedDate: '2026-01-05', target: 4 });
  assert.deepEqual(await getStreakSettings(), { seed: 2, seedDate: '2026-01-05', target: 4 });
});
