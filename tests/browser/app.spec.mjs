/**
 * Browser checks for the React interface at /app.
 *
 *   tests/browser/run.sh app.spec.mjs
 *
 * These cover the gates the execution plan sets for phases 2 and 3: direct entry,
 * refresh, Back/Forward, filters in the URL, the legacy ?p= and #hash links, the
 * loading/error/empty/stale contract, keyboard operation of the drawer, and that a
 * pending write cannot be submitted twice.
 *
 * Every API call is intercepted. Nothing here touches PSN, WhatsApp or a giveaway.
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;
import process from 'node:process';

const BASE = process.env.CRCMZ_BASE || 'http://127.0.0.1:3099';
const CHROME = process.env.CRCMZ_CHROME ||
  '/home/opti3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

let passed = 0;
const failed = [];
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

const now = Date.now();
const FIXTURES = {
  '/api/admin/check': { is_admin: false },
  '/api/squad': { squad: [
    { online_id: 'moiz', online: true, platform: 'PS5', game: 'Arc Raiders',
      trophy_level: 412, platinum: 31, gold: 240 },
    { online_id: 'shahraiz', online: false, last_seen: new Date(now - 36e5).toISOString(),
      trophy_level: 233, platinum: 12, gold: 98 },
  ] },
  '/api/hype': { count: 37, pct: 62, label: 'WARMING UP', level: 'warm' },
  '/api/soundboard': { buttons: [
    { label: 'GET ON', msg: 'get on the game', custom: true },
    { label: 'ONE MORE', msg: 'one more round', custom: false },
  ] },
  '/api/soundboard/personal': { buttons: [] },
  '/api/pipeline-status': { services: {}, clips_this_month: 12 },
  '/clips': { count: 1, clips: [
    { message_uid: 'u1', sender_online_id: 'moiz', status: 'sent',
      duration_seconds: 24, montage_eligible: 1, psn_created_at: (now - 72e5) / 1000 },
  ] },
  '/api/assistant/tools': { available: true, model: 'test-model', tools: ['a'] },
  '/api/assistant/history': { messages: [], pending: false },
  '/api/assistant/facts': { facts: [], suggestions: [] },
  '/api/giveaway': { giveaway: null, rotation: null, is_admin: false },
  '/api/giveaway/history': { history: [] },
  '/api/whatsapp/can-import': { can_import: false },
  '/api/whatsapp/stats': { total_messages: 10432, total_members: 7, conversation_days: 396 },
  '/api/whatsapp/members': { members: [] },
  '/api/whatsapp/awards': {},
  '/api/whatsapp/emojis': { top_emoji: [] },
};

function fixtureFor(path) {
  const key = Object.keys(FIXTURES).find(k => path === k);
  return key ? FIXTURES[key] : {};
}

/**
 * `overrides` maps a path to either a JSON body, the string 'fail' (abort the
 * transport), or a {status, json} pair. Anything else comes from FIXTURES.
 */
async function newPage(browser, { overrides = {}, signedOut = false, viewport } = {}) {
  const ctx = await browser.newContext({
    viewport: viewport ?? { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  open.add(ctx);
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));

  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    // Let the document, the built bundle and the images come from the real server.
    if (path === '/app' || path.startsWith('/app/') || path.endsWith('.png')) {
      return route.continue();
    }
    requests.push({ method: route.request().method(), path, search: url.search });

    if (signedOut && path === '/api/admin/check') {
      return route.fulfill({ status: 401, json: { detail: 'authentication required' } });
    }
    const o = overrides[path];
    if (o === 'fail') return route.abort('failed');
    if (o && typeof o === 'object' && 'status' in o) {
      return route.fulfill({ status: o.status, json: o.json ?? {}, headers: o.headers ?? {} });
    }
    if (o && typeof o === 'object' && 'delayMs' in o) {
      await new Promise(r => setTimeout(r, o.delayMs));
      return route.fulfill({ json: o.json ?? fixtureFor(path) });
    }
    if (o !== undefined) return route.fulfill({ json: o });
    return route.fulfill({ json: fixtureFor(path) });
  });
  return { page, errors, requests };
}

const browser = await chromium.launch({ executablePath: CHROME });

console.log('\n== /app (browser) ==');

/* ── Direct entry and refresh ───────────────────────────────────────────────── */
console.log('routing');

const SCREENS = [
  ['/app', 'Squad'],
  ['/app/clips', 'Clips'],
  ['/app/music', 'Music'],
  ['/app/community/whatsapp', 'WhatsApp'],
  ['/app/community/giveaways', 'Giveaways'],
  ['/app/ai', 'Ask AI'],
  ['/app/settings', 'Settings'],
  ['/app/watch', 'Watch Party'],
  ['/app/huddle', 'Huddle'],
];

for (const [path, heading] of SCREENS) {
  await check(`${path} renders on direct entry`, async () => {
    const { page, errors } = await newPage(browser);
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    // The h1 is the proof the route resolved rather than falling through to not-found.
    await page.waitForSelector('h1', { timeout: 10_000 });
    assert((await page.locator('h1').first().innerText()).trim() === heading,
      `expected the h1 to be "${heading}", got "${(await page.locator('h1').first().innerText()).trim()}"`);
    assert(errors.length === 0, `page threw: ${errors.join(' | ')}`);
  });
}

await check('a refresh lands on the same screen', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app/community/whatsapp`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('h1');
  assert((await page.locator('h1').first().innerText()).trim() === 'WhatsApp',
    'refresh did not come back to WhatsApp');
});

await check('an unknown /app path shows a useful not-found, not a blank screen', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app/not-a-real-screen`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  assert((await page.locator('h1').first().innerText()).trim() === 'Not found', 'no not-found view');
  // And it offers somewhere to go, rather than being a dead end.
  assert(await page.locator('a[href="/app/clips"]').count() > 0, 'no suggested destinations');
});

await check('the document title follows the route', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title.startsWith('Squad'), null, { timeout: 5_000 });
  await page.click('a[href="/app/clips"]');
  await page.waitForFunction(() => document.title.startsWith('Clips'), null, { timeout: 5_000 });
});

/* ── Back / Forward ─────────────────────────────────────────────────────────── */
await check('Back and Forward move between screens', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.click('a[href="/app/clips"]');
  await page.waitForFunction(() => location.pathname === '/app/clips');
  await page.click('a[href="/app/music"]');
  await page.waitForFunction(() => location.pathname === '/app/music');

  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/app/clips', null, { timeout: 5_000 });
  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/app', null, { timeout: 5_000 });
  await page.goForward();
  await page.waitForFunction(() => location.pathname === '/app/clips', null, { timeout: 5_000 });
});

/* ── Legacy links ───────────────────────────────────────────────────────────── */
await check('an old ?p= link resolves to the new path', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app?p=slap`, { waitUntil: 'load' });
  await page.waitForFunction(() => location.pathname === '/app/music', null, { timeout: 5_000 });
  assert((await page.locator('h1').first().innerText()).trim() === 'Music', 'did not land on Music');
});

await check('an old #hash link resolves to the new path', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app#giveaway`, { waitUntil: 'load' });
  await page.waitForFunction(() => location.pathname === '/app/community/giveaways', null, { timeout: 5_000 });
});

await check('an unknown ?p= is ignored rather than guessed', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app?p=../../evil`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  assert(new URL(page.url()).pathname === '/app',
    `a crafted ?p= steered navigation: ${page.url()}`);
  assert((await page.locator('h1').first().innerText()).trim() === 'Squad', 'left Home');
});

await check('the legacy redirect does not trap Back', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.goto(`${BASE}/app?p=slap`, { waitUntil: 'load' });
  await page.waitForFunction(() => location.pathname === '/app/music', null, { timeout: 5_000 });
  await page.goBack();
  await page.waitForTimeout(600);
  // It replaced rather than pushed, so one Back leaves Music instead of bouncing
  // straight back to it.
  assert(new URL(page.url()).pathname !== '/app/music',
    'Back returned to the redirect target — the compat redirect pushed a history entry');
});

/* ── Filters in the URL ─────────────────────────────────────────────────────── */
console.log('state ownership');

await check('a clip filter is in the URL and survives a refresh', async () => {
  const { page, requests } = await newPage(browser);
  await page.goto(`${BASE}/app/clips`, { waitUntil: 'load' });
  await page.waitForSelector('#filter-status');
  await page.selectOption('#filter-status', 'sent');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('status') === 'sent',
    null, { timeout: 5_000 });
  await page.waitForTimeout(400);
  assert(requests.some(r => r.path === '/clips' && r.search.includes('status=sent')),
    `the filter was not sent to the server: ${JSON.stringify(requests.filter(r => r.path === '/clips').map(r => r.search))}`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#filter-status');
  assert(await page.locator('#filter-status').inputValue() === 'sent',
    'the filter did not survive a refresh');
});

await check('a WhatsApp range is in the URL and is sent to every endpoint', async () => {
  const { page, requests } = await newPage(browser);
  await page.goto(`${BASE}/app/community/whatsapp`, { waitUntil: 'load' });
  await page.waitForSelector('button[aria-pressed]');
  await page.click('text=This month');
  await page.waitForFunction(() => new URL(location.href).searchParams.get('range') === 'this_month',
    null, { timeout: 5_000 });
  await page.waitForTimeout(600);
  const waReqs = requests.filter(r => r.path.startsWith('/api/whatsapp/') && !r.path.endsWith('can-import'));
  const forMonth = waReqs.filter(r => r.search.includes('range=this_month'));
  assert(forMonth.length >= 3,
    `expected the new range on several endpoints, saw ${JSON.stringify(waReqs.map(r => r.path + r.search))}`);
});

await check('a custom range is not requested until both dates are valid', async () => {
  const { page, requests } = await newPage(browser);
  await page.goto(`${BASE}/app/community/whatsapp`, { waitUntil: 'load' });
  await page.waitForSelector('button[aria-pressed]');
  const before = requests.filter(r => r.search.includes('range=custom')).length;
  await page.click('text=Custom…');
  await page.waitForSelector('#wa-start');
  await page.fill('#wa-start', '2026-03-01');
  await page.waitForTimeout(500);
  assert(requests.filter(r => r.search.includes('range=custom')).length === before,
    'a half-filled custom range was sent to the server');
  // A backwards range must not be sent either.
  await page.fill('#wa-end', '2026-01-01');
  await page.waitForTimeout(500);
  assert(requests.filter(r => r.search.includes('range=custom')).length === before,
    'a backwards custom range was sent to the server');
  assert((await page.locator('#wa-end-error').innerText()).includes('after'),
    'no error explained why nothing loaded');
  // Correct it and it goes.
  await page.fill('#wa-end', '2026-05-01');
  await page.waitForTimeout(700);
  assert(requests.filter(r => r.search.includes('range=custom')).length > before,
    'a valid custom range was never requested');
});

/* ── Loading, empty, error, stale ───────────────────────────────────────────── */
console.log('loading and recovery');

await check('a slow read shows a placeholder, not a bare spinner', async () => {
  const { page } = await newPage(browser, { overrides: { '/api/squad': { delayMs: 1500 } } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  assert(await page.locator('.skeleton').count() > 0, 'no skeleton placeholder while loading');
  await page.waitForSelector('text=moiz', { timeout: 10_000 });
  assert(await page.locator('.skeleton').count() === 0, 'the skeleton outlived the data');
});

await check('a failed read offers a Retry that actually retries', async () => {
  const { page, requests } = await newPage(browser, { overrides: { '/api/squad': 'fail' } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('[role="alert"]', { timeout: 10_000 });
  const before = requests.filter(r => r.path === '/api/squad').length;
  await page.click('button:has-text("Retry")');
  await page.waitForTimeout(900);
  assert(requests.filter(r => r.path === '/api/squad').length > before,
    'Retry did not issue another request');
});

await check('a 403 explains itself and offers no Retry', async () => {
  const { page } = await newPage(browser, {
    overrides: { '/api/squad': { status: 403, json: { detail: 'not for this account' } } },
  });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('[role="alert"]', { timeout: 10_000 });
  const alert = await page.locator('[role="alert"]').first().innerText();
  assert(/cannot do that|Not available/i.test(alert), `unhelpful 403 copy: ${alert}`);
  assert(await page.locator('[role="alert"] button:has-text("Retry")').count() === 0,
    'offered Retry for a 403, which will always fail');
});

await check('a 429 says when another attempt is allowed', async () => {
  const { page } = await newPage(browser, {
    overrides: {
      '/api/squad': { status: 429, json: { detail: 'slow down' }, headers: { 'Retry-After': '42' } },
    },
  });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('[role="alert"]', { timeout: 15_000 });
  const alert = await page.locator('[role="alert"]').first().innerText();
  assert(alert.includes('42'), `Retry-After was not surfaced: ${alert}`);
});

await check('a malformed response does not crash the screen', async () => {
  const { page, errors } = await newPage(browser, { overrides: { '/api/squad': { squad: 'not-a-list' } } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.waitForTimeout(800);
  assert(errors.length === 0, `page threw on a bad shape: ${errors.join(' | ')}`);
  // It degrades to the empty state rather than rendering half a list.
  assert((await page.locator('#app-main').innerText()).includes('linked'),
    'no empty state for an unusable response');
});

await check('an empty result explains itself and suggests what to do', async () => {
  const { page } = await newPage(browser, { overrides: { '/api/squad': { squad: [] } } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('text=Nobody has linked an account yet', { timeout: 10_000 });
  assert(await page.locator('a[href="/portal"]').count() > 0, 'no next action offered');
});

await check('a secondary section failing leaves the rest of the screen usable', async () => {
  const { page } = await newPage(browser, { overrides: { '/api/hype': 'fail' } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('text=moiz', { timeout: 10_000 });
  await page.waitForSelector('[role="alert"]', { timeout: 10_000 });
  // Presence is still there even though the hype widget died.
  assert(await page.locator('text=Arc Raiders').count() > 0,
    'a failing secondary widget took the primary content with it');
});

/* ── Session ────────────────────────────────────────────────────────────────── */
console.log('session');

await check('a signed-out visitor is asked to sign in, not shown an error', async () => {
  const { page } = await newPage(browser, { signedOut: true });
  await page.goto(`${BASE}/app/ai`, { waitUntil: 'load' });
  await page.waitForSelector('text=Sign in to ask', { timeout: 10_000 });
  // And the banner that claims the session *expired* must not appear on a first visit.
  assert(!(await page.locator('#app-main').innerText()).includes('session expired'),
    'told a first-time visitor their session expired');
});

await check('the sign-in link returns to where the user was', async () => {
  const { page } = await newPage(browser, { signedOut: true });
  await page.goto(`${BASE}/app/ai`, { waitUntil: 'load' });
  await page.waitForSelector('button:has-text("Sign in")', { timeout: 10_000 });
  // Intercept the navigation rather than following it into Zitadel.
  let target = '';
  await page.route('**/auth/login*', r => { target = r.request().url(); return r.abort(); });
  await page.click('button:has-text("Sign in")');
  await page.waitForTimeout(700);
  const next = new URL(target || 'http://x/').searchParams.get('next');
  assert(next === '/app/ai', `next was "${next}", so login would not return here`);
});

/* ── Writes ─────────────────────────────────────────────────────────────────── */
console.log('writes');

await check('the Chat Board opens from the keyboard and traps focus', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.locator('button:has-text("Chat Board")').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
  // Focus has to be inside the dialog, or a keyboard user is stranded behind it.
  assert(await page.evaluate(() =>
    document.activeElement?.closest('[role="dialog"]') !== null),
    'focus stayed outside the drawer');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5_000 });
  // And it comes back to the trigger.
  assert(await page.evaluate(() =>
    (document.activeElement?.textContent || '').includes('Chat Board')),
    'focus was not restored to the launcher');
});

await check('both boards are reachable without a swipe', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.locator('button:has-text("Chat Board")').first().click();
  await page.waitForSelector('[role="dialog"]');
  assert(await page.locator('[role="tab"]').count() === 2,
    'the personal board is not a real tab — the legacy UI hid it behind a swipe');
  await page.click('[role="tab"]:has-text("My board")');
  await page.waitForTimeout(400);
  assert((await page.locator('[role="dialog"]').innerText()).length > 0);
});

await check('hammering a board button sends exactly one message', async () => {
  const sends = [];
  const { page } = await newPage(browser, {});
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  // Intercept the send with a delay long enough to click into.
  await page.route('**/v2/squad', async r => {
    sends.push(1);
    await new Promise(x => setTimeout(x, 600));
    return r.fulfill({ json: { status: 'sent' } });
  });
  await page.locator('button:has-text("Chat Board")').first().click();
  await page.waitForSelector('[role="dialog"]');
  const btn = page.locator('[role="dialog"] button:has-text("GET ON")');
  await btn.waitFor();
  await Promise.all([0, 1, 2, 3].map(() =>
    btn.click({ force: true, noWaitAfter: true }).catch(() => {})));
  await page.waitForTimeout(1200);
  assert(sends.length === 1, `expected 1 send, got ${sends.length}`);
});

await check('a failed quick send keeps the draft and does not claim success', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.route('**/v2/send', r => r.abort('failed'));
  await page.locator('button:has-text("Chat Board")').first().click();
  await page.waitForSelector('#board-composer');
  await page.fill('#board-composer', 'do not lose me');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  assert(await page.locator('#board-composer').inputValue() === 'do not lose me',
    'the draft was cleared even though the send failed');
  const text = await page.locator('[role="dialog"]').innerText();
  assert(/Might have sent|check the group/i.test(text),
    `a write that may have landed was reported as a plain failure: ${text.slice(0, 160)}`);
});

await check('hammering Enter in the composer sends exactly one message', async () => {
  const sends = [];
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.route('**/v2/send', async r => {
    sends.push(1);
    await new Promise(x => setTimeout(x, 600));
    return r.fulfill({ json: { status: 'sent' } });
  });
  await page.locator('button:has-text("Chat Board")').first().click();
  await page.waitForSelector('#board-composer');
  await page.fill('#board-composer', 'only once');
  await page.focus('#board-composer');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  assert(sends.length === 1, `expected 1 send, got ${sends.length}`);
});

/* ── Giveaway safety ───────────────────────────────────────────────────────── */
await check('opening Giveaways never draws or reveals', async () => {
  const mutations = [];
  const { page } = await newPage(browser, {
    overrides: {
      '/api/giveaway': {
        is_admin: true,
        user_eligible: true,
        giveaway: {
          id: 7, title: 'Test giveaway', prize: 'A prize', status: 'open',
          // Deliberately in the past: this is the exact condition under which the legacy
          // loader POSTed draw-and-reveal from inside its own data fetch.
          reveal_at: new Date(now - 864e5).toISOString(),
          draw_at: new Date(now - 864e5).toISOString(),
          entries: [{ member_id: 'm1', display: 'moiz' }],
        },
        rotation: { cycle: 1, total_members: 7, won_count: 0, eligible_count: 7,
          won_members: [], all_members: [{ member_id: 'm1', display: 'moiz' }] },
      },
    },
  });
  await page.route('**/api/giveaway/*/**', r => {
    mutations.push(r.request().method() + ' ' + new URL(r.request().url()).pathname);
    return r.fulfill({ json: {} });
  });
  await page.goto(`${BASE}/app/community/giveaways`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  await page.waitForTimeout(1500);
  // Remount by navigating away and back — a refetch must not trigger it either.
  await page.click('a[href="/app"]').catch(() => {});
  await page.waitForTimeout(400);
  await page.goto(`${BASE}/app/community/giveaways`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const writes = mutations.filter(m => m.startsWith('POST') || m.startsWith('PUT'));
  assert(writes.length === 0,
    `rendering the giveaway screen mutated it: ${JSON.stringify(writes)}`);
});

await check('a destructive giveaway action needs a named confirmation', async () => {
  const posts = [];
  const { page } = await newPage(browser, {
    overrides: {
      '/api/giveaway': {
        is_admin: true,
        giveaway: { id: 7, title: 'T', prize: 'P', status: 'open', entries: [{ member_id: 'm1', display: 'moiz' }] },
        rotation: { cycle: 1, total_members: 7, won_count: 0, eligible_count: 7, won_members: [], all_members: [] },
      },
    },
  });
  await page.route('**/api/giveaway/7/draw', r => {
    posts.push(1);
    return r.fulfill({ json: { status: 'drawn' } });
  });
  await page.goto(`${BASE}/app/community/giveaways`, { waitUntil: 'load' });
  await page.waitForSelector('button:has-text("Draw a winner")', { timeout: 10_000 });
  await page.click('button:has-text("Draw a winner")');
  await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
  assert(posts.length === 0, 'the draw fired before the confirmation was answered');
  const dialog = await page.locator('[role="dialog"]').innerText();
  assert(dialog.includes('Draw the winner'),
    `the confirm button does not say what it does: ${dialog.slice(0, 200)}`);
  // Cancelling must not draw.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  assert(posts.length === 0, 'cancelling the dialog still drew a winner');
});

/* ── Responsive ─────────────────────────────────────────────────────────────── */
console.log('responsive');

for (const width of [360, 390, 768, 1024, 1440]) {
  await check(`no horizontal overflow at ${width}px`, async () => {
    const { page } = await newPage(browser, { viewport: { width, height: 800 } });
    await page.goto(`${BASE}/app/community/whatsapp`, { waitUntil: 'load' });
    await page.waitForSelector('h1');
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // A deliberately scrollable table must not make the whole page scroll sideways.
    assert(overflow <= 1, `the page scrolls sideways by ${overflow}px`);
  });
}

await check('the mobile nav is present and the desktop sidebar is not, at 390px', async () => {
  const { page } = await newPage(browser, { viewport: { width: 390, height: 844 } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  const navs = page.locator('nav[aria-label="Main"]');
  assert(await navs.count() === 2, 'expected both nav elements in the DOM');
  // Exactly one is actually visible at this width.
  const visible = await navs.evaluateAll(els =>
    els.filter(e => e.getBoundingClientRect().height > 0).length);
  assert(visible === 1, `${visible} main navs are visible at 390px`);
  // And every primary destination is a labelled control, not a gesture.
  for (const label of ['Home', 'Watch', 'Clips', 'More']) {
    assert((await page.locator(`text=${label}`).count()) > 0, `${label} is not reachable`);
  }
});

await check('essential controls stay reachable at 200% zoom', async () => {
  // 720x800 at deviceScaleFactor 1 approximates a 1440px window at 200%.
  const { page } = await newPage(browser, { viewport: { width: 720, height: 800 } });
  await page.goto(`${BASE}/app`, { waitUntil: 'load' });
  await page.waitForSelector('h1');
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `reflow at 200% scrolls sideways by ${overflow}px`);
  // By accessible name, not by visible text: below the md breakpoint the affordance is
  // the header control, which is labelled rather than spelled out in full.
  const board = page.getByRole('button', { name: /chat board/i }).first()
  assert(await board.isVisible(), 'the Chat Board control is unreachable at 200%')
  // And it has to be big enough to hit.
  const box = await board.boundingBox()
  assert(box && box.height >= 40, `the control is only ${box?.height}px tall`);
});

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
for (const f of failed) console.log('  FAIL ' + f);
process.exit(failed.length ? 1 : 0);
