import { serve, boot, shot, dbGet, seedSessions } from './harness.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`));
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `\n         got ${JSON.stringify(a)}\n         exp ${JSON.stringify(b)}`}`);

const server = await serve();
const { browser, page, errors } = await boot({ seed: seedSessions() });

// Read what a superset group actually LOOKS like: the rail's rendered colour and
// the label above it. Computed styles, so this fails if the CSS variable never
// reaches the border.
const groups = () => page.evaluate(() => {
  const out = [];
  document.querySelectorAll('#awBody .ex-block.ss-first').forEach(b => {
    out.push({
      label: b.querySelector('.ss-label')?.textContent.trim().replace(/\s+/g, ' '),
      rail: getComputedStyle(b).borderLeftColor,
      labelColor: getComputedStyle(b.querySelector('.ss-label')).color,
    });
  });
  return out;
});
const pairUp = async (anchorName, partnerIdx) => {
  const blocks = await page.$$('#awBody .ex-block');
  for (const b of blocks) {
    const n = await b.$eval('.ex-name', e => e.textContent.trim()).catch(() => '');
    if (!n.startsWith(anchorName)) continue;
    await b.$eval('.ex-menu-btn', e => e.click());
    break;
  }
  await page.waitForSelector('#exMenuSuperset');
  await page.click('#exMenuSuperset');
  await page.waitForSelector('.ss-pick');
  await page.click(`.ss-pick[data-i="${partnerIdx}"]`);
  await page.click('[data-act="done"]');
  await page.waitForTimeout(400);
};

console.log('\n── Start a routine with enough exercises to pair twice ──');
await page.click('.ph-row:nth-child(1)');
await page.waitForSelector('#activeWorkout.visible');
await page.waitForTimeout(500);
const names = await page.$$eval('#awBody .ex-name', n => n.map(x => x.textContent.trim()));
ok(names.length >= 4, `the session has ${names.length} exercises`);
eq(await groups(), [], 'no superset groups to begin with');

console.log('\n── First pair ──────────────────────────────────────────');
await pairUp(names[0].slice(0, 12), 1);
let g = await groups();
eq(g.length, 1, 'one group after pairing the first two');
eq(g[0].label, 'Superset A', 'it is labelled A, not just "Superset"');
ok(g[0].rail !== 'rgba(0, 0, 0, 0)', `its rail is drawn (${g[0].rail})`);
eq(g[0].rail, g[0].labelColor, 'the label matches the rail');
await shot(page, 'S1-one-group');

console.log('\n── Second pair — the reported bug ──────────────────────');
const after = await page.$$eval('#awBody .ex-name', n => n.map(x => x.textContent.trim()));
await pairUp(after[2].slice(0, 12), 3);
g = await groups();
eq(g.length, 2, 'two groups coexist');
eq(g.map(x => x.label), ['Superset A', 'Superset B'], 'they are lettered A and B');
ok(g[0].rail !== g[1].rail,
   `and drawn in DIFFERENT colours (${g[0].rail} vs ${g[1].rail}) — every group used to be the same purple`);
await shot(page, 'S2-two-groups');

console.log('\n── The menu names which group you are editing ──────────');
const blocks = await page.$$('#awBody .ex-block.ss-first');
await blocks[1].$eval('.ex-menu-btn', e => e.click());
await page.waitForSelector('#exMenuSuperset');
const menuLabel = (await page.textContent('#exMenuSuperset')).trim();
ok(/Edit superset B/.test(menuLabel), `the menu says "${menuLabel}", not an ambiguous "Edit superset…"`);
await page.click('[data-act="cancel"], .sheet-btn:last-child');
await page.waitForTimeout(300);

console.log('\n── Colours survive a re-render and reach the template ──');
await page.click('#awMinimise, .aw-back, #awBack').catch(() => {});
await page.waitForTimeout(300);
const stillTwo = await groups();
eq(stillTwo.map(x => x.rail), g.map(x => x.rail), 'the same two colours after re-render');

console.log('\n── Ungrouping the first promotes the second ────────────');
const b0 = (await page.$$('#awBody .ex-block.ss-first'))[0];
await b0.$eval('.ex-menu-btn', e => e.click());
await page.waitForSelector('#exMenuSuperset');
await page.click('#exMenuSuperset');
await page.waitForSelector('[data-act="ungroup"]');
await page.click('[data-act="ungroup"]');
await page.waitForTimeout(500);
const left = await groups();
eq(left.length, 1, 'one group remains');
eq(left[0].label, 'Superset A', 'and it is relettered A rather than staying B with a gap');

console.log(`\n${pass} passed, ${fail} failed`);
console.log('page errors:', errors.length ? errors : 'none');
await browser.close(); server.close();
process.exit(fail || errors.length ? 1 : 0);
