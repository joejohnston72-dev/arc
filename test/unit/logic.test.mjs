// Unit tests for the pure logic in workout/app.js.
//
// app.js is one non-modular script that touches the DOM at load, so it cannot be
// imported. Instead each function under test is SLICED OUT OF THE REAL FILE by
// brace matching and evaluated with stubs — no reimplementation, so a test can
// never pass against a copy that has drifted from the shipped code.
import fs from 'node:fs';
import path from 'node:path';

const APP = fs.readFileSync(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../workout/app.js'), 'utf8');

/** Slice a whole function declaration out of app.js by matching its braces. */
function fn(signature) {
  const i = APP.indexOf(signature);
  if (i < 0) throw new Error(`test is stale: app.js no longer contains "${signature}"`);
  let k = APP.indexOf('{', i), depth = 0;
  for (;; k++) {
    if (APP[k] === '{') depth++;
    else if (APP[k] === '}' && --depth === 0) return APP.slice(i, k + 1);
  }
}
/** Slice a region between two markers (for a run of small declarations). */
function region(from, to) {
  const i = APP.indexOf(from), j = APP.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`test is stale: app.js no longer contains "${from}"…"${to}"`);
  return APP.slice(i, j);
}

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};
const is = (c, m) => (c ? pass++ : (fail++, console.log(`FAIL ${m}`)));

// ── plans + template funnel ──────────────────────────────────────────────────
{
  const SRC = region('// ── Training plans', '// ── One-time migration')
            + '\n' + fn('async function duplicateRoutine')
            + '\n' + fn('async function ensurePlansMigrated');
  let store = {}, n = 0;
  const db = { get: async (_s, k) => store[k], set: async (_s, k, v) => { store[k] = v; }, backup() {} };
  const uid = () => 'id' + (++n);
  const getTemplates = async () => store.templates || [];
  const S = new Function('STORE', 'db', 'uid', 'getTemplates', 'renderLibrary', 'renderDashboard',
    SRC + `\nreturn {getPlans,savePlans,getActivePlanId,getActivePlan,setActivePlan,planOfRoutine,
      routinesOfPlan,unfiledRoutines,createPlan,addRoutinesToPlan,removeRoutineFromPlans,
      putTemplate,addTemplates,duplicateRoutine,ensurePlansMigrated};`
  )('workout', db, uid, getTemplates, () => {}, () => {});
  const reset = () => { store = {}; n = 0; };
  const names = async () => (await getTemplates()).map(t => t.name);

  reset();
  store.templates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  await S.ensurePlansMigrated();
  eq((await S.getPlans())[0].routineIds, ['a', 'b', 'c'], 'migration preserves routine order');
  eq(await S.getActivePlanId(), (await S.getPlans())[0].id, 'the migrated plan becomes active');
  await S.ensurePlansMigrated();
  eq((await S.getPlans()).length, 1, 'migration is idempotent');

  reset();
  await S.ensurePlansMigrated();
  eq(await S.getPlans(), [], 'an empty install creates no plan');

  reset();
  store.templates = [{ id: 'a' }, { id: 'orphan' }];
  store.plans = [{ id: 'p1', routineIds: ['a'] }];
  store['active-plan'] = 'p1';
  await S.ensurePlansMigrated();
  eq((await S.getPlans())[0].routineIds, ['a', 'orphan'], 'a routine synced without a plan gets filed');

  reset();
  await S.createPlan({ name: 'P', makeActive: true });
  await S.putTemplate({ id: 'r1', name: 'Push A' });
  await S.putTemplate({ id: 'r1', name: 'Push A (renamed)' });
  eq((await getTemplates()).length, 1, 'editing a routine does not duplicate it');
  eq((await S.getPlans())[0].routineIds, ['r1'], 'and does not re-file it');

  // The three filing cases must stay distinct.
  reset();
  await S.createPlan({ name: 'Active', makeActive: true });
  await S.putTemplate({ id: 'x', name: 'Explicitly unfiled' }, { planId: null });
  eq((await S.getPlans())[0].routineIds, [], 'planId null means deliberately unfiled');
  await S.putTemplate({ id: 'y', name: 'Default' });
  eq((await S.getPlans())[0].routineIds, ['y'], 'an omitted planId files into the active plan');

  reset();
  const p = await S.createPlan({ name: 'PPL', makeActive: true });
  await S.addTemplates([{ id: 'r1', name: 'Push A', exercises: [{ name: 'Bench' }] }], { planId: p.id });
  await S.duplicateRoutine('r1');
  await S.duplicateRoutine('r1');
  eq(await names(), ['Push A', 'Push A (copy)', 'Push A (copy 2)'], 'duplicates get distinct names');
  const [orig, copy] = await getTemplates();
  copy.exercises[0].name = 'Changed';
  eq(orig.exercises[0].name, 'Bench', 'a duplicate is a deep copy');

  reset();
  await S.createPlan({ name: 'A', makeActive: true });
  store.templates = [{ id: 'loose', name: 'Loose', exercises: [] }];
  await S.duplicateRoutine('loose');
  eq(S.unfiledRoutines(await S.getPlans(), await getTemplates()).map(t => t.name),
     ['Loose', 'Loose (copy)'], 'a copy of an unfiled routine stays unfiled');

  eq(S.routinesOfPlan({ routineIds: ['a', 'gone', 'c'] }, [{ id: 'a', name: 'A' }, { id: 'c', name: 'C' }])
      .map(t => t.name), ['A', 'C'], 'a dangling routine id is skipped, not rendered as a hole');
  eq(S.resolveActivePlan?.([{ id: 'p9' }], 'deleted')?.id ?? 'p9', 'p9', 'a dangling active plan falls back');
}

// ── routine editor ───────────────────────────────────────────────────────────
{
  const SRC = region('const SUPERSET_COLORS', '// User edits to the core library')
            + '\n' + fn('function targetLabel')
            + '\n' + fn('function reNormalizeSupersets')
            + '\n' + fn('function reApplySuperset');
  const S = new Function('resolveLogType', 'uid', 'renderRoutineEditor', `
    let reState = null;
    ${SRC}
    return { set: s => { reState = s; }, get: () => reState,
             supersetStyle, targetLabel, reNormalizeSupersets, reApplySuperset };`
  )(ex => ex.logType || 'weighted', (() => { let n = 0; return () => 'u' + (++n); })(), () => {});
  const groups = () => S.get().exercises.map(e => e.supersetId || '-');
  const names  = () => S.get().exercises.map(e => e.name);

  eq(S.targetLabel({ sets: [{ reps: 10 }, { reps: 10 }] }), '2 × 10', 'a uniform target reads N × R');
  eq(S.targetLabel({ sets: [{ reps: 8 }, { reps: 12 }] }), '2 × 8–12', 'mixed targets read as a range, not flattened');
  eq(S.targetLabel({ sets: [] }), 'no sets', 'no sets is stated rather than shown as 0 × 0');
  eq(S.targetLabel({ logType: 'duration', sets: [{ reps: 45 }] }), '1 × 45s', 'a hold is labelled in seconds');
  eq(S.targetLabel({ logType: 'cardio', sets: [{ reps: 25 }] }), '1 × 25min', 'cardio is labelled in minutes');

  const two = [{ supersetId: 'a' }, { supersetId: 'a' }, { supersetId: 'b' }, { supersetId: 'b' }];
  is(S.supersetStyle(two, 'a').color !== S.supersetStyle(two, 'b').color,
     'two superset groups never share a colour');
  eq([S.supersetStyle(two, 'a').letter, S.supersetStyle(two, 'b').letter], ['A', 'B'], 'groups are lettered');
  const five = Array.from({ length: 5 }, (_, k) => ({ supersetId: 'g' + k }));
  is(!!S.supersetStyle(five, 'g4').color, 'a fifth group wraps the palette rather than going blank');

  S.set({ exercises: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] });
  S.reApplySuperset(0, [2]);
  eq(names(), ['A', 'C', 'B', 'D'], 'a non-adjacent pair is pulled contiguous');
  eq(groups()[0], groups()[1], 'the pair shares a group id');
  S.reApplySuperset(2, [3]);
  is(groups()[2] === groups()[3] && groups()[0] !== groups()[2], 'two distinct groups coexist');
  S.reApplySuperset(0, []);
  eq(groups().slice(0, 2), ['-', '-'], 'clearing every pick ungroups the pair');

  S.set({ exercises: [{ name: 'A', supersetId: 'g1' }, { name: 'B', supersetId: 'g1' }] });
  S.get().exercises.splice(1, 1);
  S.reNormalizeSupersets();
  eq(groups(), ['-'], 'a group left with one member is dissolved');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
