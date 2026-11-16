// Personal-best detection. Pure (no db import) so it can be unit-tested in node.

export const e1RM = (w, r) => (r > 0 ? w * (1 + r / 30) : w); // Epley

// A drop set is a continuation of the set before it (lighter weight, to failure),
// not a standalone effort — so it never counts toward PBs/records, same as warmups.
const isWorkingSet = s => s && s.done && (s.weight || 0) > 0 && s.type !== 'warmup' && s.type !== 'dropset';

const emptyRecord = () => ({ maxWeight: 0, maxE1rm: 0, repsAtWeight: {} });

function absorbInto(r, set) {
  if (set.weight > r.maxWeight) r.maxWeight = set.weight;
  const est = e1RM(set.weight, set.reps || 1);
  if (est > r.maxE1rm) r.maxE1rm = est;
  const key = String(set.weight);
  if ((set.reps || 0) > (r.repsAtWeight[key] || 0)) r.repsAtWeight[key] = set.reps || 0;
}

// Most reps ever done at this weight OR HEAVIER (null if never lifted this heavy).
// 12 reps @ 97.5 is no record if you've already done 12 @ 110.
function bestRepsAtOrAbove(r, weight) {
  let best = null;
  for (const [k, reps] of Object.entries(r.repsAtWeight)) {
    if (+k >= weight && (best === null || reps > best)) best = reps;
  }
  return best;
}

// ── Records ───────────────────────────────────────────────────────────────────
// Build per-exercise all-time records from past sessions.
// -> { [name]: { maxWeight, maxE1rm, repsAtWeight: {weight: bestReps} } }
export function buildRecords(sessions, excludeId = null) {
  const rec = {};
  for (const s of sessions) {
    if (!s?.exercises || s.id === excludeId) continue;
    for (const ex of s.exercises) {
      const r = (rec[ex.name] ||= emptyRecord());
      for (const set of ex.sets || []) if (isWorkingSet(set)) absorbInto(r, set);
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
  const prevReps = bestRepsAtOrAbove(r, set.weight);
  if (set.weight > r.maxWeight) {
    pbs.push({ exercise: exName, type: 'weight', label: `${set.weight} kg — heaviest ever` });
  } else if (prevReps && (set.reps || 0) > prevReps) {
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
  absorbInto((records[exName] ||= emptyRecord()), set);
}

// PBs for one exercise's sets in the current session, given the historical
// baseline record (or undefined). Sets are absorbed in order, then a PB is
// dropped if a later set in the same session beat it outright (≥ weight and
// ≥ reps, one strictly) — the trophy belongs on the best set, not a warm-up to it.
// -> { pbs, pbSetIds: Set, pbBySet: Map<setId, firstPb> }
export function sessionPBs(exName, sets, base) {
  const rec = {};
  if (base) rec[exName] = { maxWeight: base.maxWeight, maxE1rm: base.maxE1rm, repsAtWeight: { ...base.repsAtWeight } };
  const hits = [];
  for (const set of sets) {
    if (!set.done) continue;
    const found = detectPBs(exName, set, rec);
    if (found.length) {
      // Carry the achieving set's numbers so surfaces (e.g. the PB-first summary)
      // can render {kg}×{reps} + est. 1RM without re-scanning the session.
      for (const p of found) { p.weight = set.weight; p.reps = set.reps || 0; p.est = Math.round(e1RM(set.weight, set.reps || 1)); }
      hits.push({ set, found });
    }
    absorbSet(exName, set, rec);
  }
  const done = sets.filter(isWorkingSet);
  const beaten = set => done.slice(done.indexOf(set) + 1).some(o =>
    o.weight >= set.weight && (o.reps || 0) >= (set.reps || 0) &&
    (o.weight > set.weight || (o.reps || 0) > (set.reps || 0)));
  const pbs = [], pbSetIds = new Set(), pbBySet = new Map();
  for (const { set, found } of hits) {
    if (beaten(set)) continue;
    pbs.push(...found); pbSetIds.add(set.id); pbBySet.set(set.id, found[0]);
  }
  return { pbs, pbSetIds, pbBySet };
}
