// The working set inside a warm-up / drop-set row, as tracking should see it.
// Dual rows log two loads (see isDualSet in app.js):
//   warm-up  = warm load → working set (weight2/reps2)
//   drop set = working set (weight/reps) → lighter drop (weight2/reps2)
// PBs, top sets and progression key off the working portion, so they read every
// row through asWorkingSet. Pure — no db import — so it can be unit-tested.
export function asWorkingSet(s) {
  if (!s) return s;
  if (s.type === 'warmup') return s.weight2 > 0 ? { ...s, type: 'normal', weight: s.weight2, reps: s.reps2 || 0 } : s;
  if (s.type === 'dropset') return { ...s, type: 'normal' };
  return s;
}
export const workingSetsOf = ex => (ex?.sets || []).map(asWorkingSet);
export const workingSessions = sessions => (sessions || []).map(s =>
  s?.exercises ? { ...s, exercises: s.exercises.map(ex => ({ ...ex, sets: workingSetsOf(ex) })) } : s);
