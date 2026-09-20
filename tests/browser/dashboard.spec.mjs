/**
 * Browser checks for the legacy dashboard, run against a real instance.
 *
 *   tests/browser/run.sh
 *
 * These exist because the Phase 1 defects were all things a static read of the
 * source cannot settle: whether a `let` guard is in its temporal dead zone when the
 * boot path runs, which element `querySelector('.qsend')` actually matches in the
 * assembled document, and whether Back returns to the previous tab. So: load the
 * page a browser would load, drive it, and look.
 *
 * Every API call is intercepted. Nothing here touches PSN, WhatsApp or a giveaway.
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;   // playwright is CJS; no named ESM exports
import process from 'node:process';

const BASE = process.env.CRCMZ_BASE || 'http://127.0.0.1:3099';
const CHROME = process.env.CRCMZ_CHROME ||
  '/home/opti3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

let passed = 0;
const failed = [];
// Contexts opened by the test currently running. A test that throws mid-way never
// reaches its own close(), and a leaked context keeps polling the route handlers —
// which shifted the timing of later tests enough to make a real failure look like a
// pass. So cleanup belongs here, not at the end of each test body.
const open = new Set();
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed.push(`${name}: ${e.message}`); console.log(`  ✗ ${name}\n      ${e.message}`); }
  finally {
    for (const ctx of open) await ctx.close().catch(() => {});
    open.clear();
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// The nav items live inside a dropdown that has to be opened first, exactly as a
// user would. Clicking them while it is closed hits whatever is painted on top.
async function navigate(page, p) {
  await page.click('#navTrigger');
  await page.click(`.nav-item[data-p="${p}"]`);
  await page.waitForTimeout(250);
}

// Canned responses, so a run is deterministic and offline. Anything not listed is
// fulfilled with an empty object rather than left hanging.
const FIXTURES = {
  '/api/squad': { members: [
    { online_id: 'moiz', online: true, platform: 'PS5', game: 'Arc Raiders',
      last_seen: new Date().toISOString(), trophy_level: 412, platinum: 31, gold: 240 },
    { online_id: 'shahraiz', online: false, last_seen: new Date(Date.now() - 36e5).toISOString(),
      trophy_level: 233, platinum: 12, gold: 98 },
  ] },
  '/api/hype': { score: 62, label: 'warming up', online: 1, messages_today: 37 },
  '/api/pipeline-status': { psn: { ok: true }, whatsapp: { ok: true }, jobs: { pending: 0 } },
  '/api/soundboard': { buttons: [{ label: 'GET ON', msg: 'get on the game' }] },
  '/api/soundboard/personal': { buttons: [] },
  '/api/assistant/tools': { available: true, model: 'test-model', tools: ['a', 'b'] },
  '/api/assistant/history': { messages: [] },
  '/api/assistant/facts': { facts: [], can_edit: false },
  '/api/giveaway': { giveaway: null, rotation: null, is_admin: false, user_eligible: false },
  '/api/giveaway/history': { history: [] },
  '/api/whatsapp/can-import': { can_import: false },
  '/api/watch/config': { enabled: false },
  '/clips': { clips: [] },
  '/api/video-jobs': { jobs: [] },
};

async function newPage(browser, { failSlap = false, failWa = false, slowRange = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  open.add(ctx);
  const page = await ctx.newPage();
  const sent = [];
  // Set once the deliberately-slow response has actually been handed to the page,
  // so a test can wait for the race to have happened rather than guess a duration.
  const slow = { delivered: false };
  page.on('pageerror', e => sent.push({ pageerror: e.message }));

  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    // slap.qureshi.io is a third-party service the Music tab reads directly.
    if (url.host !== new URL(BASE).host) {
      if (failSlap) return route.abort('failed');
      return route.fulfill({ json: {} });
    }
    if (path === '/' || path === '/dashboard' || path.endsWith('.png')) return route.continue();

    if (path.startsWith('/api/whatsapp/')) {
      if (failWa) return route.abort('failed');
      const range = url.searchParams.get('range') || 'all_time';
      // Make "all_time" the slow one, so a later, faster range can overtake it.
      // Only /stats is held: playwright can serialise route handlers, and delaying
      // all nine WhatsApp calls pushed the slow response so far out that the test
      // finished before it ever landed — which made it pass against the unfixed
      // code for the wrong reason.
      if (slowRange && range === slowRange && path.endsWith('/stats')) {
        await new Promise(r => setTimeout(r, 1200));
        slow.delivered = true;
      }
      if (path.endsWith('/stats')) {
        return route.fulfill({ json: {
          total_messages: range === 'all_time' ? 99999 : 111,
          total_members: 7, total_videos: 1, total_photos: 2, conversation_days: 9 } });
      }
      return route.fulfill({ json: FIXTURES[path] || {} });
    }
    if (path === '/v2/send' || path === '/v2/squad') {
      sent.push({ path, body: route.request().postDataJSON() });
      await new Promise(r => setTimeout(r, 300));   // long enough to double-click into
      return route.fulfill({ json: { status: 'sent' } });
    }
    return route.fulfill({ json: FIXTURES[path] ?? {} });
  });
  return { page, sent, slow };
}

const browser = await chromium.launch({ executablePath: CHROME });

console.log('\n== legacy dashboard (browser) ==');
console.log('deep links');

// ── Startup ordering ────────────────────────────────────────────────────────────
// The boot path called loadSlap/loadWa/loadGiveaway while their `let` guards were
// still in the temporal dead zone, so every direct visit to those tabs threw a
// ReferenceError and left the panel on "Loading…" forever.
for (const [p, panel, marker] of [
  ['slap', 'p-slap', '#slap-inner'],
  ['wa', 'p-wa', '#wa-inner'],
  ['giveaway', 'p-giveaway', '#giveaway-inner'],
  ['ai', 'p-ai', null],
  ['huddle', 'p-huddle', null],
  ['pipeline', 'p-pipeline', null],
  ['squad', 'p-squad', null],
]) {
  await check(`?p=${p} opens that panel with no page error`, async () => {
    const { page } = await newPage(browser);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/?p=${p}`, { waitUntil: 'load' });
    await page.waitForTimeout(700);
    assert(errors.length === 0, `page threw: ${errors.join(' | ')}`);
    assert(await page.locator(`#${panel}`).evaluate(el => el.classList.contains('on')),
      `#${panel} is not the visible panel`);
    if (marker) {
      const txt = (await page.locator(marker).innerText().catch(() => '')).trim();
      assert(!/^Loading/i.test(txt), `${marker} is still showing "${txt.slice(0, 40)}"`);
    }
    });
}

await check('an unknown ?p= falls back to Squad and normalises the URL', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/?p=not-a-real-tab`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  assert(await page.locator('#p-squad').evaluate(el => el.classList.contains('on')),
    'did not fall back to Squad');
  assert(new URL(page.url()).searchParams.get('p') === 'squad',
    `URL was not normalised: ${page.url()}`);
});

await check('a legacy #hash link still resolves', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/#giveaway`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  assert(await page.locator('#p-giveaway').evaluate(el => el.classList.contains('on')),
    '#giveaway did not open the giveaway panel');
  assert(new URL(page.url()).searchParams.get('p') === 'giveaway',
    `hash was not translated into ?p=: ${page.url()}`);
});

// ── Back / Forward ──────────────────────────────────────────────────────────────
console.log('history');

await check('Back and Forward move between tabs instead of leaving the site', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/?p=squad`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await navigate(page, 'pipeline');
  await navigate(page, 'giveaway');
  assert(new URL(page.url()).searchParams.get('p') === 'giveaway', 'URL did not follow the click');

  await page.goBack();
  await page.waitForTimeout(300);
  assert(await page.locator('#p-pipeline').evaluate(el => el.classList.contains('on')),
    'Back did not return to Clips');
  await page.goBack();
  await page.waitForTimeout(300);
  assert(await page.locator('#p-squad').evaluate(el => el.classList.contains('on')),
    'Back did not return to Squad');
  await page.goForward();
  await page.waitForTimeout(300);
  assert(await page.locator('#p-pipeline').evaluate(el => el.classList.contains('on')),
    'Forward did not go back to Clips');
});

await check('clicking the same tab twice does not stack history entries', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/?p=squad`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await navigate(page, 'pipeline');
  await navigate(page, 'pipeline');
  await navigate(page, 'pipeline');
  await page.goBack();
  await page.waitForTimeout(300);
  assert(await page.locator('#p-squad').evaluate(el => el.classList.contains('on')),
    'one Back should have returned to Squad, so repeat clicks pushed extra entries');
});

// ── Quick send ──────────────────────────────────────────────────────────────────
console.log('quick message composer');

await check('the composer disables its own button, not Ask AI\'s', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/?p=squad`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.fill('#quick', 'hello squad');
  await page.click('#quickSend');
  await page.waitForTimeout(80);
  assert(await page.locator('#quickSend').isDisabled(), 'the composer button stayed enabled');
  assert(!(await page.locator('#aiSend').isDisabled()),
    'Ask AI\'s send button was disabled by the message composer');
  await page.waitForTimeout(500);
  assert(!(await page.locator('#quickSend').isDisabled()), 'the button never came back');
});

await check('hammering the button while pending sends exactly one message', async () => {
  const { page, sent } = await newPage(browser);
  await page.goto(`${BASE}/?p=squad`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.fill('#quick', 'only once please');
  // force:true so the click lands even once the button is disabled — a user's
  // second tap is dispatched by the OS, it does not consult our CSS.
  await Promise.all([0, 1, 2, 3].map(() =>
    page.click('#quickSend', { force: true, noWaitAfter: true }).catch(() => {})));
  await page.waitForTimeout(700);
  const sends = sent.filter(s => s.path === '/v2/send');
  assert(sends.length === 1, `expected 1 request, got ${sends.length}`);
});

await check('hammering Enter while pending sends exactly one message', async () => {
  const { page, sent } = await newPage(browser);
  await page.goto(`${BASE}/?p=squad`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.fill('#quick', 'enter only once');
  await page.focus('#quick');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const sends = sent.filter(s => s.path === '/v2/send');
  assert(sends.length === 1, `expected 1 request, got ${sends.length}`);
});

await check('a failed send keeps the draft text', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/?p=squad`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.route('**/v2/send', r => r.abort('failed'));
  await page.fill('#quick', 'do not lose me');
  await page.click('#quickSend');
  await page.waitForTimeout(500);
  assert(await page.locator('#quick').inputValue() === 'do not lose me',
    'the draft was cleared even though the send failed');
});

// ── Loader recovery ─────────────────────────────────────────────────────────────
console.log('failure recovery');

await check('a failed Music load offers a Retry that actually retries', async () => {
  const { page } = await newPage(browser, { failSlap: true });
  await page.goto(`${BASE}/?p=slap`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const retry = page.locator('#slap-inner .retry-btn');
  assert(await retry.count() === 1, 'no Retry button in the failed Music panel');
  // Let the next attempt succeed, and confirm the guard was cleared — before the
  // fix the "already loaded" flag stayed true and Retry was a no-op.
  await page.unroute('**/*');
  let retried = false;
  await page.route('**/*', async r => {
    const u = new URL(r.request().url());
    if (u.host !== new URL(BASE).host) { retried = true; return r.fulfill({ json: {} }); }
    return r.fulfill({ json: {} });
  });
  await retry.click();
  await page.waitForTimeout(700);
  assert(retried, 'Retry did not issue a new request — the load guard was never cleared');
});

await check('a failed WhatsApp load offers a Retry', async () => {
  const { page } = await newPage(browser, { failWa: true });
  await page.goto(`${BASE}/?p=wa`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  assert(await page.locator('#wa-inner .retry-btn').count() === 1,
    'no Retry button in the failed WhatsApp panel');
});

// ── Stale range responses ───────────────────────────────────────────────────────
await check('a slow older range cannot overwrite a newer selection', async () => {
  // all_time's /stats is held for 1200ms and answers 99999 messages; every other
  // range answers 111 immediately. Pick all_time, immediately pick another range,
  // and the stale 99999 must never reach the panel.
  const { page, slow } = await newPage(browser, { slowRange: 'all_time' });
  await page.goto(`${BASE}/?p=wa`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const ranges = await page.locator('.wa-rb').evaluateAll(
    els => els.map(e => e.dataset.r));
  const other = ranges.find(r => r && r !== 'all_time' && r !== 'custom');
  assert(other, `no second range button to switch to (saw ${JSON.stringify(ranges)})`);
  slow.delivered = false;
  await page.click('.wa-rb[data-r="all_time"]');
  await page.waitForTimeout(50);
  await page.click(`.wa-rb[data-r="${other}"]`);

  // Poll for the stale value instead of sampling once after a guessed delay. How
  // long the superseded generation takes to finish depends on all nine of its
  // requests, and a single well-timed sample landed in the gap before it wrote —
  // which made this pass against the unfixed code.
  let shown = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    shown = await page.locator('#wa-stats').innerText();
    assert(!shown.includes('100.0k') && !shown.includes('99999'),
      `the superseded all_time response overwrote the current range: ${shown.replace(/\n/g, ' ').slice(0, 120)}`);
    if (slow.delivered && Date.now() > deadline - 4000) break;
    await page.waitForTimeout(100);
  }
  // Guard against a vacuous pass: if the slow response never arrived, this test
  // asserted nothing.
  assert(slow.delivered, 'the superseded all_time response was never delivered — nothing was raced');
  assert(shown.includes('111'), `expected the newer range's count, saw: ${shown.replace(/\n/g, ' ').slice(0, 120)}`);
});

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log('  FAIL ' + f);
process.exit(failed.length ? 1 : 0);
