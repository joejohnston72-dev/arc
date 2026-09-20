import { serve, boot, shot, dbGet, seedCoachHistory } from './harness.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors } = await boot({ seed: { ...seedCoachHistory(), 'coach-daily': {
  date: TODAY,
  text: 'Run Pull A today, not Legs — back is your freshest group at 5 days.',
  suggestion: { routine: 'Push Hypertrophy (Delts)',
                operations: [{ action: 'add', newExercise: 'Face Pull', sets: 3, reps: 15, category: 'Shoulders' }] },
} } });
const eyebrow = () => page.textContent('.ch-eyebrow').then(t => t.trim());
const counter = () => page.textContent('.ch-count').then(t => t.trim());

console.log('\n── One card, not a stack ────────────────────────────────');
await page.waitForSelector('.coach-hub');
await shot(page, 'C1-hub');
eq(await page.$$eval('.coach-hub', h => h.length), 1, 'exactly one coach card is on screen');
ok(!(await page.$('.coach-finding')), 'the old stacked finding cards are gone');
ok(!(await page.$('.dash-weekly')), 'and so is the standalone weekly card');
const total = +(await counter()).split('/')[1];
ok(total >= 3, `the queue holds ${total} items, shown one at a time`);
eq((await counter()).split('/')[0].trim(), '1', 'starting on the first');
ok(await page.isVisible('.ch-dots'), 'with dots showing how many there are');
eq(await page.$$eval('.ch-dot', d => d.length), total, 'one dot per queued item');

console.log('\n── Paging ──────────────────────────────────────────────');
const first = await eyebrow();
ok(await page.$eval('.ch-pg[data-dir="-1"]', b => b.disabled), 'back is disabled on the first card');
await page.click('.ch-pg[data-dir="1"]');
await page.waitForTimeout(250);
const second = await eyebrow();
ok(first !== second, `next moves to a different item ("${first}" → "${second}")`);
eq((await counter()).split('/')[0].trim(), '2', 'the counter follows');
eq(await page.$$eval('.ch-dot.on', d => d.length), 1, 'exactly one dot is lit');
// Walk from where we are to the end, collecting each item's accent.
const colours = [];
let at = +(await counter()).split('/')[0];
for (;;) {
  colours.push(await page.$eval('.coach-hub', h => getComputedStyle(h).getPropertyValue('--ch-color').trim()));
  if (at >= total) break;
  await page.click('.ch-pg[data-dir="1"]');
  await page.waitForTimeout(220);
  at = +(await counter()).split('/')[0];
}
ok(await page.$eval('.ch-pg[data-dir="1"]', b => b.disabled), 'forward is disabled on the last card');
ok(new Set(colours).size > 1, `items carry different accents: ${JSON.stringify([...new Set(colours)])}`);
await shot(page, 'C2-last');
await page.click('.ch-pg[data-dir="-1"]');
await page.waitForTimeout(250);
eq(+(await counter()).split('/')[0].trim(), total - 1, 'back steps one item');

console.log('\n── Swipe pages too ─────────────────────────────────────');
const box = await page.$eval('.coach-hub', h => { const r = h.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const idxBefore = +(await counter()).split('/')[0];
await page.mouse.move(box.x + box.w - 30, box.y + 12);
await page.mouse.down();
await page.mouse.move(box.x + 30, box.y + 14, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
eq(+(await counter()).split('/')[0], Math.min(idxBefore + 1, total), 'swiping left advances');
await page.mouse.move(box.x + 30, box.y + 12);
await page.mouse.down();
await page.mouse.move(box.x + box.w - 30, box.y + 14, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
eq(+(await counter()).split('/')[0], idxBefore, 'swiping right goes back');

console.log('\n── Every item can be dismissed ─────────────────────────');
// Walk the whole queue and confirm each card offers a way out — find-balance
// and find-progress had no dismiss at all, so they were stuck on Home forever.
await page.click('.tab[data-tab="Library"]'); await page.waitForTimeout(200);
await page.click('.tab[data-tab="Dashboard"]'); await page.waitForTimeout(600);
let missing = [];
for (;;) {
  const labels = await page.$$eval('.ch-btn', b => b.map(x => x.textContent.trim()));
  if (!labels.some(l => /dismiss/i.test(l))) missing.push(await eyebrow());
  const here = +(await counter()).split('/')[0];
  if (here >= total) break;
  await page.click('.ch-pg[data-dir="1"]');
  await page.waitForTimeout(220);
}
eq(missing, [], 'no card is stuck without a dismiss');

console.log('\n── Dismissing removes it from the queue ────────────────');
await page.click('.tab[data-tab="Library"]'); await page.waitForTimeout(200);
await page.click('.tab[data-tab="Dashboard"]'); await page.waitForTimeout(600);
const before = +(await counter()).split('/')[1];
const dismissBtn = (await page.$$('.ch-btn')).find(async b => /dismiss/i.test(await b.textContent()));
const labels0 = await page.$$eval('.ch-btn', b => b.map(x => x.textContent.trim()));
const di = labels0.findIndex(l => /dismiss/i.test(l));
if (di >= 0) {
  await (await page.$$('.ch-btn'))[di].click();
  await page.waitForTimeout(800);
  const after = await page.$('.ch-count') ? +(await counter()).split('/')[1] : 0;
  eq(after, before - 1, 'the queue is one shorter');
  const stored = await dbGet(page, 'suggestions-dismissed');
  ok((stored || []).length > 0, 'and the dismissal is persisted');
} else { ok(false, 'expected a dismiss button on the first card'); }
await shot(page, 'C3-after-dismiss');

console.log('\n── Ask → still reaches the Coach tab ───────────────────');
await page.click('.dash-coach-open');
await page.waitForTimeout(400);
ok(await page.isVisible('#secCoach.active'), '"Ask →" opens the Coach tab');

console.log('\n── The AI daily pick leads the queue ────────────────────');
await page.click('.tab[data-tab="Library"]'); await page.waitForTimeout(200);
await page.click('.tab[data-tab="Dashboard"]'); await page.waitForTimeout(700);
eq(await eyebrow(), "Coach · today's pick", "today's pick is the first thing the coach says");
ok(!!(await page.$('.coach-suggestion')), 'its suggested routine change rides inside the same card');
eq(await page.$$eval('.ch-body .cs-dismiss, .ch-actions .ch-btn', b => b.filter(x => /dismiss/i.test(x.textContent)).length),
   1, 'exactly one Dismiss on the card, not two meaning different things');

console.log('\n── An applied suggestion STAYS applied ──────────────────');
await page.click('.cs-apply');
await page.waitForTimeout(800);
await page.click('.tab[data-tab="Library"]'); await page.waitForTimeout(250);
await page.click('.tab[data-tab="Dashboard"]'); await page.waitForTimeout(800);
ok(await page.$eval('.cs-apply', b => b.disabled), 'Apply is still disabled after a full re-render');
eq((await page.textContent('.cs-apply')).trim(), '✓ Applied', 'and still reads as applied');
ok(((await dbGet(page, 'coach-daily')) || {}).suggestion?.applied === true, 'the applied flag was persisted');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
