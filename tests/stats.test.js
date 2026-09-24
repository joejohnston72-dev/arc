import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifetimeTotals, bandFor, weeklySetsByCategory, exerciseFrequency } from '../workout/stats.js';
import { resolveRepRange } from '../workout/repRanges.js';

const set = (weight, reps, extra = {}) => ({ weight, reps, done: true, ...extra });
const today = () => new Date().toISOString().slice(0, 10);

test('lifetimeTotals sums done sets only', () => {
  const t = lifetimeTotals([
    { duration: 3600, exercises: [{ sets: [set(100, 5), set(50, 10, { done: false })] }] },
    { duration: 1800, exercises: [{ sets: [set(20, 10)] }] },
  ]);
  assert.deepEqual(t, { workouts: 2, hours: 1.5, volume: 700, sets: 2 });
});

test('bandFor falls back to 10–20 for unknown muscles', () => {
  assert.deepEqual(bandFor('Triceps'), [6, 14]);
  assert.deepEqual(bandFor('Neck'), [10, 20]);
});

test('weeklySetsByCategory attributes compound sets to secondary muscles', () => {
  const sessions = [{ date: today(), exercises: [
    { name: 'Bench Press (Barbell)', category: 'Chest', sets: [set(80, 8), set(80, 8), set(80, 8), set(40, 10, { type: 'warmup' })] },
    { name: 'Run', category: 'Cardio', sets: [set(0, 20)] },
  ] }];
  const r = weeklySetsByCategory(sessions, 1);
  const row = Object.fromEntries(r.rows.map(x => [x.cat, x]));
  assert.equal(row.Chest.directPerWk, 3);
  assert.equal(row.Chest.status, 'low');
  assert.ok(Math.abs(row.Triceps.indirectPerWk - 1.05) < 1e-9);
  assert.equal(r.cardioMinPerWk, 20);
});

test('exerciseFrequency orders by sessions with working sets', () => {
  const sessions = [
    { exercises: [{ name: 'Squat', category: 'Quads', sets: [set(100, 5)] }, { name: 'Curl', sets: [set(10, 5, { type: 'warmup' })] }] },
    { exercises: [{ name: 'Squat', category: 'Quads', sets: [set(100, 5)] }, { name: 'Row', category: 'Back', sets: [set(60, 8)] }] },
  ];
  assert.deepEqual(exerciseFrequency(sessions).map(e => [e.name, e.n]), [['Squat', 2], ['Row', 1]]);
});

test('resolveRepRange precedence: custom > known > category > none', () => {
  assert.deepEqual(resolveRepRange({ name: 'Bench Press (Barbell)', repRange: { min: 3, max: 5 } }), { min: 3, max: 5 });
  assert.deepEqual(resolveRepRange({ name: 'Bench Press (Barbell)', category: 'Chest' }), { min: 5, max: 8 });
  assert.deepEqual(resolveRepRange({ name: 'My Custom Fly', category: 'Chest' }), { min: 8, max: 12 });
  assert.equal(resolveRepRange({ name: 'Jump Rope', category: 'Cardio' }), null);
  assert.equal(resolveRepRange({ name: 'Plank', logType: 'duration' }), null);
});
