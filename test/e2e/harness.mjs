import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');
const STUB = path.join(HERE, 'supabase-stub.js');
const SHOTS = process.env.ARC_SHOTS || path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png' };

export async function serve(port = 4173) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('nope'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(port, r));
  return server;
}

export async function boot({ port = 4173, seed = null } = {}) {
  const browser = await chromium.launch({ ...(process.env.ARC_CHROME ? { executablePath: process.env.ARC_CHROME } : {}), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  // Serve the test double in place of the real Supabase module, and block the
  // service worker so a stale cache can never mask a change.
  await ctx.route('**/shared/supabase.js', route =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(STUB, 'utf8') }));
  await ctx.route('**/sw.js', route => route.fulfill({ status: 404, body: '' }));
  await ctx.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await ctx.route('https://fonts.googleapis.com/**', route => route.abort());

  const page = await ctx.newPage();
  // One dialog handler for the whole run — confirm()/alert() are load-bearing in
  // this app (delete confirms, save acks), and two handlers racing the same
  // dialog is what made clicks look "unstable".
  const dialogs = [];
  page.on('dialog', d => { dialogs.push({ type: d.type(), message: d.message() }); d.accept().catch(() => {}); });
  // The harness deliberately 404s sw.js and aborts the CDN, so the noise that
  // causes is the harness's own and is filtered here rather than in every suite.
  const HARNESS_NOISE = /sw\.js|ServiceWorker|ERR_FAILED|bad HTTP response code \(404\)/;
  const errors = [];
  const note = s => { if (!HARNESS_NOISE.test(s)) errors.push(s); };
  page.on('pageerror', e => note(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') note(`console: ${m.text()}`); });

  if (seed) {
    await page.addInitScript(rows => {
      window.__seed = rows;
      const open = indexedDB.open('life-dashboard', 1);
      open.onupgradeneeded = e => {
        const db = e.target.result;
        for (const s of ['calories', 'workout', 'habits'])
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      window.__seeded = new Promise(res => {
        open.onsuccess = e => {
          const db = e.target.result;
          const tx = db.transaction('workout', 'readwrite');
          const st = tx.objectStore('workout');
          for (const [k, v] of Object.entries(rows)) st.put(v, k);
          tx.oncomplete = () => res(true);
        };
      });
    }, seed);
  }

  await page.goto(`http://localhost:${port}/workout/`, { waitUntil: 'domcontentloaded' });
  if (seed) await page.evaluate(() => window.__seeded);
  await page.waitForSelector('#secDashboard.active', { timeout: 20000 });
  await page.waitForTimeout(900);   // let the init chain settle
  return { browser, ctx, page, errors, dialogs };
}

export const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` });

// Read a key straight out of IndexedDB — assertions go against stored state,
// not against what the DOM happens to be showing.
export const dbGet = (page, key) => page.evaluate(k => new Promise(res => {
  const o = indexedDB.open('life-dashboard', 1);
  o.onsuccess = e => {
    const r = e.target.result.transaction('workout', 'readonly').objectStore('workout').get(k);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => res(null);
  };
}), key);
