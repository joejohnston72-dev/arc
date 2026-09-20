import { serve, boot, shot, dbGet, seedSessions } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors } = await boot({ seed: seedSessions() });
await page.click('.tab[data-tab="Coach"]');
await page.waitForSelector('#secCoach.active');
await page.waitForTimeout(500);
await shot(page, 'X1-coach');

console.log('\n── The composer is a real multi-line field ──────────────');
eq(await page.$eval('#coachInput', e => e.tagName), 'TEXTAREA', 'it is a textarea, not a single-line input');
const fonts = await page.evaluate(() => ({
  input: getComputedStyle(document.getElementById('coachInput')).fontFamily,
  body:  getComputedStyle(document.body).fontFamily,
  size:  getComputedStyle(document.getElementById('coachInput')).fontSize,
}));
eq(fonts.input, fonts.body, 'it uses the app font, not the system fallback');
eq(fonts.size, '16px', 'and stays at the 16px iOS-zoom floor');

console.log('\n── Return adds a line; it does not send ─────────────────');
await page.click('#coachInput');
const h0 = await page.$eval('#coachInput', e => e.getBoundingClientRect().height);
await page.type('#coachInput', 'My left shoulder has been grumbling on incline pressing.');
await page.keyboard.press('Enter');
await page.type('#coachInput', 'Should I drop it, or swap to something else?');
await page.waitForTimeout(250);
const val = await page.inputValue('#coachInput');
ok(val.includes('\n'), 'Return inserted a newline into the field');
eq(await page.$$eval('.coach-msg.user', m => m.length), 0, 'and did NOT send the half-written question');
const h1 = await page.$eval('#coachInput', e => e.getBoundingClientRect().height);
ok(h1 > h0, `the field grew to fit it (${Math.round(h0)}px → ${Math.round(h1)}px)`);
await shot(page, 'X2-multiline');

console.log('\n── Text wraps rather than scrolling sideways ────────────');
const wrap = await page.$eval('#coachInput', e => ({
  scrollW: e.scrollWidth, clientW: e.clientWidth,
  white: getComputedStyle(e).whiteSpace, resize: getComputedStyle(e).resize,
}));
ok(wrap.scrollW <= wrap.clientW + 1, 'no horizontal overflow — the text wraps');
eq(wrap.resize, 'none', 'and the drag handle is suppressed');

console.log('\n── It grows to a limit, then scrolls ───────────────────');
await page.fill('#coachInput', Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n'));
await page.waitForTimeout(250);
const tall = await page.$eval('#coachInput', e => ({
  h: e.getBoundingClientRect().height, max: parseFloat(getComputedStyle(e).maxHeight), scroll: e.scrollHeight,
}));
ok(tall.h <= tall.max + 1, `it stops at ~${Math.round(tall.max)}px instead of eating the thread`);
ok(tall.scroll > tall.h, 'and scrolls beyond that');
await shot(page, 'X3-capped');

console.log('\n── Cmd/Ctrl+Return sends ───────────────────────────────');
await page.fill('#coachInput', 'What is a good substitute for barbell rows?');
await page.keyboard.down('Control');
await page.keyboard.press('Enter');
await page.keyboard.up('Control');
await page.waitForTimeout(600);
eq(await page.$$eval('.coach-msg.user', m => m.length), 1, 'the question was sent');
eq(await page.inputValue('#coachInput'), '', 'and the field was cleared');
const hAfter = await page.$eval('#coachInput', e => e.getBoundingClientRect().height);
ok(Math.abs(hAfter - h0) < 4, 'the field shrank back rather than staying tall');

console.log('\n── No dead strip above the tab bar ──────────────────────');
const gap = await page.evaluate(() => {
  const input = document.querySelector('.coach-input').getBoundingClientRect();
  const tabs  = document.querySelector('.tabs').getBoundingClientRect();
  return Math.round(tabs.top - input.bottom);
});
ok(gap >= 0 && gap <= 26, `the composer sits ${gap}px above the tab bar, not floating clear of it`);
const sec = await page.evaluate(() => {
  const r = document.getElementById('secCoach').getBoundingClientRect();
  const t = document.querySelector('.tabs').getBoundingClientRect();
  return Math.round(t.top - r.bottom);
});
ok(Math.abs(sec) <= 2, 'the coach column ends exactly at the tab bar (safe area counted once, not twice)');

console.log('\n── The column makes room for the keyboard ───────────────');
// Headless Chromium never shows a keyboard, so drive the variable the way
// fitCoachColumn() does and check the plumbing it feeds. Before this, #secCoach
// was fixed to the layout viewport with NO visualViewport handling at all, so
// the keyboard simply covered the composer.
const bottomRule = await page.$eval('#secCoach', e => getComputedStyle(e).bottom);
const beforeKb = await page.$eval('.coach-input', e => Math.round(e.getBoundingClientRect().bottom));
await page.$eval('#secCoach', e => e.style.setProperty('--kb', '300px'));
await page.waitForTimeout(200);
const afterKb = await page.$eval('.coach-input', e => Math.round(e.getBoundingClientRect().bottom));
ok(beforeKb - afterKb >= 290, `a 300px keyboard lifts the composer by ${beforeKb - afterKb}px`);
await shot(page, 'X5-keyboard');
await page.$eval('#secCoach', e => e.style.setProperty('--kb', '0px'));
await page.waitForTimeout(200);
eq(await page.$eval('.coach-input', e => Math.round(e.getBoundingClientRect().bottom)), beforeKb,
   'and it drops back when the keyboard closes');

console.log('\n── Key and clear are reachable ─────────────────────────');
for (const id of ['coachKeyBtn', 'coachClearBtn']) {
  const box = await page.$eval('#' + id, e => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, right: r.right }; });
  ok(box.x >= 0 && box.right <= 390, `#${id} is on screen (x=${Math.round(box.x)})`);
}
const inChips = await page.$$eval('#coachChips button', b => b.length);
ok(inChips >= 3, `the chip row still carries its ${inChips} prompts`);
ok(!(await page.$('#coachChips #coachKeyBtn')), 'and no longer hides the key button past its right edge');

console.log('\n── Bubble widths agree ─────────────────────────────────');
const widths = await page.evaluate(() => {
  const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } });
  const get = sel => css.filter(r => r.selectorText === sel).map(r => r.style.maxWidth).filter(Boolean);
  return { msg: get('.coach-msg'), routine: get('.coach-routine') };
});
eq(widths.msg[0], widths.routine[0], `a reply and a routine card are the same width (${widths.msg[0]})`);

console.log('\n── The memory strip scrolls with the thread ────────────');
ok(await page.$eval('#coachMem', e => e.parentElement.id === 'coachThread'),
   'it is inside the thread, not pinned above it');
await page.click('#coachClearBtn');
await page.waitForTimeout(600);
ok(!!(await page.$('#coachMem')), 'and clearing the chat does not destroy it');
ok(!!(await page.$('.coach-empty')), 'the empty state comes back');
await shot(page, 'X4-cleared');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
