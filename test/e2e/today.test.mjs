import { serve, boot, shot, dbGet, seedSessions } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors, dialogs } = await boot({ seed: seedSessions() });
const plans = async () => (await dbGet(page, 'plans')) || [];

console.log('\n── Today: the hero is the ACTIVE PLAN ───────────────────');
await shot(page, 'T1-today');
eq(await page.textContent('.ph-eyebrow'), ' ACTIVE PLAN', 'hero is labelled as the active plan');
eq((await page.textContent('.ph-name')).trim(), 'My split', 'it names the plan, not a single routine');
ok(!(await page.isVisible('.next-card')), 'the old "next in your split" hero is gone');
ok(!(await page.$('.next-eyebrow')), 'and so is its eyebrow');
const rows = await page.$$eval('.ph-row-name', n => n.map(x => x.textContent));
eq(rows.length, 5, 'every routine in the plan is offered');
const tpls = await dbGet(page, 'templates');
const ids = (await plans())[0].routineIds;
eq(rows, ids.map(id => tpls.find(t => t.id === id).name), 'in the plan\'s own order, not a ranking');
ok(await page.isVisible('#phEmpty'), 'an empty workout is still one tap away');
ok(await page.isVisible('#phChange'), 'and the plan can be changed from here');

console.log('\n── Hierarchy: three layers, measurably different ────────');
const px = s => page.$eval(s, e => parseFloat(getComputedStyle(e).fontSize));
const eyebrow = await px('.dash-weekday');
const heroName = await px('.ph-name');
ok(heroName > eyebrow * 1.8,
   `the session name (${heroName}px) now outweighs the date (${eyebrow}px) — it was the other way round`);
const hist = await page.$eval('.dash-hrow', e => {
  const s = getComputedStyle(e);
  return { border: s.borderLeftWidth, bg: s.backgroundColor, pad: s.paddingLeft };
});
eq(hist.border, '0px', 'history rows carry no 4px rail');
ok(/rgba\(0, 0, 0, 0\)|transparent/.test(hist.bg), 'and no card fill — they sit on the page');
const heroBg = await page.$eval('.plan-hero', e => getComputedStyle(e).backgroundImage);
ok(heroBg.includes('gradient'), 'only the hero carries a gradient');

console.log('\n── Tapping a routine starts THAT routine ────────────────');
await page.click('.ph-row:nth-child(2)');
await page.waitForSelector('#activeWorkout.visible');
const title = await page.inputValue('#awTitle');
eq(title, rows[1], 'the second row started the second routine, not a recommended one');
await shot(page, 'T2-started');
await page.click('#awFinishBtn');
await page.waitForSelector('#workoutSummary.visible');
await page.click('#discardBtn');          // teardown — nothing was logged
await page.waitForTimeout(700);
ok(!(await page.isVisible('#activeWorkout.visible')), 'and Finish → Discard closes it cleanly');

console.log('\n── Change plan from the hero ────────────────────────────');
await page.click('.tab[data-tab="Library"]');
await page.waitForSelector('#libBrowseSplits');
await page.click('#libBrowseSplits');
await page.waitForSelector('#routineLibrary.visible');
await page.click('.split-card');
await page.waitForSelector('#libraryDetail.visible');
const splitName = await page.textContent('#libraryDetailTitle');
await page.click('#libraryAddBtn');
await page.waitForTimeout(800);
await page.click('.tab[data-tab="Dashboard"]');
await page.waitForTimeout(600);
eq((await page.textContent('.ph-name')).trim(), splitName, 'adding a split makes it the hero');
await page.click('#phChange');
await page.waitForSelector('.modal-backdrop.open [data-pid]');
await shot(page, 'T3-plan-switcher');
const other = await page.$$('.modal-backdrop.open [data-pid]');
await other[0].click();
await page.waitForTimeout(700);
eq((await page.textContent('.ph-name')).trim(), 'My split', 'the switcher changes the active plan');
eq(await dbGet(page, 'active-plan'), (await plans())[0].id, 'and persists it');

console.log('\n── "+N more" opens the chooser, grouped by plan ─────────');
await page.click('.tab[data-tab="Dashboard"]');
await page.waitForTimeout(400);
ok(!(await page.$('#phMore')), 'a 5-routine plan needs no overflow link');
// switch to the 6-day split, which does overflow
await page.click('#phChange');
await page.waitForSelector('.modal-backdrop.open [data-pid]');
const pids = await page.$$('.modal-backdrop.open [data-pid]');
await pids[1].click();
await page.waitForTimeout(700);
ok(await page.isVisible('#phMore'), 'a 6-routine plan offers "+1 more"');
await page.click('#phMore');
await page.waitForSelector('#routineChooser.open');
const groups = await page.$$eval('.tc-group', g => g.map(x => x.textContent));
ok(groups.length >= 2, `the chooser groups by plan: ${JSON.stringify(groups)}`);
eq(groups[0], splitName, 'the active plan comes first');
ok(groups.includes('Other routines'), 'routines outside it are grouped separately');
await shot(page, 'T4-chooser');
await page.click('#chooserClose');

console.log('\n── "All history" lands on the history ───────────────────');
await page.waitForTimeout(300);
await page.click('#dashAllHistory');
await page.waitForTimeout(1800);   // smooth scroll over a long page
const onScreen = await page.$eval('#histSearch', e => {
  const r = e.getBoundingClientRect();
  return r.top >= 0 && r.top < window.innerHeight;
});
ok(onScreen, 'the history search field is in view, not far below the fold');
await shot(page, 'T5-history');

console.log('\n── Empty state when there is no plan at all ─────────────');
await page.evaluate(async () => {
  const o = indexedDB.open('life-dashboard', 1);
  await new Promise(res => { o.onsuccess = e => {
    const tx = e.target.result.transaction('workout', 'readwrite');
    tx.objectStore('workout').put([], 'plans');
    tx.objectStore('workout').put([], 'templates');
    tx.oncomplete = res; }; });
});
// app.js is a module, so its functions aren't reachable from the page — go
// through a tab switch, which re-renders Today the way the app itself does.
await page.click('.tab[data-tab="Library"]');
await page.waitForTimeout(300);
await page.click('.tab[data-tab="Dashboard"]');
await page.waitForTimeout(700);
ok(await page.isVisible('#phEmpty'), 'the empty state still offers an empty workout');
ok(await page.isVisible('#phBrowse'), 'and a route to the splits library');
eq((await page.textContent('.ph-name')).trim(), 'No plan yet', 'and says plainly that there is no plan');
await shot(page, 'T6-empty');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
