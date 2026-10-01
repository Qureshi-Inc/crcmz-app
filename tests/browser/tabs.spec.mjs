/**
 * Phone tab bar: the user's three slots, the Ask AI orb and its flight.
 *
 *   tests/browser/run.sh tabs.spec.mjs
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;
import process from 'node:process';

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

const browser = await chromium.launch({ executablePath: CHROME });
console.log('\n== tab bar ==');

async function open(reducedMotion = 'reduce') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    const p = url.pathname;
    if (p === '/app' || p.startsWith('/app/') || p.endsWith('.png')) return route.continue();
    // The App tab's notifications card needs the category list the server always sends.
    if (p === '/api/push/config') return route.fulfill({ json: { enabled: false, categories: [] } });
    return route.fulfill({ json: {} });
  });
  return { ctx, page: await ctx.newPage() };
}
const labels = page => page.locator('.tabbar .tab-label').allTextContents();

await check('default bar: Squad, Slap, Ask AI, Watch, More', async () => {
  const { ctx, page } = await open();
  await page.goto(`${BASE}/app/settings/app`);
  await page.waitForSelector('.tabbar');
  const l = await labels(page);
  assert(l.join(',') === 'Squad,Slap,Ask AI,Watch,More', l.join(','));
  // The orb sits inside the bar, not sticking out of it.
  const [orb, bar] = await Promise.all([page.locator('.tabbar .tab-ask-orb').boundingBox(), page.locator('.tabbar').boundingBox()]);
  assert(orb.y >= bar.y && orb.y + orb.height <= bar.y + bar.height, `orb ${orb.y}+${orb.height} vs bar ${bar.y}+${bar.height}`);
  await ctx.close();
});

await check('settings: change a button, swap, persist, reset', async () => {
  const { ctx, page } = await open();
  await page.goto(`${BASE}/app/settings/app`);
  await page.getByRole('button', { name: /change the second button, now slap/i }).click();
  await page.locator('.tb-choices').getByRole('button', { name: /clips/i }).click();
  assert((await labels(page)).join(',') === 'Squad,Clips,Ask AI,Watch,More', 'clips in slot 2');
  // Watch is already in the bar: picking it swaps.
  await page.locator('.tb-choices').getByRole('button', { name: /watch/i }).click();
  assert((await labels(page)).join(',') === 'Squad,Watch,Ask AI,Clips,More', (await labels(page)).join(','));
  await page.reload();
  await page.waitForSelector('.tabbar');
  assert((await labels(page)).join(',') === 'Squad,Watch,Ask AI,Clips,More', 'kept after reload');
  // More lists what isn't in the bar.
  await page.getByRole('button', { name: /^more/i }).click();
  const more = await page.locator('[role="dialog"] .more-row').allTextContents();
  assert(more.includes('Slap') && !more.includes('Watch') && !more.includes('Ask AI'), more.join(','));
  await page.getByRole('link', { name: 'Change the tab bar' }).click();
  await page.waitForURL('**/app/settings/app#tabbar');
  await page.getByRole('button', { name: 'Reset' }).click();
  assert((await labels(page)).join(',') === 'Squad,Slap,Ask AI,Watch,More', 'reset');
  await ctx.close();
});

await check('Ask AI flies, then opens the chat', async () => {
  const { ctx, page } = await open('no-preference');
  await page.goto(`${BASE}/app/settings`);
  await page.waitForSelector('.tab-ask');
  await page.locator('.tab-ask').click();
  await page.waitForSelector('.ask-fly', { timeout: 1000 });
  await page.waitForURL('**/app/ask', { timeout: 3000 });
  await page.waitForTimeout(600);
  assert(await page.locator('.ask-fly').count() === 0, 'flight cleaned up');
  assert(await page.locator('.tab-ask[aria-current="page"]').count() === 1, 'Ask AI active');
  await ctx.close();
});

await check('reduced motion: Ask AI is a plain link', async () => {
  const { ctx, page } = await open('reduce');
  await page.goto(`${BASE}/app/settings`);
  await page.locator('.tab-ask').click();
  await page.waitForURL('**/app/ask', { timeout: 1500 });
  assert(await page.locator('.ask-fly').count() === 0, 'no flight');
  await ctx.close();
});

await check('Squad: the music mini-player sits under the Chat Board handle', async () => {
  const { ctx, page } = await open();
  await ctx.addInitScript(() => localStorage.setItem('slap.player.v1', JSON.stringify({
    queue: [{ id: 't1', title: 'Test song', artist: 'Someone', album: 'A', album_id: 'a', duration: 200, art: null, qid: 'q1' }],
    index: 0, shuffle: false, repeat: 'off', position: 0, order: null,
  })));
  const box = async (sel) => page.locator(sel).first().boundingBox();
  await page.goto(`${BASE}/app`);
  await page.locator('.miniplayer-bar').waitFor();
  await page.locator('.handle-row').waitFor();
  const [mini, handle, bar] = [await box('.miniplayer-bar'), await box('.handle-row'), await box('.tabbar')];
  assert(Math.abs(mini.y + mini.height - bar.y) <= 1, `mini bottom ${mini.y + mini.height} vs tab bar ${bar.y}`);
  assert(Math.abs(handle.y + handle.height - mini.y) <= 1, `handle bottom ${handle.y + handle.height} vs mini ${mini.y}`);
  // Elsewhere it still sits right on the tab bar.
  await page.locator('.tabbar .tab', { hasText: 'Watch' }).click();
  await page.waitForURL(/\/app\/watch/);
  const [m2, b2] = [await box('.miniplayer-bar'), await box('.tabbar')];
  assert(Math.abs(m2.y + m2.height - b2.y) <= 1, `watch: mini bottom ${m2.y + m2.height} vs tab bar ${b2.y}`);
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
