/**
 * Compare the legacy dashboard and /app under identical conditions.
 *
 *   CRCMZ_BASE=http://127.0.0.1:PORT node tests/browser/perf.mjs
 *   CRCMZ_BASE=... CRCMZ_PERF_MODE=legacy node tests/browser/perf.mjs
 *
 * What this is: a lab measurement on one machine, over loopback, with every API response
 * canned. It is useful for exactly two questions — how many bytes and requests does the
 * first load cost, and does the layout jump — because those are properties of the build,
 * not of the network.
 *
 * What it is not: field data. LCP here is loopback LCP and INP is unmeasurable without a
 * real person interacting, so neither number says anything about the 75th percentile of
 * actual use. VALIDATION.md records that limitation rather than quoting these as Core Web
 * Vitals.
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;
import process from 'node:process';

const BASE = process.env.CRCMZ_BASE || 'http://127.0.0.1:3099';
const MODE = process.env.CRCMZ_PERF_MODE || 'app';
const RUNS = Number.parseInt(process.env.CRCMZ_PERF_RUNS || '5', 10);
const CHROME = process.env.CRCMZ_CHROME ||
  '/home/opti3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

const now = Date.now();
const FIXTURES = {
  '/api/admin/check': { is_admin: false },
  '/api/squad': { squad: Array.from({ length: 7 }, (_, i) => ({
    online_id: `member${i}`, online: i < 2, platform: 'PS5',
    game: i < 2 ? 'Arc Raiders' : null,
    last_seen: new Date(now - i * 36e5).toISOString(),
    trophy_level: 400 - i * 30, platinum: 30 - i, gold: 240 - i * 20,
  })) },
  '/api/hype': { count: 37, pct: 62, label: 'WARMING UP', level: 'warm' },
  '/api/soundboard': { buttons: Array.from({ length: 8 }, (_, i) => ({
    label: `BUTTON ${i}`, msg: `message ${i}`, custom: i > 3 })) },
  '/api/soundboard/personal': { buttons: [] },
  '/api/pipeline-status': { services: {}, clips_this_month: 12 },
  '/clips': { count: 0, clips: [] },
  '/api/assistant/tools': { available: true, model: 'm', tools: [] },
  '/api/assistant/history': { messages: [], pending: false },
  '/api/assistant/facts': { facts: [], suggestions: [] },
  '/api/giveaway': { giveaway: null, rotation: null, is_admin: false },
  '/api/giveaway/history': { history: [] },
  '/api/whatsapp/can-import': { can_import: false },
  '/api/watch/config': { enabled: false },
  '/api/video-jobs': { jobs: [] },
};

const url = MODE === 'app' ? `${BASE}/app` : `${BASE}/?p=squad`;
const browser = await chromium.launch({ executablePath: CHROME });
const samples = [];

for (let run = 0; run < RUNS; run++) {
  // A fresh context every run, so nothing is served from a warm HTTP cache — this is the
  // first-visit cost.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const transferred = { documents: 0, scripts: 0, styles: 0, images: 0, api: 0, other: 0 };
  let requests = 0;

  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    const p = u.pathname;
    if (p === '/' || p === '/dashboard' || p === '/app' || p.startsWith('/app/') ||
        p.endsWith('.png')) {
      return route.continue();
    }
    return route.fulfill({ json: FIXTURES[p] ?? {} });
  });

  page.on('response', async res => {
    requests++;
    const p = new URL(res.url()).pathname;
    const len = Number.parseInt(res.headers()['content-length'] || '0', 10) ||
      await res.body().then(b => b.length).catch(() => 0);
    // Source maps are a development artefact and no browser fetches them unless devtools
    // is open, so they do not belong in a page-weight number.
    if (p.endsWith('.map')) return;
    if (p.endsWith('.js')) transferred.scripts += len;
    else if (p.endsWith('.css')) transferred.styles += len;
    else if (/\.(png|jpe?g|svg|webp|ico)$/.test(p)) transferred.images += len;
    else if (p.startsWith('/api') || p === '/clips') transferred.api += len;
    else if (p === '/' || p === '/dashboard' || p === '/app') transferred.documents += len;
    else transferred.other += len;
  });

  await page.goto(url, { waitUntil: 'load' });
  // Let the deferred work and the first data settle; both interfaces fetch after paint.
  await page.waitForTimeout(3000);

  const vitals = await page.evaluate(() => new Promise(resolve => {
    const out = { lcp: 0, cls: 0, longTasks: 0, longTaskMs: 0 };
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) out.lcp = Math.max(out.lcp, e.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) out.cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) { out.longTasks++; out.longTaskMs += e.duration; }
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* an unsupported entry type should not fail the measurement */ }
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    setTimeout(() => resolve({
      ...out,
      fcp: paint ? paint.startTime : 0,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : 0,
      load: nav ? nav.loadEventEnd : 0,
      // How much script the main thread actually had to compile and run.
      scriptDuration: performance.getEntriesByType('resource')
        .filter(r => r.name.endsWith('.js')).length,
    }), 400);
  }));

  samples.push({ ...vitals, requests, transferred });
  await ctx.close();
}

await browser.close();

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const kb = n => `${(n / 1024).toFixed(1)} KB`;
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

console.log(`\n== ${MODE} · ${url} · median of ${RUNS} cold loads ==\n`);
console.log(`  FCP                 ${median(samples.map(s => s.fcp)).toFixed(0)} ms`);
console.log(`  LCP (loopback)      ${median(samples.map(s => s.lcp)).toFixed(0)} ms`);
console.log(`  DOMContentLoaded    ${median(samples.map(s => s.domContentLoaded)).toFixed(0)} ms`);
console.log(`  load                ${median(samples.map(s => s.load)).toFixed(0)} ms`);
console.log(`  CLS                 ${median(samples.map(s => s.cls)).toFixed(4)}`);
console.log(`  long tasks          ${median(samples.map(s => s.longTasks))} (${median(samples.map(s => s.longTaskMs)).toFixed(0)} ms total)`);
console.log(`  requests            ${median(samples.map(s => s.requests))}`);
const t = samples[0].transferred;
console.log(`\n  document            ${kb(median(samples.map(s => s.transferred.documents)))}`);
console.log(`  scripts             ${kb(median(samples.map(s => s.transferred.scripts)))}`);
console.log(`  styles              ${kb(median(samples.map(s => s.transferred.styles)))}`);
console.log(`  images              ${kb(median(samples.map(s => s.transferred.images)))}`);
console.log(`  API responses        ${kb(median(samples.map(s => s.transferred.api)))}`);
console.log(`  ─────────────────────────────`);
console.log(`  total (uncompressed) ${kb(median(samples.map(s => sum(s.transferred))))}`);
void t;
