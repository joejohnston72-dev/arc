// Runs every e2e suite in sequence and reports a combined result.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'e2e');
const suites = fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const s of suites) {
  console.log(`\n╭─ ${s} ${'─'.repeat(Math.max(0, 50 - s.length))}`);
  const r = spawnSync(process.execPath, [path.join(dir, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} of ${suites.length} suites FAILED` : `\nall ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
