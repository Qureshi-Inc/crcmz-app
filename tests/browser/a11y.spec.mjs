/**
 * Automated accessibility scan of every /app screen, plus the two overlays.
 *
 *   tests/browser/run.sh a11y.spec.mjs
 *
 * axe-core catches a real and useful subset: contrast, missing accessible names, broken
 * landmark and heading structure, form fields with no label, invalid ARIA. It does not
 * establish WCAG conformance — it cannot tell whether a label is *correct*, whether focus
 * order makes sense, or whether a live region says something useful. Those were checked
 * by hand and by the keyboard assertions in app.spec.mjs; see docs/ux/VALIDATION.md for
 * what is and is not covered.
 *
 * Runs at both a desktop and a phone viewport, because the mobile nav, the bottom sheet
 * and the header control only exist at one of them.
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

// Resolved from frontend/, where axe-core is installed — this file lives in tests/.
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const BASE = process.env.CRCMZ_BASE || 'http://127.0.0.1:3099';
const CHROME = process.env.CRCMZ_CHROME ||
  '/home/opti3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';

const now = Date.now();
const FIXTURES = {
  '/api/admin/check': { is_admin: true },
  '/api/squad': { squad: [
    { online_id: 'moiz', online: true, platform: 'PS5', game: 'Arc Raiders',
      trophy_level: 412, platinum: 31, gold: 240 },
    { online_id: 'shahraiz', online: false, last_seen: new Date(now - 36e5).toISOString(),
      trophy_level: 233, platinum: 12, gold: 98 },
  ] },
  '/api/hype': { count: 37, pct: 62, label: 'WARMING UP', level: 'warm' },
  '/api/soundboard': { buttons: [{ label: 'GET ON', msg: 'get on the game', custom: true }] },
  '/api/soundboard/personal': { buttons: [{ label: 'MINE', msg: 'my button', custom: true }] },
  '/api/pipeline-status': {
    services: { psn_messenger: { status: 'ok', version: '1', at: now / 1000 } },
    clips_this_month: 12, last_clip_at: (now - 72e5) / 1000, last_clip_sender: 'moiz',
    last_montage: { month: '2026-08', status: 'completed', duration: 214 },
    next_build_month: '2026-09', next_build_label: 'End of September',
  },
  '/clips': { count: 2, clips: [
    { message_uid: 'u1', sender_online_id: 'moiz', status: 'sent', duration_seconds: 24,
      width: 1920, height: 1080, file_size: 7_400_000, montage_eligible: 1,
      whatsapp_delivered_at: (now - 72e5) / 1000, psn_created_at: (now - 72e5) / 1000,
      body: 'insane 1v3 clutch' },
    { message_uid: 'u2', sender_online_id: 'shahraiz', status: 'failed', duration_seconds: 45,
      montage_eligible: 0, psn_created_at: (now - 9e7) / 1000, last_error: 'timed out' },
  ] },
  '/api/assistant/tools': { available: true, model: 'test-model', tools: ['a', 'b'] },
  '/api/assistant/history': { pending: false, messages: [
    { id: 1, role: 'user', content: 'who yaps most?', status: 'done', tools: [],
      created_at: new Date(now - 6e5).toISOString() },
    { id: 2, role: 'assistant', content: 'moiz, by a mile.', status: 'done',
      tools: ['whatsapp_stats'], elapsed_ms: 4200,
      created_at: new Date(now - 5e5).toISOString() },
  ] },
  '/api/assistant/facts': {
    suggestions: ['moiz', 'shahraiz'],
    facts: [{ id: '1', subject: 'moiz', text: 'never uses a mic', author: 'shahraiz',
      created_at: new Date(now - 864e5).toISOString(), mine: true }],
  },
  '/api/giveaway': {
    is_admin: true, user_eligible: true,
    giveaway: { id: 7, title: 'September giveaway', prize: 'A game', status: 'open',
      reveal_at: new Date(now + 864e5).toISOString(),
      entries: [{ member_id: 'm1', display: 'moiz' }] },
    rotation: { cycle: 2, total_members: 7, won_count: 3, eligible_count: 4,
      won_members: [{ member_id: 'm9', display: 'Noor' }],
      all_members: [{ member_id: 'm1', display: 'moiz' }, { member_id: 'm2', display: 'Moose' }] },
  },
  '/api/giveaway/history': { history: [
    { id: 1, title: 'August giveaway', prize: 'A game', winner_name: 'Noor', cycle: 1,
      closed_at: new Date(now - 2592e6).toISOString() },
  ] },
  '/api/whatsapp/can-import': { can_import: true },
  '/api/whatsapp/stats': { total_messages: 10432, total_members: 7, total_videos: 318,
    total_photos: 742, conversation_days: 396 },
  '/api/whatsapp/members': { members: [
    { name: 'moiz', messages: 3211, total_words: 18422, avg_words_per_msg: 5.7 },
    { name: 'Moose', messages: 2604, total_words: 15108, avg_words_per_msg: 5.8 },
  ] },
  '/api/whatsapp/awards': {
    certified_yapper: { name: 'moiz', count: 3211 },
    peak_hour: { hour: 22, count: 1441 },
    longest_streak_days: 96,
  },
  '/api/whatsapp/emojis': { top_emoji: [{ emoji: '\u{1F480}', count: 1902 }] },
  '/auth/settings/psn': { linked: true, online_id: 'moiz', admin: true },
  '/auth/settings/mattermost': { linked: true, username: 'moiz' },
  '/auth/settings/mcp': { active: true, last_used_at: (now - 36e5) / 1000 },
  '/auth/settings/passkeys': { passkeys: [{ id: 'pk1', name: 'iPhone' }] },
  '/api/admin/users': { users: [
    { id: 'u1', email: 'moiz@example.com', display_name: 'moiz', state: 'USER_STATE_ACTIVE' },
    { id: 'u2', email: 'noor@example.com', display_name: 'Noor', state: 'USER_STATE_INITIAL' },
  ] },
}

const SCREENS = [
  '/app',
  '/app/clips',
  '/app/music',
  '/app/community/whatsapp',
  '/app/community/giveaways',
  '/app/ai',
  '/app/settings',
  '/app/admin',
  '/app/watch',
  '/app/not-a-real-screen',
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

// WCAG 2.2 A + AA only. axe's "best-practice" rules are opinions, not the standard, and
// mixing them in makes a genuine AA failure hard to see.
const AXE_OPTIONS = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
};

let scanned = 0;
const violations = [];

const browser = await chromium.launch({ executablePath: CHROME });
console.log('\n== accessibility (axe-core, WCAG 2.x A/AA) ==');

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    reducedMotion: 'reduce',
  });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    const p = url.pathname;
    if (p === '/app' || p.startsWith('/app/') || p.endsWith('.png')) return route.continue();
    return route.fulfill({ json: FIXTURES[p] ?? {} });
  });
  const page = await ctx.newPage();

  for (const path of SCREENS) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
    await page.waitForSelector('h1', { timeout: 15_000 }).catch(() => {});
    // Let the data land — an empty skeleton is not what needs auditing.
    await page.waitForTimeout(1200);
    await scan(page, `${vp.name} ${path}`);

    // The overlays are only in the DOM while open, so axe cannot see them otherwise.
    if (path === '/app') {
      const board = page.getByRole('button', { name: /chat board/i }).first();
      if (await board.count()) {
        await board.click();
        await page.waitForSelector('[role="dialog"]', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(800);
        await scan(page, `${vp.name} ${path} + Chat Board drawer`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      if (vp.name === 'phone') {
        const more = page.getByRole('button', { name: /^more$/i }).first();
        if (await more.count()) {
          await more.click();
          await page.waitForSelector('[role="dialog"]', { timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(600);
          await scan(page, `${vp.name} ${path} + More sheet`);
          await page.keyboard.press('Escape');
        }
      }
    }
    if (path === '/app/community/giveaways' && vp.name === 'desktop') {
      const draw = page.getByRole('button', { name: /draw a winner/i }).first();
      if (await draw.count()) {
        await draw.click();
        await page.waitForSelector('[role="dialog"]', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(600);
        await scan(page, `${vp.name} ${path} + confirm dialog`);
        await page.keyboard.press('Escape');
      }
    }
  }
  await ctx.close();
}

async function scan(page, label) {
  await page.addScriptTag({ content: AXE_SOURCE });
  const result = await page.evaluate(
    async opts => await window.axe.run(document, opts),
    AXE_OPTIONS,
  );
  scanned++;
  if (result.violations.length === 0) {
    console.log(`  ✓ ${label}`);
    return;
  }
  console.log(`  ✗ ${label}`);
  for (const v of result.violations) {
    console.log(`      [${v.impact}] ${v.id}: ${v.help}`);
    for (const n of v.nodes.slice(0, 3)) {
      console.log(`           ${n.target.join(' ')}`);
      // axe's own numbers, not a guess at which element it meant.
      const why = (n.failureSummary || '').split('\n').map(x => x.trim()).filter(Boolean);
      for (const line of why.slice(1, 4)) console.log(`             ${line}`);
      if (n.html) console.log(`             html: ${n.html.slice(0, 160)}`);
    }
    violations.push(`${label} — ${v.id} (${v.impact}): ${v.help}`);
  }
}

await browser.close();
console.log(`\n${scanned} views scanned, ${violations.length} violation type(s)`);
for (const v of violations) console.log('  FAIL ' + v);
process.exit(violations.length ? 1 : 0);
