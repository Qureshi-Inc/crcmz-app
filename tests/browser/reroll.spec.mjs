/**
 * Slap player: "Wrong song? Find the right one" — search, pick, replace, follow the job.
 *
 *   tests/browser/run.sh reroll.spec.mjs
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const BASE = process.env.CRCMZ_BASE || 'http://127.0.0.1:3099';
const CHROME = process.env.CRCMZ_CHROME ||
  '/home/opti3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

const failed = [];
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push(name); console.log(`  ✗ ${name}: ${e.message}`); }
}
function assert(ok, msg) { if (!ok) throw new Error(msg); }

const SOURCES = {
  query: 'Hasan Raheem Sahara',
  track: { title: 'Sahara', artist: 'Hasan Raheem', duration: 200 },
  candidates: [
    { url: 'https://www.youtube.com/watch?v=right', title: 'Hasan Raheem - Sahara (Official Audio)', channel: 'Hasan Raheem', duration_seconds: 201, view_count: 10, score: 0.86 },
    { url: 'https://www.youtube.com/watch?v=wrong', title: 'Sahara', channel: 'RAY LEMA', duration_seconds: 260, view_count: 5, score: 0.4 },
  ],
};

const browser = await chromium.launch({ executablePath: CHROME });
console.log('\n== slap reroll ==');

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const seen = { searches: [], replaced: [] };
  await ctx.route('**/*', route => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    const p = url.pathname;
    if (p === '/app' || p.startsWith('/app/') || p.endsWith('.png')) return route.continue();
    if (p === '/api/slap/tracks/t1/sources') {
      seen.searches.push(url.searchParams.get('q') || '');
      return route.fulfill({ json: SOURCES });
    }
    if (p === '/api/slap/tracks/t1/replace') {
      seen.replaced.push(req.postDataJSON().url);
      return route.fulfill({ json: { job: 'j1' } });
    }
    if (p === '/api/slap/rerolls/j1') return route.fulfill({ json: { tid: 't1', state: 'done', error: '', duration: 201 } });
    if (p.startsWith('/api/slap/stream/')) return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ json: {} });
  });
  await ctx.addInitScript(() => localStorage.setItem('slap.player.v1', JSON.stringify({
    queue: [{ id: 't1', title: 'Sahara', artist: 'Hasan Raheem', album: 'A', album_id: 'a', duration: 200, art: null, qid: 'q1' }],
    index: 0, shuffle: false, repeat: 'off', position: 0, order: null,
  })));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/settings`);
  await page.getByRole('button', { name: /open player: sahara/i }).click();
  await page.getByRole('button', { name: 'More for Sahara' }).click();
  await page.getByRole('menuitem', { name: /wrong song/i }).click();
  await page.locator('.reroll-row').first().waitFor();
  return { ctx, page, seen };
}

await check('lists the candidates, best match first', async () => {
  const { ctx, page, seen } = await open();
  assert(seen.searches.length === 1 && seen.searches[0] === '', `searched ${JSON.stringify(seen.searches)}`);
  const rows = page.locator('.reroll-row');
  assert(await rows.count() === 2, 'two rows');
  const first = await rows.first().textContent();
  assert(first.includes('Best match') && first.includes('Same length'), first);
  assert((await rows.nth(1).textContent()).includes('1:00 longer'), await rows.nth(1).textContent());
  const href = await rows.first().getByRole('link').getAttribute('href');
  assert(href === 'https://www.youtube.com/watch?v=right', href);
  await ctx.close();
});

await check('free-text search asks again', async () => {
  const { ctx, page, seen } = await open();
  await page.getByLabel(/search youtube/i).fill('sahara hasan raheem');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.locator('.reroll-row').first().waitFor();
  assert(seen.searches.at(-1) === 'sahara hasan raheem', JSON.stringify(seen.searches));
  // A free-text search keeps YouTube's order, so nothing is called the best match.
  assert(!(await page.locator('.reroll-tag').count()), 'no best-match tag');
  await ctx.close();
});

await check('pick, confirm, replace for everyone, then it reports done', async () => {
  const { ctx, page, seen } = await open();
  await page.getByRole('button', { name: /use hasan raheem - sahara/i }).click();
  await page.getByRole('heading', { name: 'Replace this song?' }).waitFor();
  await page.getByRole('button', { name: 'Replace for everyone' }).click();
  await page.locator('.reroll-dialog').waitFor({ state: 'detached' });
  assert(seen.replaced.join() === 'https://www.youtube.com/watch?v=right', seen.replaced.join());
  await page.getByText('Sahara is fixed for everyone').waitFor({ timeout: 8000 });
  await ctx.close();
});

await check('a pasted link skips the search', async () => {
  const { ctx, page, seen } = await open();
  await page.getByLabel(/search youtube/i).fill('https://youtu.be/pasted');
  await page.getByRole('button', { name: 'Use link' }).click();
  await page.getByRole('button', { name: 'Replace for everyone' }).click();
  await page.locator('.reroll-dialog').waitFor({ state: 'detached' });
  assert(seen.replaced.join() === 'https://youtu.be/pasted', seen.replaced.join());
  assert(seen.searches.length === 1, 'no second search');
  await ctx.close();
});

await check('Escape closes only the reroll dialog', async () => {
  const { ctx, page } = await open();
  await page.keyboard.press('Escape');
  await page.locator('.reroll-dialog').waitFor({ state: 'detached' });
  assert(await page.getByRole('button', { name: 'Close player', exact: true }).isVisible(), 'player still open');
  await ctx.close();
});

await check('no WCAG A/AA violations in the dialog', async () => {
  const { ctx, page } = await open();
  await page.addScriptTag({ content: AXE_SOURCE });
  const v = await page.evaluate(async () => (await window.axe.run('.reroll-dialog', {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  })).violations.map(x => `${x.id}: ${x.nodes.length}`));
  assert(!v.length, v.join('; '));
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
