/**
 * Help: every menu row's ⓘ lands on its own section of /app/help.
 *
 *   tests/browser/run.sh help.spec.mjs
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
console.log('\n== help ==');

async function open(vp, admin) {
  const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    const p = url.pathname;
    if (p === '/app' || p.startsWith('/app/') || p.endsWith('.png')) return route.continue();
    if (p === '/api/admin/check') return route.fulfill({ json: { admin } });
    return route.fulfill({ json: {} });
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

// The section's heading is at the top of the viewport (under the mobile top bar).
async function landed(page, id) {
  await page.waitForURL(`**/app/help#${id}`);
  await page.waitForTimeout(400);
  const { top, atEnd } = await page.locator(`#help-${id}`).evaluate(el => ({
    top: el.getBoundingClientRect().top,
    atEnd: Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight,
  }));
  // A section near the end can only scroll as far as the page goes.
  assert(top >= 0 && (top < 200 || atEnd), `#help-${id} top is ${top}`);
}

await check('desktop: sidebar ⓘ opens that section', async () => {
  const { ctx, page } = await open({ width: 1440, height: 900 }, false);
  await page.goto(`${BASE}/app/settings`);
  await page.getByRole('link', { name: 'How to use Mattermost' }).count().then(n => assert(n === 0, 'no Mattermost row'));
  await page.getByRole('link', { name: 'How to use Slap' }).click();
  await landed(page, 'slap');
  assert(await page.getByText('https://jelly.qureshi.io').count() > 0, 'Jellyfin URL shown');
  await page.getByRole('link', { name: 'How to use Settings' }).click();
  await landed(page, 'settings');
  await ctx.close();
});

await check('phone: More sheet ⓘ closes the sheet and opens that section', async () => {
  const { ctx, page } = await open({ width: 390, height: 844 }, false);
  await page.goto(`${BASE}/app/settings`);
  await page.getByRole('button', { name: /^more/i }).click();
  await page.getByRole('link', { name: 'How to use Huddle' }).click();
  await landed(page, 'huddle');
  assert(await page.locator('[role="dialog"]').count() === 0, 'sheet closed');
  await ctx.close();
});

await check('admin section only for admins', async () => {
  for (const admin of [false, true]) {
    const { ctx, page } = await open({ width: 1440, height: 900 }, admin);
    await page.goto(`${BASE}/app/help`);
    await page.waitForSelector('#help-clips');
    await page.waitForTimeout(600);
    const n = await page.locator('#help-admin').count();
    assert(n === (admin ? 1 : 0), `admin=${admin}: ${n} admin sections`);
    await ctx.close();
  }
});

await check('jump chips scroll within the page', async () => {
  const { ctx, page } = await open({ width: 1440, height: 900 }, false);
  await page.goto(`${BASE}/app/help`);
  await page.locator('.help-jump').getByRole('link', { name: 'Mattermost' }).click();
  await landed(page, 'mattermost');
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
