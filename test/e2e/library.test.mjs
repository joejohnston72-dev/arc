import { serve, boot, shot, dbGet } from './harness.mjs';

let pass = 0, fail = 0;
const ok  = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq  = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors, dialogs } = await boot({});
const tpl = async () => (await dbGet(page, 'templates')) || [];
const plans = async () => (await dbGet(page, 'plans')) || [];

console.log('\n── Library: expand a plan ───────────────────────────────');
await page.click('.tab[data-tab="Library"]');
await page.waitForSelector('.lib-plan');
await page.click('.lib-plan-head');
await page.waitForSelector('.lib-rt');
const rows = await page.$$eval('.lib-rt-name', n => n.map(x => x.textContent));
eq(rows.length, 5, 'expanding the plan lists its 5 routines');
eq(rows[0], 'Upper Strength (Chest Bias)', 'routines appear in plan order');
ok(await page.isVisible('.lib-plan-add'), '"New routine in this plan" is offered inside the plan');
await shot(page, '03-plan-expanded');

console.log('\n── Routine editor: open an existing routine ─────────────');
await page.click('.lib-rt-name');
await page.waitForSelector('#routineEditor.visible');
eq(await page.textContent('#reTitle'), 'Edit routine', 'opens in edit mode');
eq(await page.inputValue('#reName'), 'Upper Strength (Chest Bias)', 'name is prefilled');
const exCount = await page.$$eval('.re-row', r => r.length);
ok(exCount > 3, `renders its ${exCount} exercises`);
eq(await page.textContent('.re-plan-name'), 'My split', 'shows the plan it belongs to');
ok(await page.isVisible('#reDelete'), 'delete is offered for an existing routine');
await shot(page, '04-editor');

console.log('\n── Editor: change a set/rep target ──────────────────────');
const before = await page.$eval('.re-target', b => b.textContent);
await page.click('.re-target');
await page.waitForSelector('.re-step');
await page.click('[data-d="sets:1"]');
await page.click('[data-d="reps:1"]');
await page.click('[data-d="rest:15"]');
await shot(page, '05-target-sheet');
await page.click('[data-act="done"]');
await page.waitForTimeout(200);
const after = await page.$eval('.re-target', b => b.textContent);
ok(before !== after, `target updated (${before} → ${after})`);

console.log('\n── Editor: superset two exercises, then a second pair ───');
await page.click('.re-unit:nth-child(1) [data-menu]');
await page.waitForSelector('[data-act="superset"]');
await page.click('[data-act="superset"]');
await page.waitForSelector('.ss-pick');
await page.click('.ss-pick[data-i="1"]');
await page.click('[data-act="done"]');
await page.waitForTimeout(250);
ok(await page.isVisible('.re-ss'), 'a superset group renders');
const g1 = await page.$eval('.re-ss', e => ({ label: e.querySelector('.re-ss-label').textContent.trim(), color: e.style.getPropertyValue('--ss-color') }));
console.log('   group 1:', JSON.stringify(g1));

// second pair from the two exercises after the group
const menus = await page.$$('.re-unit:not(.re-ss) [data-menu]');
if (menus.length >= 2) {
  await menus[0].click();
  await page.waitForSelector('[data-act="superset"]');
  await page.click('[data-act="superset"]');
  await page.waitForSelector('.ss-pick');
  const picks = await page.$$eval('.ss-pick', ps => ps.map(p => +p.dataset.i));
  await page.click(`.ss-pick[data-i="${picks.find(i => i >= 3)}"]`);
  await page.click('[data-act="done"]');
  await page.waitForTimeout(250);
}
const groups = await page.$$eval('.re-ss', es => es.map(e => ({
  label: e.querySelector('.re-ss-label').textContent.trim(),
  color: e.style.getPropertyValue('--ss-color'),
})));
console.log('   groups:', JSON.stringify(groups));
eq(groups.length, 2, 'two superset groups coexist');
ok(groups[0].color !== groups[1].color, `two groups get DIFFERENT colours (${groups[0].color} vs ${groups[1].color})`);
eq(groups.map(g => g.label.replace(/\s+/g, ' ')), ['Superset A', 'Superset B'], 'groups are lettered A and B');
await shot(page, '06-two-supersets');

console.log('\n── Editor: save keeps the SAME routine id ───────────────');
const idBefore = (await tpl())[0].id;
const countBefore = (await tpl()).length;
await page.fill('#reName', 'Upper Strength (edited)');
await page.click('#reSave');
await page.waitForSelector('#routineEditor.visible', { state: 'hidden' });
await page.waitForTimeout(400);
const after1 = await tpl();
eq(after1.length, countBefore, 'saving an edit did NOT create a duplicate');
eq(after1.find(t => t.id === idBefore)?.name, 'Upper Strength (edited)', 'the edit landed on the original id');
ok((after1.find(t => t.id === idBefore)?.exercises || []).some(e => e.supersetId), 'supersets persisted into the template');
eq((await plans())[0].routineIds.length, 5, 'plan membership is unchanged by an edit');
eq((await plans())[0].routineIds[0], idBefore, 'the routine kept its PLACE in the plan (day order survives an edit)');

console.log('\n── Library: duplicate ───────────────────────────────────');
await page.waitForSelector('.lib-rt');
await page.click('[data-dup]');
await page.waitForTimeout(500);
const dup = await tpl();
eq(dup.length, countBefore + 1, 'duplicate added one routine');
ok(dup.some(t => t.name === 'Upper Strength (edited) (copy)'), 'copy is named distinctly');
eq((await plans())[0].routineIds.length, 6, 'the copy joined the same plan');
await shot(page, '07-duplicated');

console.log('\n── Library: Exercises pane + create with no workout ─────');
await page.click('#libSeg button[data-seg="exercises"]');
await page.waitForTimeout(400);
ok(await page.isVisible('#libSearch'), 'Exercises pane shows the search field');
ok(!(await page.isVisible('.lib-plan')), 'plan cards are hidden on the Exercises pane');
await shot(page, '08-library-exercises');
await page.click('#libNewEx');
await page.waitForSelector('#customExModal.open');
await page.fill('#customExName', 'Test Only Lift');
await page.click('#customExSave');
await page.waitForTimeout(600);
const custom = await dbGet(page, 'exercises-custom');
ok((custom || []).some(c => c.name === 'Test Only Lift'), 'custom exercise created with NO workout open');
ok(!(await page.isVisible('#activeWorkout.visible')), 'and it did not force a workout open');
await shot(page, '09-custom-created');

console.log('\n── deleteRoutine prunes the week plan ───────────────────');
const victim = (await tpl()).find(t => t.name.endsWith('(copy)'));
await page.evaluate(async id => {
  const o = indexedDB.open('life-dashboard', 1);
  await new Promise(res => { o.onsuccess = e => {
    const tx = e.target.result.transaction('workout', 'readwrite');
    tx.objectStore('workout').put({ '2026-09-21': id }, 'week-plan');
    tx.oncomplete = res; }; });
}, victim.id);
await page.click('#libSeg button[data-seg="plans"]');
await page.waitForTimeout(400);
// Expand only if it is collapsed — libOpenPlans survives a pane switch, so a
// blind click would toggle it shut.
if (!(await page.isVisible('.lib-rt'))) await page.click('.lib-plan-head');
await page.waitForSelector('.lib-rt');
await page.waitForTimeout(300);
await page.click(`.lib-rt[data-tid="${victim.id}"] [data-del]`);
await page.waitForTimeout(700);
eq(await dbGet(page, 'week-plan'), {}, 'the deleted routine was pruned from the week plan');

ok(dialogs.some(d => d.type === 'confirm' && /Delete routine/.test(d.message)), 'delete asks for confirmation first');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
