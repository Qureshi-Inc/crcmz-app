/**
 * Capture comparable screenshots of an instance.
 *
 *   CRCMZ_BASE=http://127.0.0.1:PORT CRCMZ_SHOT_DIR=docs/ux/screenshots/after \
 *     node tests/browser/shots.mjs
 *
 * Same viewports, same fixture data, same panels every time, so before/after pairs
 * differ only where the code differs. The fixtures are invented squad members — no
 * real private chat contents, PSN IDs or tokens end up in a committed image.
 */
import playwright from '../../frontend/node_modules/playwright/index.js';
const { chromium } = playwright;
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

const BASE = process.env.CRCMZ_BASE || 'http://127.0.0.1:3099';
const DIR = process.env.CRCMZ_SHOT_DIR || 'docs/ux/screenshots/tmp';
const CHROME = process.env.CRCMZ_CHROME ||
  '/home/opti3/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
// "legacy" drives ?p= tabs; "app" drives the React routes.
const MODE = process.env.CRCMZ_SHOT_MODE || 'legacy';

const now = new Date();
const iso = d => new Date(d).toISOString();

const FIXTURES = {
  // Real wrapper keys — /api/squad returns {squad:[...]}, not {members:[...]}.
  '/api/squad': { squad: [
    { online_id: 'moiz', online: true, platform: 'PS5', game: 'Arc Raiders',
      last_seen: iso(now), trophy_level: 412, platinum: 31, gold: 240 },
    { online_id: 'themoosecompany', online: true, platform: 'PS5', game: 'Call of Duty',
      last_seen: iso(now), trophy_level: 388, platinum: 22, gold: 191 },
    { online_id: 'shahraiz', online: false, last_seen: iso(now - 36e5),
      trophy_level: 233, platinum: 12, gold: 98 },
    { online_id: 'zubair221b', online: false, last_seen: iso(now - 9e6),
      trophy_level: 176, platinum: 7, gold: 64 },
  ] },
  '/api/hype': { count: 37, pct: 62, label: '🌡️ WARMING UP', level: 'warm' },
  '/api/pipeline-status': {
    services: {
      psn_messenger: { status: 'ok', version: 'demo', at: iso(now) },
      wa_bridge: { status: 'ok', at: iso(now) },
      psn_montage: { status: 'ok', at: iso(now) },
    },
    clips_this_month: 12, last_clip_at: iso(now - 72e5), last_clip_sender: 'moiz',
    last_montage: { month: '2026-08', status: 'completed', duration: 214 },
    next_build_month: '2026-09', next_build_label: 'End of September',
    next_build_ts: Math.floor((+now + 9e8) / 1000),
  },
  '/api/soundboard': { buttons: [
    { label: 'GET ON', msg: 'get on the game' },
    { label: 'ONE MORE', msg: 'one more round' },
    { label: 'AFK?', msg: 'you afk or what' },
    { label: 'CLIP IT', msg: 'clip that' },
  ] },
  '/api/soundboard/personal': { buttons: [] },
  '/api/assistant/tools': { available: true, model: 'demo-model', tools: ['a', 'b', 'c'] },
  '/api/assistant/history': { messages: [] },
  '/api/assistant/facts': { facts: [], can_edit: false },
  '/api/giveaway': { giveaway: null, rotation: null, is_admin: false, user_eligible: false },
  '/api/giveaway/history': { history: [] },
  '/api/whatsapp/can-import': { can_import: false },
  '/api/whatsapp/stats': { total_messages: 10432, total_members: 7, total_videos: 318,
    total_photos: 742, conversation_days: 396 },
  '/api/whatsapp/members': { members: [
    { name: 'moiz', messages: 3211, total_words: 18422, avg_words_per_msg: 5.7 },
    { name: 'Moose', messages: 2604, total_words: 15108, avg_words_per_msg: 5.8 },
    { name: 'Shahraiz', messages: 1877, total_words: 9930, avg_words_per_msg: 5.3 },
    { name: 'Zubair', messages: 1402, total_words: 6611, avg_words_per_msg: 4.7 },
    { name: 'Noor', messages: 811, total_words: 3902, avg_words_per_msg: 4.8 },
  ] },
  '/api/whatsapp/activity': { days: [] },
  '/api/whatsapp/heatmap': { cells: [], max_count: 1 },
  '/api/whatsapp/words': { members: [] },
  '/api/whatsapp/emojis': { top_emoji: [
    { emoji: '\u{1F480}', count: 1902 }, { emoji: '\u{1F602}', count: 1411 },
    { emoji: '\u{1F525}', count: 902 }, { emoji: '\u{1F44D}', count: 604 },
    { emoji: '\u2764\uFE0F', count: 388 }, { emoji: '\u{1F62D}', count: 291 },
  ] },
  '/api/whatsapp/response-times': { members: [] },
  '/api/whatsapp/awards': {
    certified_yapper: { name: 'moiz', count: 3211 },
    night_owl: { name: 'Zubair', count: 604 },
    early_bird: { name: 'Noor', count: 188 },
    video_king: { name: 'Moose', count: 141 },
    photo_king: { name: 'Shahraiz', count: 288 },
    most_used_emoji: { emoji: '\u{1F480}', count: 1902 },
    peak_hour: { hour: 22, count: 1441 },
    biggest_day: { date: '2026-04-18', count: 402 },
    longest_streak_days: 96,
    ghost_of_month: { name: 'Noor', count: 3 },
  },
  '/api/watch/config': { enabled: false },
  '/clips': { count: 3, clips: [
    { message_uid: 'demo-1', sender_online_id: 'moiz', month: '2026-09', status: 'sent',
      duration_seconds: 24, width: 1920, height: 1080, file_size: 7_400_000,
      montage_eligible: 1, whatsapp_delivered_at: (+now - 72e5) / 1000,
      psn_created_at: (+now - 72e5) / 1000, body: 'insane 1v3 clutch' },
    { message_uid: 'demo-2', sender_online_id: 'themoosecompany', month: '2026-09', status: 'sent',
      duration_seconds: 11, width: 1920, height: 1080, file_size: 3_100_000,
      montage_eligible: 1, montage_id: 'm-2026-09',
      psn_created_at: (+now - 2e7) / 1000 },
    { message_uid: 'demo-3', sender_online_id: 'shahraiz', month: '2026-09', status: 'pending',
      duration_seconds: 45, width: 1280, height: 720, file_size: 12_900_000,
      montage_eligible: 0, psn_created_at: (+now - 9e7) / 1000,
      last_error: 'normalisation timed out' },
  ] },
  '/api/video-jobs': { jobs: [] },
  '/api/admin/check': { is_admin: false },
};

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true,
    deviceScaleFactor: 2 },
];

// [file suffix, legacy ?p= value, /app path]
const SCREENS = [
  ['home', 'squad', '/app'],
  ['clips', 'pipeline', '/app/clips'],
  ['music', 'slap', '/app/music'],
  ['whatsapp', 'wa', '/app/community/whatsapp'],
  ['giveaways', 'giveaway', '/app/community/giveaways'],
  ['ai', 'ai', '/app/ai'],
];

await mkdir(DIR, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor || 1,
    isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch,
    // Pin these so text metrics and any date formatting are identical run to run.
    locale: 'en-GB', timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  await ctx.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.host !== new URL(BASE).host) return route.fulfill({ json: {} });
    const p = url.pathname;
    if (p === '/' || p === '/dashboard' || p.startsWith('/app') || p.endsWith('.png')
        || p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.svg')
        || p.endsWith('.woff2')) {
      return route.continue();
    }
    const key = [...Object.keys(FIXTURES)].find(k => p === k || p.startsWith(k + '/'));
    return route.fulfill({ json: key ? FIXTURES[key] : {} });
  });
  const page = await ctx.newPage();

  for (const [name, legacyP, appPath] of SCREENS) {
    const url = MODE === 'app' ? `${BASE}${appPath}` : `${BASE}/?p=${legacyP}`;
    await page.goto(url, { waitUntil: 'load' }).catch(() => {});
    // Give lazy panels time to paint, then freeze anything still animating.
    await page.waitForTimeout(1800);
    await page.addStyleTag({ content:
      '*,*::before,*::after{animation:none!important;transition:none!important;' +
      'caret-color:transparent!important}' }).catch(() => {});
    await page.waitForTimeout(150);
    const file = `${DIR}/${vp.name}-${name}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log('wrote ' + file);
  }
  await ctx.close();
}
await browser.close();
