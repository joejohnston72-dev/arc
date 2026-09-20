import { serve, boot, shot, dbGet } from './harness.mjs';
let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors, dialogs } = await boot({});
const tpl = async () => (await dbGet(page, 'templates')) || [];
const plans = async () => (await dbGet(page, 'plans')) || [];

// The reported bug: ROUTINE_LIBRARY has `Full Body A`/`B` in BOTH full-body-3day
// and minimalist-2day with different exercises. The old add keyed on day NAME,
// so the second split added zero routines and claimed it was already there.
const addSplit = async label => {
  await page.click('.tab[data-tab="Library"]');
  await page.waitForSelector('#libBrowseSplits');
  await page.click('#libBrowseSplits');
  await page.waitForSelector('#routineLibrary.visible');
  await page.click(`.split-card:has(.split-name:text-is("${label}"))`);
  await page.waitForSelector('#libraryDetail.visible');
  await page.click('#libraryAddBtn');
  await page.waitForTimeout(800);
};

console.log('\n── Same-named days across two different splits ──────────');
const names = await page.evaluate(async () => {
  const m = await import('./routineLibrary.js');
  return m.ROUTINE_LIBRARY.map(s => ({ id: s.id, name: s.name, days: s.days.map(d => d.name) }));
});
const fb = names.find(s => s.id === 'full-body-3day');
const mn = names.find(s => s.id === 'minimalist-2day');
const shared = fb.days.filter(d => mn.days.includes(d));
ok(shared.length > 0, `the two splits really do share day names: ${shared.join(', ')}`);

const before = (await tpl()).length;
await addSplit(fb.name);
const afterFB = (await tpl()).length;
eq(afterFB - before, fb.days.length, `"${fb.name}" added all ${fb.days.length} of its days`);

await addSplit(mn.name);
const afterMN = (await tpl()).length;
eq(afterMN - afterFB, mn.days.length,
   `"${mn.name}" also added all ${mn.days.length} of its days despite the shared names`);
eq((await plans()).length, 3, 'each split is its own plan alongside the seeded one');

const ps = await plans();
const pFB = ps.find(p => p.splitId === 'full-body-3day');
const pMN = ps.find(p => p.splitId === 'minimalist-2day');
const ts = await tpl();
const byId = id => ts.find(t => t.id === id);
const fbA = pFB.routineIds.map(byId).find(t => t.name === shared[0]);
const mnA = pMN.routineIds.map(byId).find(t => t.name === shared[0]);
ok(fbA && mnA, `both plans hold their own "${shared[0]}"`);
ok(fbA.id !== mnA.id, 'they are separate routines, not the same one shared');
ok(JSON.stringify(fbA.exercises.map(e => e.name)) !== JSON.stringify(mnA.exercises.map(e => e.name)),
   'and they keep their DIFFERENT exercises, which the old skip-on-name silently lost');
await page.waitForTimeout(300);
await shot(page, '15-three-plans');

console.log('\n── Day order is the split order, not insertion order ────');
eq(pFB.routineIds.map(id => byId(id).name), fb.days, 'the plan preserves the split\'s day order');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
