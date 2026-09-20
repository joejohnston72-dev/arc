import { serve, boot, shot, dbGet } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors, dialogs } = await boot({});
const tpl = async () => (await dbGet(page, 'templates')) || [];
const plans = async () => (await dbGet(page, 'plans')) || [];
const rowNames = () => page.$$eval('.re-row-name', n => n.map(x => x.textContent));

const openFirstRoutine = async () => {
  await page.click('.tab[data-tab="Library"]');
  await page.waitForSelector('.lib-plan');
  if (!(await page.isVisible('.lib-rt'))) await page.click('.lib-plan-head');
  await page.waitForSelector('.lib-rt');
  await page.click('.lib-rt-name');
  await page.waitForSelector('#routineEditor.visible');
};

console.log('\n── Editor: DRAG to reorder ──────────────────────────────');
await openFirstRoutine();
const before = await rowNames();
console.log('   before:', before.slice(0, 3).join(' | '));
// Drag unit 1's handle down past unit 2.
const g = await page.$$('.re-unit > .re-row .re-grip, .re-unit .re-ss-label .re-grip');
const b1 = await (await page.$('.re-unit:nth-child(1)')).boundingBox();
const b2 = await (await page.$('.re-unit:nth-child(2)')).boundingBox();
const grip = await g[0].boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2, grip.y + 20, { steps: 5 });
await page.mouse.move(grip.x + grip.width / 2, b2.y + b2.height, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(350);
const after = await rowNames();
console.log('   after :', after.slice(0, 3).join(' | '));
eq(after[0], before[1], 'dragging unit 1 down moved unit 2 up into first place');
eq(after[1], before[0], 'and the dragged exercise is now second');
eq(new Set(after).size, new Set(before).size, 'no exercise was lost or duplicated by the drag');
await shot(page, '10-after-drag');

console.log('\n── Editor: order persists through save ──────────────────');
await page.click('#reSave');
await page.waitForSelector('#routineEditor.visible', { state: 'hidden' });
await page.waitForTimeout(400);
const saved = (await tpl()).find(t => t.name.startsWith('Upper Strength'));
eq(saved.exercises.slice(0, 2).map(e => e.name), after.slice(0, 2), 'the dragged order is what got stored');

console.log('\n── Editor: Back DISCARDS changes ────────────────────────');
await openFirstRoutine();
const origName = await page.inputValue('#reName');
await page.fill('#reName', 'Should Not Persist');
await page.click('#reBack');
await page.waitForTimeout(400);
ok(!(await page.isVisible('#routineEditor.visible')), 'a confirmed discard closes the editor');
ok(dialogs.some(d => /Discard your changes/.test(d.message)), 'it asks before discarding');
eq((await tpl()).some(t => t.name === 'Should Not Persist'), false, 'the discarded name was never written');
eq((await tpl()).some(t => t.name === origName), true, 'the original name survives');

console.log('\n── Editor: build a NEW routine from scratch ─────────────');
await page.waitForSelector('.lib-plan-add');
await page.click('.lib-plan-add');
await page.waitForSelector('#routineEditor.visible');
eq(await page.textContent('#reTitle'), 'New routine', 'opens in create mode');
ok(!(await page.isVisible('#reDelete')), 'no delete button on a routine that does not exist yet');
await page.fill('#reName', 'E2E Built Routine');
for (const term of ['Squat', 'Plank']) {
  await page.click('#reAddEx');
  await page.waitForSelector('#exercisePicker.visible');
  await page.fill('#epSearch', term);
  await page.waitForTimeout(350);
  await page.click('.ep-item');
  await page.waitForTimeout(350);
}
eq((await rowNames()).length, 2, 'both picked exercises landed in the routine');
await shot(page, '11-new-routine');
const nBefore = (await tpl()).length;
await page.click('#reSave');
await page.waitForSelector('#routineEditor.visible', { state: 'hidden' });
await page.waitForTimeout(500);
const built = (await tpl()).find(t => t.name === 'E2E Built Routine');
ok(!!built, 'the new routine was saved');
eq((await tpl()).length, nBefore + 1, 'exactly one routine was added');
eq(built.exercises.length, 2, 'with its two exercises');
ok(built.exercises.every(e => e.sets?.length), 'each exercise got set targets');
ok((await plans())[0].routineIds.includes(built.id), 'it was filed into the plan it was created from');
eq((await plans())[0].routineIds.at(-1), built.id, 'and appended at the end of the plan');

console.log('\n── Library: add a split → it becomes its own plan ───────');
await page.click('#libBrowseSplits');
await page.waitForSelector('#routineLibrary.visible');
await shot(page, '12-splits');
await page.click('.split-card');
await page.waitForSelector('#libraryDetail.visible');
const splitName = await page.textContent('#libraryDetailTitle');
await page.click('#libraryAddBtn');
await page.waitForTimeout(800);
const ps = await plans();
eq(ps.length, 2, 'adding a split created a second plan');
const added = ps.find(p => p.name === splitName);
ok(!!added, `the plan is named after the split ("${splitName}")`);
ok(!!added.splitId, 'and carries the split id, so re-adding is detectable');
eq(await dbGet(page, 'active-plan'), added.id, 'the added split became the active plan');
ok(added.routineIds.length > 0, `it holds its ${added.routineIds.length} days`);
await page.waitForTimeout(300);
await shot(page, '13-two-plans');

console.log('\n── Splits: logType + supersetId are no longer dropped ───');
const dayTpls = (await tpl()).filter(t => added.routineIds.includes(t.id));
ok(dayTpls.every(t => t.exercises.every(e => e.logType)), 'every added exercise carries a logType');

console.log('\n── Library: re-adding the same split is not silent ──────');
await page.click('#libBrowseSplits');
await page.waitForSelector('#routineLibrary.visible');
await page.click('.split-card');
await page.waitForSelector('#libraryDetail.visible');
await page.click('#libraryAddBtn');
await page.waitForTimeout(700);
eq((await plans()).length, 2, 're-adding the same split does not duplicate the plan');
ok(dialogs.some(d => /already one of your plans/.test(d.message)), 'and says so plainly');

console.log('\n── Plan menu: rename, set active, delete keeps routines ──');
await page.waitForSelector('.lib-plan');
const planCount0 = (await plans()).length;
await page.click('.lib-plan:nth-child(1) [data-menu]');
await page.waitForSelector('[data-act="rename"]');
await page.click('[data-act="active"]');
await page.waitForTimeout(500);
eq(await dbGet(page, 'active-plan'), (await plans())[0].id, 'menu → make active switches the active plan');

const tplBefore = (await tpl()).length;
const target = (await plans())[0];
await page.click('.lib-plan:nth-child(1) [data-menu]');
await page.waitForSelector('[data-act="delete"]');
await page.click('[data-act="delete"]');
await page.waitForTimeout(700);
eq((await plans()).length, planCount0 - 1, 'the plan was deleted');
eq((await tpl()).length, tplBefore, 'deleting a plan deleted NO routines');
await page.waitForTimeout(300);
const unfiledShown = await page.$$eval('.lib-plan-name', n => n.map(x => x.textContent));
ok(unfiledShown.includes('Not in a plan'), 'its routines are still reachable under "Not in a plan"');
ok(!!(await dbGet(page, 'active-plan')), 'an active plan still exists after the deletion');
await shot(page, '14-plan-deleted');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
