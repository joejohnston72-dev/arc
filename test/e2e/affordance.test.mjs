import { serve, boot, shot, dbGet, seedSessions } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors } = await boot({ seed: seedSessions() });

console.log('\n── Everything tappable on Today says so ────────────────');
const tiles = await page.$$eval('.snap-tile', ts => ts.map(t => ({
  id: t.id, role: t.getAttribute('role'), go: !!t.querySelector('.snap-go'),
})));
eq(tiles.length, 3, 'three snapshot tiles');
ok(tiles.every(t => t.go), 'each carries a corner glyph saying it opens something');
ok(tiles.every(t => t.role === 'button'), 'and is exposed as a button to assistive tech');
await shot(page, 'A1-tiles');

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

console.log('\n── Things that are NOT tappable stop looking it ────────');
await page.click('.tab[data-tab="Stats"]');
await page.waitForTimeout(900);
const tag = await page.$eval('.wc-ex-tag', e => {
  const s = getComputedStyle(e);
  return { bg: s.backgroundColor, radius: s.borderRadius, pad: s.paddingLeft };
});
ok(/rgba\(0, 0, 0, 0\)|transparent/.test(tag.bg), 'exercise names in a history card have no pill fill');
eq(tag.radius, '0px', 'and no pill radius — they read as text, like the filter chips do not');
const chip = await page.evaluate(() => {
  const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
  const r = css.find(r => r.selectorText === '.lib-chip');
  return { bg: r.style.background || r.style.backgroundColor, radius: r.style.borderRadius };
});
ok(!!chip.radius && chip.radius !== '0px', `while a real filter chip keeps its pill (${chip.radius})`);

console.log('\n── Editable fields in a history detail look editable ───');
await page.click('.workout-card');
await page.waitForSelector('#historyDetail.visible');
await page.waitForTimeout(400);
const boxes = await page.$$eval('.hd-editable', b => b.map(e => ({
  border: getComputedStyle(e).borderLeftWidth,
  label: e.querySelector('.stat-label').textContent.trim(),
  colour: getComputedStyle(e.querySelector('.stat-label')).color,
})));
eq(boxes.length, 2, 'the date and duration boxes are marked editable');
ok(boxes.every(b => b.border !== '0px'), 'they carry a border the read-only figures do not');
ok(boxes.every(b => /^Edit /.test(b.label)), `and say so: ${JSON.stringify(boxes.map(b => b.label))}`);
await shot(page, 'A2-history-detail');
await page.click('#hdDateBox');
await page.waitForSelector('#hdDateModal.open');
ok(true, 'tapping one opens the editor');
await page.click('#hdDateCancel');

console.log('\n── Small hit targets ───────────────────────────────────');
await page.click('#hdBack');
await page.waitForTimeout(300);
await page.click('.tab[data-tab="Library"]');
await page.waitForSelector('#libSeg');
await page.click('#libSeg button[data-seg="exercises"]');
await page.waitForTimeout(500);
await page.click('.lib-row');
await page.waitForSelector('#exerciseDetail.visible');
await page.waitForTimeout(400);
const x = await page.$('.ed-id-x');
if (x) {
  const h = await x.evaluate(e => e.getBoundingClientRect().height);
  ok(h >= 28, `the un-merge control is ${Math.round(h)}px tall, not a 12px glyph`);
} else { ok(true, 'no merged identities on this exercise — nothing to size'); }

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
