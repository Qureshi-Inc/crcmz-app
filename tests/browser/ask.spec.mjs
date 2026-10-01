/**
 * Browser checks for Ask AI (/app/ask): the assistant-ui thread, the live stream,
 * the polling fallback, Stop, the draft and the error paths.
 *
 *   tests/browser/run.sh ask.spec.mjs
 *
 * Every API call is intercepted, the stream included. No model is asked anything.
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

const t0 = Date.now() / 1000;
const Q = { id: 1, role: 'user', content: 'who yaps the most?', status: 'done', tools: [], elapsed_ms: null, created_at: t0 };
const PENDING = { id: 2, role: 'assistant', content: '', status: 'pending', tools: [], elapsed_ms: null, created_at: t0 };
const ANSWER = '**moiz**, by a mile.\n\n| who | msgs |\n|---|---|\n| moiz | 4,210 |';
const DONE = { ...PENDING, content: ANSWER, status: 'done', tools: ['whatsapp_top_senders'], elapsed_ms: 2400 };
const sse = (events) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
const STREAM = sse([
  { type: 'tool', name: 'whatsapp_top_senders' },
  { type: 'tool_done', name: 'whatsapp_top_senders', ok: true },
  ...ANSWER.match(/.{1,8}/gs).map(delta => ({ type: 'text', delta })),
  { type: 'done', status: 'done', content: ANSWER, tools: ['whatsapp_top_senders'], elapsed_ms: 2400 },
]);

/**
 * `state.history` is what /api/assistant/history answers now; the handlers move it
 * on the way the server would. `hooks` overrides any path with a function.
 */
async function newPage(browser, { history = [], hooks = {} } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  open.add(ctx);
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  const state = { history };
  page.on('pageerror', e => errors.push(e.message));
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    if (path === '/app' || path.startsWith('/app/') || path.endsWith('.png')) return route.continue();
    requests.push({ method: route.request().method(), path, body: route.request().postData() });
    if (hooks[path]) return hooks[path](route, state);
    if (path === '/api/assistant/tools') return route.fulfill({ json: { available: true, model: 'test-model', tools: [{ name: 'a', description: '' }] } });
    if (path === '/api/assistant/history') {
      const pending = state.history.some(m => m.status === 'pending');
      return route.fulfill({ json: { messages: state.history, pending, count: state.history.length } });
    }
    if (path === '/api/assistant/facts') return route.fulfill({ json: { facts: [], total: 0, mine: 0, max_per_user: 20, max_chars: 280, subjects: [] } });
    if (path === '/api/assistant/ask') {
      state.history = [Q, PENDING];
      return route.fulfill({ json: { status: 'queued', reply_id: 2 } });
    }
    if (path === '/api/assistant/stream') {
      state.history = [Q, DONE];
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: STREAM });
    }
    if (path === '/api/assistant/stop') return route.fulfill({ json: { status: 'stopping' } });
    return route.fulfill({ json: {} });
  });
  return { page, errors, requests, state };
}

async function askIt(page, text = 'who yaps the most?') {
  await page.goto(`${BASE}/app/ask`, { waitUntil: 'load' });
  await page.waitForSelector('#ask-q:not([disabled])', { timeout: 10_000 });
  await page.fill('#ask-q', text);
  await page.keyboard.press('Enter');
}

const browser = await chromium.launch({ executablePath: CHROME });
console.log('\n== /app/ask (browser) ==');

await check('a question streams into a rendered markdown answer', async () => {
  const { page, errors, requests } = await newPage(browser);
  await askIt(page);
  await page.waitForSelector('.ask-md strong:has-text("moiz")', { timeout: 10_000 });
  await page.waitForSelector('.ask-md table td:has-text("4,210")', { timeout: 5_000 });
  await page.waitForSelector('text=Looked up whatsapp top senders', { timeout: 5_000 });
  const ask = requests.find(r => r.path === '/api/assistant/ask');
  assert(ask && JSON.parse(ask.body).question === 'who yaps the most?', 'the question was not sent');
  assert(requests.some(r => r.path === '/api/assistant/stream'), 'never opened the stream');
  await page.waitForSelector('button[aria-label="Copy answer"]', { timeout: 5_000 });
  assert(await page.locator('#ask-q').inputValue() === '', 'the composer kept the sent question');
  assert(!errors.length, `page errors: ${errors.join('; ')}`);
});

await check('the question shows at once, before the server has answered', async () => {
  const { page } = await newPage(browser, { hooks: {
    '/api/assistant/ask': async (route, state) => {
      await new Promise(r => setTimeout(r, 1500));
      state.history = [Q, PENDING];
      return route.fulfill({ json: { status: 'queued', reply_id: 2 } });
    },
  } });
  await askIt(page);
  await page.waitForSelector('.ask-msg[data-role="user"]:has-text("who yaps the most?")', { timeout: 700 });
  await page.waitForSelector('.ask-thinking', { timeout: 700 });
});

await check('with no stream to follow, history polling still brings the answer', async () => {
  let polls = 0;
  const { page } = await newPage(browser, { hooks: {
    '/api/assistant/stream': route => route.fulfill({ status: 404, json: { detail: 'no live answer' } }),
    '/api/assistant/history': (route, state) => {
      if (state.history.length && ++polls >= 2) state.history = [Q, DONE];
      const pending = state.history.some(m => m.status === 'pending');
      return route.fulfill({ json: { messages: state.history, pending, count: state.history.length } });
    },
  } });
  await askIt(page);
  await page.waitForSelector('.ask-md strong:has-text("moiz")', { timeout: 12_000 });
});

await check('Stop is offered while it writes, keeps the text, and asks the server to stop', async () => {
  const { page, requests } = await newPage(browser, { history: [Q, PENDING], hooks: {
    // Half an answer, then the connection drops: EventSource reconnects and replays.
    '/api/assistant/stream': route => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' },
      body: sse([{ type: 'text', delta: 'moiz is ' }, { type: 'text', delta: 'clearly' }]) }),
  } });
  await page.goto(`${BASE}/app/ask`, { waitUntil: 'load' });
  await page.waitForSelector('.ask-md:has-text("moiz is clearly")', { timeout: 10_000 });
  await page.click('button[aria-label="Stop the answer"]');
  await page.waitForTimeout(400);
  assert(requests.some(r => r.path === '/api/assistant/stop' && r.method === 'POST'), 'Stop did not reach the server');
});

await check('a half-typed question survives a reload', async () => {
  const { page } = await newPage(browser);
  await page.goto(`${BASE}/app/ask`, { waitUntil: 'load' });
  await page.waitForSelector('#ask-q:not([disabled])', { timeout: 10_000 });
  await page.fill('#ask-q', 'who carried last night');
  await page.waitForTimeout(150);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#ask-q:not([disabled])', { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#ask-q')?.value === 'who carried last night', null, { timeout: 3_000 });
});

await check('a rate limit counts down and gives the question back', async () => {
  const { page } = await newPage(browser, { hooks: {
    '/api/assistant/ask': route => route.fulfill({ status: 429, headers: { 'retry-after': '9' }, json: { detail: 'slow down' } }),
  } });
  await askIt(page, 'one more?');
  await page.waitForSelector('text=/Try again in \\d+s/', { timeout: 5_000 });
  assert(await page.locator('#ask-q').inputValue() === 'one more?', 'the question was lost');
  assert(await page.locator('.ask-msg[data-role="user"]').count() === 0, 'a question that never sent stayed in the thread');
});

await check('a failed answer offers to ask again', async () => {
  const failedRow = { ...PENDING, status: 'error', content: 'The model timed out.' };
  const { page } = await newPage(browser, { history: [Q, failedRow] });
  await page.goto(`${BASE}/app/ask`, { waitUntil: 'load' });
  await page.waitForSelector('text=Couldn\'t get an answer', { timeout: 10_000 });
  await page.click('button:has-text("Ask again")');
  assert(await page.locator('#ask-q').inputValue() === 'who yaps the most?', 'Ask again did not refill the question');
});

await check('suggestions send straight away on an empty thread', async () => {
  const { page, requests } = await newPage(browser);
  await page.goto(`${BASE}/app/ask`, { waitUntil: 'load' });
  await page.waitForSelector('#ask-q:not([disabled])', { timeout: 10_000 });
  await page.click('.ask-chips button:has-text("Who yaps the most?")');
  await page.waitForSelector('.ask-md strong:has-text("moiz")', { timeout: 10_000 });
  const ask = requests.find(r => r.path === '/api/assistant/ask');
  assert(ask && JSON.parse(ask.body).question === 'who sends the most messages?', 'the chip sent the wrong prompt');
});

await browser.close();
console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) { for (const f of failed) console.log(`  FAIL ${f}`); process.exit(1); }
