// Export: per-set CSV rows and the JSON backup.
//   node test/unit/export.test.mjs
import { buildSetRows, toCSV, buildBackup, SET_COLUMNS } from '../../workout/exportData.js';
import { rangeFromSets } from '../../workout/repRanges.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};

const sess = (id, date, sets, extra = {}) => ({
  id, date, startTime: `${date}T10:00:00Z`, title: 'Push', duration: 3600,
  exercises: [{ name: 'Bench Press (Barbell)', category: 'Chest', logType: 'weighted', restTime: 120, notes: 'felt "good", strong', sets }],
  pbs: [], ...extra,
});
const s1 = sess('a', '2026-10-01', [
  { id: 'w', type: 'warmup', weight: 40, reps: 8, done: true },
  { id: 'x', type: 'normal', weight: 80, reps: 8, done: true, targetReps: 8 },
]);
const s2 = sess('b', '2026-10-05', [
  { id: 'y', type: 'normal', weight: 85, reps: 6, done: true, targetReps: 8, targetWeight: 85 },
], { pbs: [{ exercise: 'Bench Press (Barbell)', type: 'weight', label: '85 kg — heaviest ever' }], splitId: 'sp' });

// Newest-first input still comes out oldest-first.
const rows = buildSetRows([s2, s1], { splitName: s => (s.splitId === 'sp' ? 'PPL' : '') });
eq(rows.map(r => r.set_id), ['w', 'x', 'y'], 'chronological order');
eq(rows[0].working_set_order, '', 'warm-up is not a working set');
eq(rows[0].e1rm_kg, '', 'no e1RM for a warm-up');
eq(rows[1].volume_kg, 640, 'volume');
eq(rows[1].is_e1rm_pb, '', 'first working set has no baseline');
eq(rows[2].is_weight_pb, 1, 'heavier later set is a weight PB');
eq(rows[2].best_e1rm_before_kg, 101.3, 'best e1RM before');
eq(rows[2].hit_target_reps, 0, 'missed target reps');
eq(rows[1].hit_target_reps, 1, 'hit target reps');
eq(rows[2].split, 'PPL', 'split name');
eq(rows[2].exercise_pbs, '85 kg — heaviest ever', 'exercise PBs');
eq(rows[0].secondary_muscles.includes('Triceps'), true, 'secondary muscles');
eq(rows[2].weekday, 'Mon', 'weekday');

const csv = toCSV(SET_COLUMNS, rows);
eq(csv.split('\r\n')[0], SET_COLUMNS.join(','), 'header');
eq(csv.includes('"felt ""good"", strong"'), true, 'quotes and commas escaped');

const b = buildBackup({ stores: {
  workout: [{ key: 'session-a', value: s1 }, { key: 'anthropic-key', value: 'sk-x' }],
  habits: [{ key: 'anthropic-key', value: 'sk-x' }],
  calories: [{ key: '2026-10-01', value: { kcal: 2000 } }],
} });
eq(b.entries.map(e => e.key), ['session-a'], 'entries keep import shape, no key');
eq(b.stores.habits, [], 'habits key dropped');
eq(b.stores.calories.length, 1, 'nutrition included');

eq(rangeFromSets([{ type: 'warmup', reps: 12 }, { reps: 8 }, { reps: 10 }]), { min: 8, max: 10 }, 'coach range');
eq(rangeFromSets([{ reps: 0 }]), null, 'no reps → no range');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
