import { serve, boot, shot, dbGet, seedSessions } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

// One session logs the row under a variation name that is merged into Barbell
// Row, so its exercise detail shows an identity chip with an un-merge control.
const seed = seedSessions();
seed['session-seed1'].exercises[0].name = 'Pendlay Row';
seed['exercise-aliases'] = { 'pendlay row': 'Barbell Row' };

const server = await serve();
const { browser, page, errors } = await boot({ seed });

console.log('\n── The streak modal has a real owner ───────────────────');
ok(!(await page.$('#streakChip')), 'the permanently display:none proxy element is gone');
await page.click('#tileStreak');
await page.waitForSelector('#streakModal.open');
ok(true, 'the streak tile opens the settings directly');
await page.fill('#streakTargetInput', '5');
await page.click('#streakSave');
await page.waitForTimeout(700);
eq(((await dbGet(page, 'streak-settings')) || {}).target, 5, 'saving persists the new target');
const sub = await page.textContent('#tileStreak');
ok(/\/ 5/.test(sub), `and Today reflects it straight away ("${sub.replace(/\s+/g, ' ').trim()}")`);
await shot(page, 'A1-streak');

console.log('\n── Editable fields in a history detail say so ──────────');
await page.click('.workout-card');
await page.waitForSelector('#historyDetail.visible');
await page.waitForTimeout(400);
const labels = await page.$$eval('#hdDateBox .stat-label, #hdDurBox .stat-label', l => l.map(e => e.textContent.trim()));
eq(labels, ['Edit date', 'Edit duration'], 'the date and duration boxes are labelled as editable');
await shot(page, 'A2-history-detail');
await page.click('#hdDateBox');
await page.waitForSelector('#hdDateModal.open');
ok(true, 'tapping one opens the editor');
await page.click('#hdDateCancel');
await page.click('#hdBack');
await page.waitForTimeout(300);

console.log('\n── Small hit targets ───────────────────────────────────');
await page.evaluate(() => document.querySelector('.tab[data-tab="Stats"]').click());
await page.waitForTimeout(900);
await page.$eval('.pr-info[data-ex="Barbell Row"]', e => e.click());
await page.waitForSelector('#exerciseDetail.visible');
await page.waitForTimeout(400);
const x = await page.$('.ed-id-x');
ok(!!x, 'the merged variation shows an un-merge control');
if (x) {
  const h = await x.evaluate(e => e.getBoundingClientRect().height);
  ok(h >= 32, `the un-merge control is ${Math.round(h)}px tall, not a 16px glyph`);
}
await shot(page, 'A3-unmerge');

console.log('\n── Dead badge machinery is gone ────────────────────────');
const dead = await page.evaluate(() => {
  const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
  return css.some(r => r.selectorText === '.tab-badge');
});
ok(!dead, 'the .tab-badge rule nothing could ever add is removed');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
