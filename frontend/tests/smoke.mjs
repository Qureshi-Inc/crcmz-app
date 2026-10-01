// Smoke test for the /app slice-1 frontend.
//
//   CRCMZ_BACKEND=http://127.0.0.1:3021 npx vite --port 5199   # dev server + proxy
//   node tests/smoke.mjs [--base http://127.0.0.1:5199] [--shots ../docs/app/slice-1]
//
// Reads (/api/squad, /api/hype, /api/soundboard, ...) go to the real backend through the
// dev proxy. EVERY non-GET request is intercepted: sends are answered by mocks, and any
// write that is not mocked is aborted and fails the run. Nothing here can post to the
// PSN group.
//
// Env: PLAYWRIGHT_CORE (module dir), CHROME (executable). Defaults match the owner's box.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []))
const BASE = (args.base || 'http://127.0.0.1:5199').replace(/\/$/, '')
const SHOTS = args.shots ? resolve(process.cwd(), args.shots) : null
const require = createRequire(process.env.PLAYWRIGHT_CORE || '/home/opti3/gstack/node_modules/')
const { chromium } = require('playwright-core')
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`
const AXE = readFileSync(resolve(here, '../node_modules/axe-core/axe.min.js'), 'utf8')

if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })

/**
 * A page where every write is mocked. `mocks` maps "METHOD path" → handler(route).
 * Unmocked writes are aborted and recorded as violations.
 */
async function newPage({ width, height, mocks = {}, match = null, reducedMotion = 'no-preference' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion, hasTouch: width < 1024 })
  const page = await ctx.newPage()
  page.violations = []
  page.writes = []
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const key = `${req.method()} ${url.pathname}`
    const h = mocks[key] || match?.(key, url)
    if (h) { page.writes.push(key); return h(route) }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') {
      page.violations.push(key)
      return route.abort()
    }
    if (mocks[`GET ${url.pathname}`]) return mocks[`GET ${url.pathname}`](route)
    return route.continue()
  })
  page.on('pageerror', (e) => page.violations.push(`pageerror: ${e.message}`))
  return { ctx, page }
}

const json = (status, body, headers = {}) => (route) =>
  route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
const delayed = (ms, fn) => async (route) => { await new Promise((r) => setTimeout(r, ms)); return fn(route) }
const classicStub = (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>classic stub</h1>' })

// ── Clips fixtures (PS-2). Clip reads are session-gated, so they are fixtures too. ──
const NOW = Math.floor(Date.now() / 1000)
const REELS = Array.from({ length: 15 }, (_, i) => ({
  clip_id: `r${i}`, sender: i % 2 ? 'Goopy' : 'Bizzle', game: 'Rocket League', duration: 20 + i,
  when: new Date((NOW - i * 7200) * 1000).toISOString().slice(0, 19).replace('T', ' '),
  message: i === 0 ? 'what a save 🔥' : '', analysis_window: [4, 8],
  pipeline: { state: ['posted', 'daily_eligible', 'fail', 'not_eligible', 'vetoed'][i % 5], reactions: 1, gate: 2, detail: 'too short' },
  has_analysis: true, has_render: i % 3 === 0, override: null, vetoed: i % 5 === 4,
}))
const CLIP_ROWS = Array.from({ length: 50 }, (_, i) => ({
  message_uid: `m${i}`, sender_online_id: i % 2 ? 'Goopy' : 'Bizzle', psn_created_at: NOW - i * 3600,
  status: ['delivered', 'archived', 'discovered', 'failed'][i % 4], archive_status: i === 1 ? 'purged' : 'archived',
  duration_seconds: 30, width: 1920, height: 1080, file_size: 12_000_000, whatsapp_delivered_at: i % 4 === 0 ? NOW - i * 3600 : null,
  montage_eligible: 1, game_name: 'Rocket League', body: '', last_error: null,
}))
const UPLOAD_LIMITS = { max_bytes: 25_000_000, max_seconds: 600, min_seconds: 3, max_caption: 300, formats: ['mp4', 'mov'] }
const MB = 1024 * 1024
const CLIP_READS = {
  'GET /api/pipeline-status': json(200, {
    clips_this_month: 142, last_clip_at: NOW - 600, last_clip_sender: 'Goopy', next_build_ts: NOW + 3 * 86400 + 4 * 3600,
    next_build_label: 'Oct 1, 2026 · 6 AM PT', next_build_month: '2026-09',
    last_montage: { version: 8, year: 2026, month: 8, clips: 19, duration: 834.3, sent: false },
    clips: [{ uid: 'm0', sender: 'Goopy', duration: 31, at: NOW - 600, included: true, reason: null },
      { uid: 'm1', sender: 'Bizzle', duration: 4, at: NOW - 900, included: false, reason: 'too short' }],
  }),
  'GET /api/reels': json(200, { me: { psn_id: 'Goopy', display_name: 'Goopy', admin: true }, scope: 'mine', clips: REELS, source: 'reel-review', roster: null, needs_psn_link: false }),
  'GET /api/video-uploads/mine': json(200, { psn_id: 'Goopy', uploads: [{ video_post_id: 'v1', status: 'posted', caption: 'Montage cut', filename: 'a.mp4', uploaded_at: NOW - 86400, posted_at: NOW - 80000, skip_reason: null, duration_seconds: 42, platforms: { youtube: { url: 'https://example.com/v' } } }], can_upload: true, open_session: null, limits: UPLOAD_LIMITS }),
  'GET /clips': json(200, { clips: CLIP_ROWS, count: 50 }),
  'GET /clips/m0': json(200, CLIP_ROWS[0]),
  'GET /clips/m1': json(200, CLIP_ROWS[1]),
  'GET /clips/m2': json(200, CLIP_ROWS[2]),
  'GET /api/clips/media': delayed(20_000, (r) => r.fulfill({ status: 404, body: '' })),
  // Held open so the player stays mounted while the test looks at it.
  'GET /api/reels/clips/r0/source': delayed(20_000, (r) => r.fulfill({ status: 404, body: '' })),
}

// Studio fixtures: a small VP9 test pattern (sized to 1920×1080 by the page) and a frame.
const STUDIO_VIDEO = readFileSync(resolve(here, 'fixtures/studio-source.webm'))
const STUDIO_FRAME = readFileSync(resolve(here, 'fixtures/studio-frame.jpg'))
/** Serve a buffer with Range support, so the video element can seek. */
const serveRange = (buf, type) => (route) => {
  const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '')
  if (!m) return route.fulfill({ status: 200, contentType: type, headers: { 'accept-ranges': 'bytes' }, body: buf })
  const a = Number(m[1]); const b = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1
  return route.fulfill({ status: 206, contentType: type, body: buf.subarray(a, b + 1),
    headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${buf.length}` } })
}

// ── Slap fixtures (PS-3). Every /api/slap route is mocked, reads and writes. ──
const SLAP_TRACKS = Array.from({ length: 30 }, (_, i) => ({
  id: `t${i}`, title: `Track ${i}`, artist: ['Drake', 'SZA', 'Kendrick Lamar'][i % 3], album: `Album ${i % 5}`, album_id: `al${i % 5}`,
  album_artist: ['Drake', 'SZA', 'Kendrick Lamar'][i % 3], genres: ['Hip-Hop'], year: 2020 + (i % 5), duration: 180 + i,
  added: new Date((NOW - i * 86400) * 1000).toISOString(), art: i % 4 ? `al${i % 5}` : null, fav: i === 2, plays: 30 - i,
}))
const SLAP_LIB = { tracks: SLAP_TRACKS, playlists: [{ id: 'p1', name: 'Gym', count: 3, art: 'al1', editable: true }, { id: 'p2', name: 'Chill', count: 2, art: null, editable: false }] }
const qi = (t, i, by) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, album_id: t.album_id, duration: t.duration, art: t.art, qid: `q${i}`, added_by: by })
const SLAP_ROOM = {
  queue: [qi(SLAP_TRACKS[3], 0, 'zubair'), qi(SLAP_TRACKS[4], 1, 'noor')], index: 0, playing: false, position: 12, at: NOW, version: 4,
  by: 'zubair', last: 'zubair added Track 4', members: [{ name: 'zubair', since: NOW - 300 }, { name: 'noor', since: NOW - 60 }],
}
const SLAP_BASE = {
  'GET /api/admin/check': json(200, { admin: false }),
  'GET /api/slap/me': json(200, { name: 'Moiz', jellyfin_user: 'moiz', slap_user: 'moiz', created: false, admin: false }),
  'GET /api/slap/library': json(200, SLAP_LIB),
  'GET /api/slap/playlists/p1': json(200, { id: 'p1', name: 'Gym', editable: true, items: [{ entry: 'e1', id: 't1' }, { entry: 'e2', id: 't5' }, { entry: 'e3', id: 't9' }] }),
  'GET /api/slap/together': json(200, SLAP_ROOM),
}
const slapMatch = (extra = {}) => (key) => {
  if (extra[key]) return extra[key]
  if (key.startsWith('GET /api/slap/art/')) return (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: STUDIO_FRAME })
  if (key.startsWith('GET /api/slap/stream/')) return serveRange(STUDIO_VIDEO, 'video/webm')
  if (key.startsWith('GET /api/slap/social/')) return socialFixture(key.slice('GET /api/slap/social/'.length))
  return null
}
const WHO = [{ username: 'moiz', color: '#ff3df0' }, { username: 'zubair221b', color: '#22e6ff' }, { username: 'nooramin40', color: '#ffd24a' }]
const SONG = (i) => ({ title: `Song ${i}`, artist: ['Drake', 'SZA'][i % 2], username: WHO[i % 3].username, color: WHO[i % 3].color, created_at: new Date((NOW - i * 3600) * 1000).toISOString(), source_platform: 'spotify', track_id: `t${i}` })
function socialFixture(path) {
  const S = {
    'dashboard/stats': { total_songs: 1234, total_contributors: 6, this_week_additions: 18, top_artist: 'Drake', total_artists: 410, most_active_day: 'Friday', peak_hour: 22, longest_streak_user: 'moiz', longest_streak_days: 12 },
    'dashboard/hot': { tracks: [SONG(1), SONG(2)], period_hours: 24 },
    'dashboard/listening': { enabled: true, top_tracks: [{ ...SONG(3), plays: 9 }], total_scrobbles: 253, period_days: 30 },
    'dashboard/leaderboard': { entries: WHO.map((w, i) => ({ rank: i + 1, username: w.username, song_count: 300 - i * 50, color: w.color, latest_addition: null })) },
    'dashboard/streaks': { entries: WHO.map((w, i) => ({ ...w, current_streak: 5 - i, longest_streak: 12 - i, is_active: i === 0 })) },
    'dashboard/hipster': { entries: WHO.map((w, i) => ({ ...w, unique_artists: 100 - i * 10, hipster_score: 80 - i * 5 })) },
    'dashboard/personalities': { cards: WHO.map((w) => ({ ...w, personality: 'The Curator', description: 'Always first to the new drop', dominant_platform: 'spotify', song_count: 120 })) },
    'dashboard/hall-of-fame': { entries: [{ title: 'Most slapped', description: 'Played by everyone', value: 'Song 1', emoji: '🏆' }] },
    'dashboard/achievements': [{ id: 'a1', name: 'First slap', emoji: '🎉', description: 'Share your first song', unlocked: true, unlocked_by: ['moiz'] }, { id: 'a2', name: 'Century', emoji: '💯', description: '100 slaps', unlocked: false, unlocked_by: [] }],
    'dashboard/ai/vibe-check': { vibe: 'Late-night drive', mood_emoji: '🌙', description: 'Moody and slow this week.' },
    'dashboard/timeline': { entries: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, count: (i * 7) % 11 })) },
    'dashboard/genres': { genres: [{ name: 'spotify', count: 80, percentage: 64 }, { name: 'apple', count: 45, percentage: 36 }] },
    'dashboard/heatmap': { cells: Array.from({ length: 7 * 24 }, (_, k) => ({ day: Math.floor(k / 24), hour: k % 24, count: (k * 13) % 5 })) },
    'dashboard/artists': { artists: [{ name: 'Drake', count: 40 }, { name: 'SZA', count: 22 }] },
    'listening/now': { listeners: [{ username: 'zubair221b', title: 'Track 3', artist: 'Drake', is_recent: false, track_id: 't3' }] },
    'listening/user/moiz': { total_plays: 253, total_listen_hours: 15, top_tracks: [{ track_id: 't1', title: 'Track 1', artist: 'SZA', play_count: 12, unique_listeners: 2, thumb_ups: 1 }] },
    'listening/insights': { trending: [], squad_favorites: [{ track_id: 't1', title: 'Track 1', artist: 'SZA', play_count: 12, unique_listeners: 3, thumb_ups: 2, score: 9 }] },
    'listening/feed': { activity: [{ username: 'nooramin40', title: 'Track 5', artist: 'SZA', track_id: 't5', completed: true, skipped: false, timestamp: new Date((NOW - 600) * 1000).toISOString() }] },
    'listening/comments': { comments: [{ id: 'c1', username: 'zubair221b', title: 'Track 3', artist: 'Drake', text: 'this one goes hard', is_reaction: false, created_at: new Date((NOW - 900) * 1000).toISOString() }] },
    'dashboard/recent': { items: [SONG(4), SONG(5)] },
    'dashboard/ai/digest': { digest: 'A quiet week with a Drake spike on Friday.', highlights: ['moiz kept the streak alive'] },
    'dashboard/ai/weekly-playlist': { name: 'Friday fuel', description: 'For the drive', tracks: [{ track_id: 't1', title: 'Track 1', artist: 'SZA' }] },
    'dashboard/ai/recommendations/moiz': { username: 'moiz', recommendations: ['Try more SZA deep cuts'], reasoning: 'You skip the singles.' },
  }
  if (path.startsWith('dashboard/head-to-head/')) return json(200, { user1: 'moiz', user2: 'zubair221b', user1_color: '#ff3df0', user2_color: '#22e6ff', user1_songs: 300, user2_songs: 250, user1_artists: 90, user2_artists: 70, shared_artists: ['Drake'] })
  if (path.startsWith('dashboard/taste-dna/')) return json(200, { analysis: 'Close taste, different platforms.', compatibility_score: 0.72, shared_artists: ['Drake'] })
  return S[path] ? json(200, S[path]) : json(404, { detail: `no fixture for ${path}` })
}
/** A one-shot SSE reply: the room, then the stream ends (EventSource retries). */
const sse = (room) => (r) => r.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(room)}\n\n` })

// ── Account fixtures (PS-10/11/12). Every account route is mocked, reads and writes. ──
const PSN_USERS = [
  { zitadel_user_id: 'z1', mm_username: 'goopy', online_id: 'Goopy', account_id: 'a1', linked_at: NOW - 50 * 86400, refresh_expires_at: NOW + 40 * 86400 },
  { zitadel_user_id: null, mm_username: 'bizzle', online_id: 'Bizzle', account_id: 'a2', linked_at: NOW - 70 * 86400, refresh_expires_at: NOW - 86400 },
  { zitadel_user_id: 'z3', mm_username: 'noor', online_id: 'NoorAmin', account_id: 'a3', linked_at: NOW - 58 * 86400, refresh_expires_at: NOW + 2.5 * 86400 },
]
const ACCT_BASE = {
  'GET /api/admin/check': json(200, { admin: false }),
  'GET /auth/settings/passkeys': json(200, { passkeys: [{ id: 'pk1', name: 'iPhone passkey' }, { id: 'pk2', name: 'MacIntel passkey' }] }),
  'GET /auth/settings/psn': json(200, { linked: true, online_id: 'Goopy', account_id: 'a1', linked_at: NOW - 57 * 86400, npsso_ok: true, token_ok: true, refresh_expires_at: NOW + 2.5 * 86400 }),
  'GET /auth/settings/mattermost': json(200, { linked: false, linked_at: null, connect_available: true }),
  'GET /auth/settings/mcp': json(200, { active: false, last_used_at: null }),
}
const ADMIN_READS = {
  'GET /api/pipeline-status': json(200, { services: { psn_messenger: { status: 'ok', ms: 0 }, psn_montage: { status: 'ok', ms: 12 }, wa_bridge: { status: 'down', ms: null } } }),
  'GET /status': json(200, { psn: 'connected', whatsapp: 'configured', clip_store: 's3', groups: 2, queue_depth: 0, clips_total: 1234, clips_delivered: 1200, clips_archived: 1100, clips_failed: 3, clips_active: 1 }),
  'GET /api/video-jobs': json(200, { stats: { total: 1234, delivered: 1200, failed: 3, archived: 1100, active: 1 }, queue_depth: 0 }),
  'GET /auth/settings/psn': json(200, { linked: true, online_id: 'Goopy', linked_at: NOW - 50 * 86400, token_ok: true, refresh_expires_at: NOW + 40 * 86400, admin: true, users: PSN_USERS }),
  'GET /api/admin/users': json(200, { users: [{ userId: 'u1', userName: 'goopy', displayName: 'Goopy', email: 'goopy@example.com', state: 'USER_STATE_ACTIVE' }, { userId: 'u2', userName: 'bizzle', displayName: 'Bizzle', email: 'bizzle@example.com', state: 'USER_STATE_LOCKED' }] }),
}
/** A fake platform authenticator: navigator.credentials.create resolves with fixed bytes, or rejects when told to. */
const FAKE_WEBAUTHN = () => {
  window.__cancelPasskey = false
  window.PublicKeyCredential = window.PublicKeyCredential || function PublicKeyCredential() {}
  const bytes = (str) => new TextEncoder().encode(str).buffer
  navigator.credentials.create = async ({ publicKey }) => {
    window.__createArgs = { challenge: [...new Uint8Array(publicKey.challenge)], user: [...new Uint8Array(publicKey.user.id)], exclude: (publicKey.excludeCredentials || []).map((c) => c.id instanceof ArrayBuffer) }
    if (window.__cancelPasskey) throw new DOMException('cancelled', 'NotAllowedError')
    return { id: 'cred-1', rawId: bytes('raw?>'), type: 'public-key', response: { clientDataJSON: bytes('{"c":1}'), attestationObject: bytes('att~~') } }
  }
  window.open = () => null
}

// ── Giveaway fixtures (PS-5). Times are local datetime-local strings, like the admin form sends. ──
const localIso = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
const GW_MEMBERS = [{ id: 'z1', display: 'Goopy' }, { id: 'z2', display: 'Bizzle' }, { id: 'z3', display: 'NoorAmin' }, { id: 'z4', display: 'Shah' }, { id: 'z5', display: 'Moiz' }, { id: 'z6', display: 'Goofy' }]
const gwEntries = (ids) => GW_MEMBERS.filter((m) => ids.includes(m.id)).map((m) => ({ member_id: m.id, display_name: m.display }))
function gwData({ status = 'open', revealIn = 2 * 86400e3 + 5 * 3600e3, admin = false, eligible = true, wonCycle = false, draw = null, entries = ['z1', 'z2', 'z3', 'z4'], none = false } = {}) {
  const won = [{ member_id: 'z5', display_name: 'Moiz', won_at: '2026-09-01T00:00:00+00:00', giveaway_id: 1 }, { member_id: 'z6', display_name: 'Goofy', won_at: '2026-08-01T00:00:00+00:00', giveaway_id: 0 }]
  return {
    giveaway: none ? null : { id: 7, title: 'October drop', prize: '$50 PSN card', status, draw_at: localIso(Date.now() + revealIn), reveal_at: localIso(Date.now() + revealIn), drawn_at: null, revealed_at: status === 'revealed' ? new Date().toISOString() : null, entries: gwEntries(entries), draws: [], active_draw: draw },
    rotation: { cycle: 2, total_members: 6, won_count: 2, eligible_count: 4, eligible: GW_MEMBERS.slice(0, 4), won_members: won, all_members: GW_MEMBERS },
    is_admin: admin, user_eligible: eligible, user_won_this_cycle: wonCycle,
  }
}
const GW_HISTORY = [
  { id: 1, title: 'September drop', prize: 'Elden Ring', status: 'closed', revealed_at: '2026-09-01T20:00:00+00:00', entries: [], active_draw: { draw_number: 1, winner_name: 'Moiz', winner_id: 'z5', drawn_at: '2026-09-01T20:00:00+00:00', status: 'active', manifest_hash: 'abc' } },
  { id: 0, title: 'August drop', prize: '$25 card', status: 'closed', revealed_at: '2026-08-01T20:00:00+00:00', entries: [], active_draw: { draw_number: 1, winner_name: 'Goofy', winner_id: 'z6', drawn_at: '2026-08-01T20:00:00+00:00', status: 'active', manifest_hash: 'def' } },
]
const GW_DRAW = { draw_number: 1, winner_id: 'z2', winner_name: 'Bizzle', drawn_at: new Date(Date.now() - 3600e3).toISOString(), status: 'active', manifest_hash: '9f2c1ab04e77d3c1' }

async function ready(page, path = '/app/') {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.fonts.status === 'loaded')
  await page.evaluate(() => document.fonts.ready)
}
async function fontsOk(page) {
  return page.evaluate(() => ({
    orbitron: document.fonts.check('800 29px Orbitron'),
    rajdhani: document.fonts.check('500 17px Rajdhani'),
    loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`),
  }))
}
async function axe(page, label, include) {
  await page.addScriptTag({ content: AXE })
  const r = await page.evaluate(async (inc) => {
    // eslint-disable-next-line no-undef
    const res = await axe.run(inc ? { include: [inc] } : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } })
    return res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  }, include || null)
  check(`axe: ${label}`, r.length === 0, r.join('; '))
}
/** Every visible interactive element must be at least 44 × 44 CSS px. */
async function tapTargets(page, label) {
  const small = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=tab], [role=menuitem]')) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || el.closest('.sr-only')) continue
      if (el.classList.contains('skip-link') && r.bottom <= 0) continue
      if (r.bottom < 0 || r.top > innerHeight * 4) continue
      // A checkbox's target is its whole label row.
      const box = el.type === 'checkbox' && el.closest('label') ? el.closest('label').getBoundingClientRect() : r
      if (box.width < 44 - 0.5 || box.height < 44 - 0.5) out.push(`${el.tagName.toLowerCase()}"${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}" ${Math.round(box.width)}×${Math.round(box.height)}`)
    }
    return out
  })
  check(`tap targets ≥ 44px: ${label}`, small.length === 0, small.join(', '))
}
const shot = async (page, name, fullPage = false) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }) }

try {
  // ── 1. Mobile 375 × 800 against the real backend (reads only) ──────────────
  {
    const { ctx, page } = await newPage({ width: 375, height: 800 })
    await ready(page)
    await page.waitForSelector('.presence-row .who-name, .empty, .error-strip', { timeout: 20_000 })
    await page.waitForSelector('.hype-num', { timeout: 20_000 })
    const f = await fontsOk(page)
    check('fonts loaded before capture (Orbitron + Rajdhani)', f.orbitron && f.rajdhani, f.loaded.join(', '))
    const bar = await page.$eval('.topbar-row', (e) => e.getBoundingClientRect().height)
    const mascot = await page.$eval('.topbar .mascot', (e) => e.getBoundingClientRect().width)
    check('top bar at rest is 72px with a 64px mascot', Math.round(bar) === 72 && Math.round(mascot) === 64, `${bar} / ${mascot}`)
    check('tagline visible at rest', await page.isVisible('.topbar-tagline'))
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.glass')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).length)
    check('no card overflows the 375px viewport', overflow === 0, `${overflow} overflowing`)
    check('initial load does not focus-ring the h1', await page.evaluate(() => document.activeElement?.tagName !== 'H1'))
    const mainTop = await page.$eval('.page', (e) => e.getBoundingClientRect().top)
    await shot(page, 'squad-375-rest')
    await shot(page, 'squad-375-full', true)
    await axe(page, 'Squad 375 rest')
    await tapTargets(page, 'Squad 375')
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(500)
    const barC = await page.$eval('.topbar-row', (e) => e.getBoundingClientRect().height)
    const mascotC = await page.$eval('.topbar .mascot', (e) => e.getBoundingClientRect().width)
    const tagOpacity = await page.$eval('.topbar-tagline', (e) => getComputedStyle(e).opacity)
    check('top bar condenses to 48px, mascot 40px, tagline hidden', Math.round(barC) === 48 && Math.round(mascotC) === 40 && tagOpacity === '0', `${barC} / ${mascotC} / opacity ${tagOpacity}`)
    await shot(page, 'squad-375-condensed')
    await page.mouse.wheel(0, -2000)
    await page.waitForTimeout(400)
    const mainTop2 = await page.$eval('.page', (e) => e.getBoundingClientRect().top)
    check('no layout shift from the top bar (content top unchanged)', Math.abs(mainTop - mainTop2) < 1, `${mainTop} vs ${mainTop2}`)

    // Chat Board sheet
    await page.click('.handle-btn')
    await page.waitForSelector('.board-sheet .tile.c1, .board-sheet .tile.c2', { timeout: 15_000 })
    await page.waitForTimeout(350)
    check('sheet is a dialog labelled Chat Board', (await page.getAttribute('.board-sheet', 'role')) === 'dialog' && (await page.$eval('.board-sheet', (e) => document.getElementById(e.getAttribute('aria-labelledby'))?.textContent)) === 'Chat Board')
    const tileH = await page.$eval('.board-sheet .tile', (e) => e.getBoundingClientRect().height)
    check('tiles are at least 64px tall', tileH >= 64, `${tileH}`)
    const restGlow = await page.$eval('.board-sheet .tile:not(.add)', (e) => getComputedStyle(e).boxShadow)
    check('tiles carry the resting glow', /rgba?\(/.test(restGlow) && restGlow !== 'none', restGlow)
    await shot(page, 'squad-375-sheet-open')
    await axe(page, 'Chat Board sheet 375')
    await tapTargets(page, 'Chat Board sheet 375')
    // focus trap: tab many times, focus stays in the sheet
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab')
    check('focus is trapped in the sheet', await page.evaluate(() => Boolean(document.activeElement?.closest('.board-sheet'))))
    // Mine tab: loopback has no session → signed-out row
    await page.click('.board-sheet [role=tab]:has-text("Mine")')
    await page.waitForSelector('.board-sheet .empty-title', { timeout: 10_000 })
    check('Mine tab without a session says "Sign in to build it"', (await page.textContent('.board-sheet .empty-title')) === 'Sign in to build it')
    await page.click('.board-sheet [role=tab]:has-text("Shared")')
    // Edit mode: tiles do not fire, custom tiles get a Remove control
    await page.click('.board-sheet button:has-text("Edit")')
    const removeCount = await page.locator('.board-sheet .tile-remove').count()
    check('Edit shows a remove control on custom tiles', removeCount > 0, `${removeCount}`)
    await shot(page, 'squad-375-sheet-edit')
    await page.click('.board-sheet button:has-text("Done")')
    await page.click('.board-sheet button:has-text("Organize")')
    check('Organize shows Move earlier / Move later', (await page.locator('.board-sheet [aria-label^="Move "]').count()) > 2)
    await tapTargets(page, 'Organize mode 375')
    await page.click('.board-sheet button:has-text("Done")')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    check('Escape closes the sheet and focus returns to the handle', await page.evaluate(() => document.activeElement?.classList.contains('handle-btn')))

    // More sheet
    await page.click('.tabbar button:has-text("More")')
    await page.waitForSelector('.sheet-more')
    await page.waitForTimeout(300)
    check('Admin is hidden for a non-admin', (await page.locator('.sheet-more a:has-text("Admin")').count()) === 0)
    await shot(page, 'more-375')
    await axe(page, 'More sheet 375')
    await tapTargets(page, 'More sheet 375')
    await page.keyboard.press('Escape')
    const navLabels = await page.$$eval('nav[aria-label]', (n) => n.map((x) => x.getAttribute('aria-label')))
    check('nav landmarks have distinct labels', new Set(navLabels).size === navLabels.length, navLabels.join(', '))
    check('no unmocked writes and no page errors (mobile read pass)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }

  // ── 2. Desktop 1440 × 900 ───────────────────────────────────────────────────
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900 })
    await ready(page)
    await page.evaluate(() => localStorage.removeItem('crcmz_app_board_collapsed'))
    await ready(page)
    await page.waitForSelector('.chat-panel .tile', { timeout: 20_000 })
    await page.waitForSelector('.presence-row .who-name, .empty, .error-strip', { timeout: 20_000 })
    await page.waitForSelector('.hype-num', { timeout: 20_000 })
    const f = await fontsOk(page)
    check('fonts loaded (desktop)', f.orbitron && f.rajdhani)
    check('sidebar shown, tab bar hidden at 1440', (await page.isVisible('.sidebar')) && !(await page.isVisible('.tabbar')))
    const wm = await page.$eval('.sidebar-brand .wordmark-text', (e) => e.getBoundingClientRect().right)
    const sw = await page.$eval('.sidebar', (e) => e.getBoundingClientRect().right)
    check('sidebar wordmark fits inside the sidebar', wm <= sw - 4, `${wm} vs ${sw}`)
    const statsOk = await page.$$eval('.stats .stat', (els) => els.every((e, i) => i === 0 || e.getBoundingClientRect().left >= els[i - 1].querySelector(':scope > span').getBoundingClientRect().right))
    check('stat tiles do not overlap', statsOk)
    const pw = await page.$eval('.chat-panel', (e) => e.getBoundingClientRect().width)
    check('Chat Board panel is 360px', Math.round(pw) === 360, `${pw}`)
    await shot(page, 'squad-1440-panel')
    await axe(page, 'Squad 1440')
    await tapTargets(page, 'Squad 1440')
    await page.click('button[aria-label="Collapse Chat Board"]')
    await page.waitForTimeout(200)
    const rw = await page.$eval('.chat-panel', (e) => e.getBoundingClientRect().width)
    check('panel collapses to a 60px rail', Math.round(rw) === 60, `${rw}`)
    await shot(page, 'squad-1440-rail')
    await page.click('button[aria-label="Expand Chat Board"]')
    await page.goto(BASE + '/app/whatsapp')
    await page.waitForSelector('h1')
    await shot(page, 'handoff-1440')
    await axe(page, 'Handoff 1440')
    check('no unmocked writes and no page errors (desktop)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }

  // ── 3. Routing: legacy ?p=, handoffs, not found, admin gating ──────────────
  {
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { 'GET /': classicStub, ...CLIP_READS } })
    const map = { squad: '/app', pipeline: '/app/clips', upload: '/app/clips?upload', slap: '/app/slap', wa: '/app/whatsapp', giveaway: '/app/giveaway', watch: '/app/watch', huddle: '/app/huddle', coach: '/app/coach', ai: '/app/ask', nope: '/app', '../../etc': '/app' }
    for (const [k, want] of Object.entries(map)) {
      await page.goto(`${BASE}${process.env.LEGACY_PREFIX || "/app/"}?p=${encodeURIComponent(k)}`)
      await page.waitForSelector('h1')
      const u = new URL(page.url())
      check(`legacy ?p=${k} → ${want}`, u.pathname + u.search === want || (want === '/app' && u.pathname === '/app'), u.pathname + u.search)
    }
    const classic = { 'clips/x': '/?p=pipeline', whatsapp: '/?p=wa', watch: '/?p=watch', huddle: '/?p=huddle', coach: '/?p=coach', ask: '/?p=ai' }
    for (const [route, href] of Object.entries(classic)) {
      await page.goto(`${BASE}/app/${route}`)
      await page.waitForSelector('.handoff a.btn')
      const got = await page.getAttribute('.handoff a.btn', 'href')
      check(`/app/${route} hands off to ${href}`, got === href, got)
    }
    await page.goto(`${BASE}/app/clips?upload`)
    await page.waitForSelector('.sheet-clip .send-body')
    check('/app/clips?upload opens Send a video in /app', (await page.textContent('.sheet-clip .clip-sheet-title')) === '📤 Send a video' && new URL(page.url()).pathname === '/app/clips', page.url())
    await page.goto(`${BASE}/app/admin`)
    await page.waitForSelector('.handoff-lede')
    check('/app/admin for a non-admin says "Admins only"', (await page.textContent('.handoff-lede')) === 'Admins only')
    await page.goto(`${BASE}/app/definitely/not/here`)
    await page.waitForSelector('h1')
    check('unknown /app path renders not-found', (await page.textContent('h1')) === 'Not here')
    await shot(page, 'not-found-375')
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900, mocks: { ...ADMIN_READS, 'GET /api/admin/check': json(200, { admin: true }) } })
    await ready(page, '/app/admin')
    await page.waitForSelector('.svc-row')
    check('admin sees Admin in the sidebar', (await page.locator('nav[aria-label="Primary"] a:has-text("Admin")').count()) === 1)
    check('/app/admin for an admin is the Admin page in /app', (await page.locator('.handoff').count()) === 0 && (await page.textContent('h1')) === 'Admin')
    await ctx.close()
  }
  {
    // Signed out: the session probe answers 401 → /auth/login?next=<current /app path>
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        'GET /api/admin/check': json(401, { detail: 'authentication required' }),
        'GET /auth/login': (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>login stub</h1>' }),
      },
    })
    await page.goto(`${BASE}/app/giveaway?x=1`)
    await page.waitForURL(/\/auth\/login/, { timeout: 10_000 })
    const u = new URL(page.url())
    check('signed-out probe redirects to /auth/login?next=<path>', u.searchParams.get('next') === '/app/giveaway?x=1', page.url())
    await ctx.close()
  }

  // ── 4. F-0 send outcomes, all mocked ───────────────────────────────────────
  async function sheetPage(mocks, opts = {}) {
    const p = await newPage({ width: 375, height: 800, mocks, ...opts })
    await ready(p.page)
    await p.page.evaluate(() => { localStorage.setItem('crcmz_app_board_tab', '"shared"'); localStorage.removeItem('crcmz_app_quick_draft') })
    await ready(p.page)
    await p.page.click('.handle-btn')
    await p.page.waitForSelector('.board-sheet .tile:not(.add)', { timeout: 15_000 })
    return p
  }
  const firstTile = '.board-sheet .tile-grid > li:first-child .tile'

  {
    let hits = 0
    const { ctx, page } = await sheetPage({ 'POST /v2/squad': delayed(600, (r) => { hits++; return json(200, { status: 'sent', message: 'x' })(r) }) })
    await page.click(firstTile)
    await page.click(firstTile, { force: true })
    await page.click('.board-sheet .tile-grid > li:nth-child(2) .tile', { force: true })
    await page.waitForSelector(`${firstTile}[aria-busy="true"]`)
    check('Sending: tile shows "Sending…" and is aria-busy', (await page.textContent(`${firstTile} .tile-sub`)).includes('Sending'))
    await page.waitForSelector(`${firstTile}.fired`, { timeout: 5000 })
    check('Sent: tile shows "Sent ✓" with the fire glow', (await page.textContent(`${firstTile} .tile-sub`)).includes('Sent'))
    check('one request per tap burst (3 taps → 1 POST)', hits === 1, `${hits} requests`)
    await page.waitForTimeout(80)
    await shot(page, 'send-sent-375')
    await page.waitForSelector('.flyout', { timeout: 2000 }).then(() => check('Sent flyout appears', true)).catch(() => check('Sent flyout appears', false))
    check('no unmocked writes (sent)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const { ctx, page } = await sheetPage({ 'POST /v2/squad': json(429, { detail: 'Slow down — try again in 6.2s.' }, { 'Retry-After': '7' }) })
    await page.click(firstTile)
    await page.waitForSelector('.board-note[data-tone="countdown"]')
    const subs = await page.$$eval('.board-sheet .tile:not(.add) .tile-sub', (e) => e.map((x) => x.textContent))
    check('429: every tile shows the shared countdown', subs.length > 1 && subs.every((t) => /Slow down · \d+s/.test(t)), subs.slice(0, 3).join(' | '))
    const sendLabel = await page.textContent('.send-btn')
    check('429: the composer Send shows the same countdown', /Slow down · \d+s/.test(sendLabel), sendLabel)
    check('429: toast is neutral "Slow down a sec"', (await page.textContent('.toasts')).includes('Slow down a sec'))
    await shot(page, 'send-429-375')
    await page.click('.board-sheet .tile-grid > li:nth-child(2) .tile', { force: true })
    check('429: taps during the countdown do not send', page.writes.filter((w) => w === 'POST /v2/squad').length === 1)
    await ctx.close()
  }
  {
    const { ctx, page } = await sheetPage({ 'POST /v2/squad': json(500, { detail: 'Failed to send squad message' }) })
    await page.click(firstTile)
    await page.waitForFunction((s) => document.querySelector(s)?.textContent?.includes('Unknown'), `${firstTile} .tile-sub`)
    check('500: tile shows Unknown', true)
    check('500: toast says "may or may not have landed"', (await page.textContent('.toasts')).includes('may or may not'))
    await page.waitForTimeout(1200)
    check('500: never auto-retried', page.writes.filter((w) => w === 'POST /v2/squad').length === 1)
    await shot(page, 'send-unknown-375')
    await ctx.close()
  }
  {
    const { ctx, page } = await sheetPage({ 'POST /v2/squad': json(503, { detail: 'squad messenger not initialized' }) })
    await page.click(firstTile)
    await page.waitForFunction((s) => document.querySelector(s)?.textContent?.includes('Not sent'), `${firstTile} .tile-sub`)
    check('503: tile shows Not sent + "isn\'t reachable" toast', (await page.textContent('.toasts')).includes("isn't reachable"))
    await ctx.close()
  }
  {
    // Composer: aborted request → Unknown, draft kept, "Send again anyway"; then 200 → cleared.
    let mode = 'abort'
    const { ctx, page } = await sheetPage({ 'POST /v2/send': (r) => (mode === 'abort' ? r.abort('connectionreset') : json(200, { status: 'sent', message: 'hi' })(r)) })
    await page.fill('#quick-message', 'gg lads')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.send-btn')?.textContent === 'Send again anyway')
    check('network error: composer keeps the draft', (await page.inputValue('#quick-message')) === 'gg lads')
    check('network error: inline "may or may not have sent"', (await page.textContent('.composer')).includes('may or may not have sent'))
    await shot(page, 'composer-unknown-375')
    await page.waitForTimeout(1000)
    check('network error: never auto-retried', page.writes.filter((w) => w === 'POST /v2/send').length === 1)
    mode = 'ok'
    await page.click('.send-btn')
    await page.waitForFunction(() => document.querySelector('.send-btn')?.textContent?.includes('Sent'))
    check('Sent: composer clears the draft', (await page.inputValue('#quick-message')) === '')
    check('no unmocked writes (composer)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Add tile with send:false never fires; body shape is {text, send}.
    let body = null
    const { ctx, page } = await sheetPage({
      'POST /api/soundboard': (r) => { body = r.request().postDataJSON(); return json(200, { status: 'added', button: { label: 'Test tile', msg: 'Test tile', cls: 'c3', custom: true }, flavored: 'Test tile', sent: false })(r) },
    })
    await page.click('.board-sheet .tile.add')
    await page.waitForSelector('.dialog')
    await page.waitForTimeout(450)
    await axe(page, 'Add tile dialog')
    await tapTargets(page, 'Add tile dialog')
    await shot(page, 'add-tile-375')
    await page.fill('#tile-text', 'Test tile')
    await page.click('.check-row')
    await page.click('.dialog button[type=submit]')
    await page.waitForSelector('.dialog', { state: 'detached' })
    check('add tile posts {text, send:false}', body && body.text === 'Test tile' && body.send === false, JSON.stringify(body))
    check('add tile with send off does not hit /v2/squad', !page.writes.includes('POST /v2/squad'))
    check('no unmocked writes (add)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Remove a custom tile: body matches on msg (`text`), confirm names the tile.
    let body = null
    const { ctx, page } = await sheetPage({ 'POST /api/soundboard/delete': (r) => { body = r.request().postDataJSON(); return json(200, { status: 'deleted', removed: 0 })(r) } })
    await page.click('.board-sheet button:has-text("Edit")')
    const first = page.locator('.board-sheet .tile-remove').first()
    const label = (await first.getAttribute('aria-label')).replace(/^Remove /, '')
    await first.click()
    await page.waitForSelector('[role=alertdialog]')
    check('remove confirm names the tile', (await page.textContent('#remove-desc')).includes(label))
    await page.waitForTimeout(450)
    await shot(page, 'remove-tile-375')
    await page.click('[role=alertdialog] button:has-text("Remove")')
    await page.waitForSelector('[role=alertdialog]', { state: 'detached' })
    const tiles = await page.evaluate(() => fetch('/api/soundboard').then((r) => r.json()))
    const tile = tiles.buttons.find((b) => b.label === label)
    check('remove posts {text: <msg>}', body && tile && body.text === tile.msg, JSON.stringify(body))
    await ctx.close()
  }
  {
    // Reduced motion: no sweep, static lime edge.
    const { ctx, page } = await sheetPage({ 'POST /v2/squad': json(200, { status: 'sent' }) }, { reducedMotion: 'reduce' })
    await page.click(firstTile)
    await page.waitForSelector(`${firstTile}.fired`)
    const after = await page.$eval(firstTile, (e) => getComputedStyle(e, '::after').display)
    const aurora = await page.evaluate(() => getComputedStyle(document.body, '::before').animationName)
    check('reduced motion: no sweep on fire, aurora drift stopped', after === 'none' && aurora === 'none', `${after} / ${aurora}`)
    await ctx.close()
  }

  // ── 5. Clips (PS-2), fixtures for reads, every write mocked ────────────────
  {
    const vetoes = []
    const syncs = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...CLIP_READS,
        'GET /api/admin/check': json(200, { admin: true }),
        'POST /api/reels/sync': (r) => { syncs.push(1); return json(200, { ok: true })(r) },
        'POST /api/reels/clips/r0/veto': (r) => { vetoes.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      },
    })
    await ready(page, '/app/clips')
    await page.waitForSelector('.reel-card', { timeout: 15_000 })
    check('Clips h1', (await page.textContent('h1')) === 'Clips')
    const summary = await page.textContent('.clips-summary')
    check('summary bar: month · 142 clips · build in 3d 4h', /142 clips · build in 3d [34]h/.test(summary), summary)
    check('first 12 reels shown, then Show more', (await page.locator('.reel-card').count()) === 12 && (await page.isVisible('button:has-text("Show more")')))
    check('reel chips carry counts', (await page.textContent('.chips button[aria-pressed="true"]')).includes('15'))
    check('This month numeral in gold', (await page.textContent('.month-num')) === '142')
    check('Montage line v8 · 19 clips · 13m 54s', (await page.textContent('.montage-line')).replace(/\s+/g, ' ') === 'v8 · 19 clips · 13m 54s', await page.textContent('.montage-line'))
    check('manifest shows included and excluded with reason', (await page.textContent('.manifest-row[data-included], .manifest-state[data-included="yes"]')) !== null && (await page.textContent('.clips-col-month')).includes('too short'))
    const order = await page.$$eval('.clips-col', (els) => els.map((e) => [e.className.split(' ')[1], Math.round(e.getBoundingClientRect().top)]))
    check('mobile order: reels, month, uploads', order[0][1] < order[1][1] && order[1][1] < order[2][1], JSON.stringify(order))
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.glass')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).length)
    check('no Clips card overflows 375px', overflow === 0, `${overflow}`)
    await shot(page, 'clips-375')
    await shot(page, 'clips-375-full', true)
    await axe(page, 'Clips overview 375')
    await tapTargets(page, 'Clips overview 375')

    await page.click('.chips button:has-text("Vetoed")')
    check('Vetoed filter narrows the reels', (await page.locator('.reel-card').count()) === 3)
    await page.click('.chips button:has-text("All")')

    await page.click('button:has-text("↻ Sync")')
    await page.waitForFunction(() => !document.querySelector('.reel-tools [aria-busy]'))
    check('Sync posts once (mocked)', syncs.length === 1, `${syncs.length}`)

    await page.click('.reel-card >> nth=0')
    await page.waitForSelector('.sheet-clip video')
    await page.waitForTimeout(300)
    check('reel sheet has the source video and a Studio link', (await page.getAttribute('.sheet-clip video', 'src')).endsWith('/api/reels/clips/r0/source') && (await page.getAttribute('.sheet-clip a:has-text("Studio")', 'href')) === '/app/clips/r0/edit')
    await shot(page, 'clips-375-reel-sheet')
    await axe(page, 'Reel sheet 375')
    await page.click('.sheet-clip button:has-text("Veto")')
    await page.waitForSelector('[role=alertdialog]')
    check('veto asks first', (await page.textContent('[role=alertdialog]')).includes("It won't be included in the montage"))
    check('no veto posted before confirming', vetoes.length === 0)
    await page.click('[role=alertdialog] button:has-text("Veto")')
    await page.waitForFunction(() => !document.querySelector('.sheet-clip [aria-busy]'))
    check('veto posts once after confirm (mocked)', vetoes.length === 1, JSON.stringify(vetoes))
    await page.keyboard.press('Escape')
    await page.waitForSelector('.sheet-clip', { state: 'detached' })

    // Fold state persists
    await page.click('.fold:has(.section-h2:text("Your uploads")) > summary')
    await page.waitForFunction(() => localStorage.getItem('clips.fold.uploads') === 'false')
    await page.reload()
    await page.waitForSelector('.reel-card')
    check('a folded section stays folded after reload', !(await page.$eval('.fold:has(.section-h2:text("Your uploads"))', (e) => e.open)), await page.evaluate(() => localStorage.getItem('clips.fold.uploads')))
    check('no unmocked writes and no page errors (Clips overview)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // All clips + admin re-send (mocked): confirm first, one request, 410 disables.
    const resends = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...CLIP_READS,
        'GET /api/admin/check': json(200, { admin: true }),
        'POST /api/clips/m0/resend': delayed(400, (r) => { resends.push(1); return json(200, { status: 'sent', caption: 'x', wa: {} })(r) }),
        'POST /api/clips/m2/resend': (r) => { resends.push(2); return json(410, { detail: 'archived file missing' })(r) },
      },
    })
    await ready(page, '/app/clips')
    await page.click('[role=tab]:has-text("All clips")')
    await page.waitForSelector('.clip-row')
    check('All clips sets view=all in the URL', new URL(page.url()).searchParams.get('view') === 'all')
    check('catalogue shows 50 rows and Load more', (await page.locator('.clip-row').count()) === 50 && (await page.isVisible('button:has-text("Load more")')))
    await page.selectOption('.cat-filter select >> nth=2', 'failed')
    await page.waitForFunction(() => new URL(location.href).searchParams.get('status') === 'failed')
    check('a filter lands in the URL', true)
    await shot(page, 'clips-375-all')
    await axe(page, 'All clips 375')
    await tapTargets(page, 'All clips 375')
    await page.goto(`${BASE}/app/clips?view=all`)
    await page.waitForSelector('.clip-row')

    await page.click('.clip-row >> nth=1')
    await page.waitForSelector('.sheet-clip .player-gone')
    check('purged clip says the media was cleared', (await page.textContent('.sheet-clip .player-gone')).includes('14-day retention'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    await page.click('.clip-row >> nth=0')
    await page.waitForSelector('.sheet-clip button:has-text("Re-send to WhatsApp")')
    check('player points at the session-cookie media URL', (await page.getAttribute('.sheet-clip video', 'src')) === '/api/clips/media?uid=m0')
    await page.click('.sheet-clip button:has-text("Re-send to WhatsApp")')
    await page.waitForSelector('[role=alertdialog]')
    check('re-send asks first and names the group', (await page.textContent('[role=alertdialog]')).includes('to the Goopers group'))
    check('nothing sent before confirming', resends.length === 0)
    await page.waitForTimeout(450)
    await shot(page, 'clips-375-resend-confirm')
    await page.click('[role=alertdialog] button:has-text("Re-send")')
    await page.waitForSelector('.resend button[aria-busy="true"]')
    await page.click('.resend button', { force: true })
    await page.waitForSelector('.resend button:has-text("Sent ✓")', { timeout: 5000 })
    check('re-send: one request, then Sent ✓', resends.length === 1, `${resends}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    await page.click('.clip-row >> nth=2')
    await page.click('.sheet-clip button:has-text("Re-send to WhatsApp")')
    await page.click('[role=alertdialog] button:has-text("Re-send")')
    await page.waitForSelector('.resend-msg:has-text("gone from storage")')
    check('410 disables re-send with the storage message', (await page.getAttribute('.resend button', 'aria-disabled')) === 'true')
    check('no unmocked writes and no page errors (All clips)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // A member sees no re-send control.
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { ...CLIP_READS, 'GET /api/admin/check': json(200, { admin: false }) } })
    await ready(page, '/app/clips?view=all')
    await page.click('.clip-row >> nth=0')
    await page.waitForSelector('.sheet-clip .meta-list')
    check('members get no Re-send control', (await page.locator('.sheet-clip .resend').count()) === 0)
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900, mocks: { ...CLIP_READS, 'GET /api/admin/check': json(200, { admin: true }) } })
    await ready(page, '/app/clips')
    await page.waitForSelector('.reel-card')
    const cols = await page.$$eval('.clips-col', (els) => Object.fromEntries(els.map((e) => [e.className.split(' ')[1], Math.round(e.getBoundingClientRect().left)])))
    check('desktop: uploads · reels · month columns', cols['clips-col-uploads'] < cols['clips-col-reels'] && cols['clips-col-reels'] < cols['clips-col-month'], JSON.stringify(cols))
    check('desktop shows 15 of 15 reels (24 per page)', (await page.locator('.reel-card').count()) === 15)
    await shot(page, 'clips-1440')
    await axe(page, 'Clips 1440')
    await page.click('.reel-card >> nth=0')
    await page.waitForSelector('.dialog-wide video')
    const w = await page.$eval('.dialog-wide', (e) => e.getBoundingClientRect().width)
    check('desktop clip dialog is 760px', Math.round(w) === 760, `${w}`)
    await shot(page, 'clips-1440-reel-dialog')
    check('no unmocked writes and no page errors (Clips desktop)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }

  // ── 6. Send a video (CL-26): chunked, resumable; start/chunk/finish/withdraw mocked ──
  {
    const starts = [], chunks = [], finishes = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...CLIP_READS,
        'POST /api/video-uploads/start': (r) => {
          const b = r.request().postDataJSON()
          starts.push(b)
          return json(200, { upload_id: 'u1', chunk_bytes: 8 * MB, size: b.size, received: 0, resumed: false })(r)
        },
        'PUT /api/video-uploads/chunk': delayed(150, (r) => {
          const u = new URL(r.request().url())
          const off = Number(u.searchParams.get('offset'))
          const len = r.request().postDataBuffer()?.length ?? 0
          chunks.push([off, len])
          // The first chunk is "already on the server": the client must carry on from its count.
          if (chunks.length === 1) return json(409, { detail: 'chunk out of order', code: 'offset', received: 8 * MB })(r)
          return json(200, { received: off + len })(r)
        }),
        'POST /api/video-uploads/finish': (r) => {
          finishes.push(r.request().postDataJSON())
          return json(200, { ok: true, upload: { video_post_id: 'v2', status: 'queued', caption: 'clutch', filename: 'clip.mp4', uploaded_at: NOW, platforms: {} } })(r)
        },
      },
    })
    await ready(page, '/app/clips')
    await page.waitForSelector('.reel-card')
    await page.click('.clips-cta .btn-primary')
    await page.waitForSelector('.sheet-clip .send-body .file-pick')
    check('Send a video opens as a bottom sheet on a phone', new URL(page.url()).searchParams.has('upload'))
    await shot(page, 'upload-375-sheet')
    await axe(page, 'Send a video sheet', '.sheet-clip')
    // Wrong format is refused before anything is sent.
    await page.setInputFiles('.sheet-clip input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') })
    await page.waitForSelector('.send-msg[data-tone="error"]')
    check('a non-video file is refused in words', (await page.textContent('.send-msg')).includes('MP4 or MOV'))
    await page.setInputFiles('.sheet-clip input[type=file]', { name: 'big.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(26_000_000) })
    await page.waitForFunction(() => document.querySelector('.send-msg')?.textContent?.includes('limit'))
    check('an over-size video is refused before upload', starts.length === 0)
    await page.setInputFiles('.sheet-clip input[type=file]', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(20 * MB, 7) })
    await page.waitForSelector('.send-file:has-text("clip.mp4")', { timeout: 10_000 })
    await page.fill('.sheet-clip textarea', 'clutch')
    await page.click('.send-actions .btn-primary')
    await page.waitForSelector('.send-bar')
    await page.waitForSelector('.upload-pill')
    await shot(page, 'upload-375-sending')
    await page.waitForSelector('.send-msg[data-tone="ok"]', { timeout: 20_000 })
    check('one start with caption and a file key', starts.length === 1 && starts[0].caption === 'clutch' && /^20971520\|[0-9a-f]{24}\|[0-9a-f]{24}$/.test(starts[0].file_key), JSON.stringify(starts.map((x) => ({ ...x, file_key: x.file_key?.slice(0, 20) }))))
    check('chunks are 8 MB, in order, and follow the server offset', JSON.stringify(chunks) === JSON.stringify([[0, 8 * MB], [8 * MB, 8 * MB], [16 * MB, 4 * MB]]), JSON.stringify(chunks))
    check('finish once with the upload id', finishes.length === 1 && finishes[0].upload_id === 'u1', JSON.stringify(finishes))
    check('summary pill says Queued ✓', (await page.textContent('.upload-pill')) === 'Queued ✓')
    await shot(page, 'upload-375-queued')
    check('no unmocked writes and no page errors (upload)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // A 409 at start is explained in words; nothing else is sent.
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: { ...CLIP_READS, 'POST /api/video-uploads/start': json(409, { detail: 'already queued', code: 'already_queued' }) },
    })
    await ready(page, '/app/clips?upload')
    await page.waitForSelector('.sheet-clip .file-pick')
    await page.setInputFiles('.sheet-clip input[type=file]', { name: 'clip.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(MB) })
    await page.waitForSelector('.send-file:has-text("clip.mov")', { timeout: 10_000 })
    await page.click('.send-actions .btn-primary')
    await page.waitForSelector('.send-msg[data-tone="error"]')
    check('409 already_queued → "You already have one in the queue."', (await page.textContent('.send-msg')) === 'You already have one in the queue.')
    check('no unmocked writes (upload 409)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // A queued video with no links can be withdrawn behind a confirm; the form waits.
    const withdraws = []
    const queued = { video_post_id: 'v9', status: 'queued', caption: 'late night', filename: 'b.mp4', uploaded_at: NOW - 600, posted_at: null, skip_reason: null, duration_seconds: 20, platforms: { instagram: null } }
    const { ctx, page } = await newPage({
      width: 1440, height: 900,
      mocks: {
        ...CLIP_READS,
        'GET /api/video-uploads/mine': json(200, { psn_id: 'Goopy', uploads: [queued], can_upload: false, open_session: null, limits: UPLOAD_LIMITS }),
        'POST /api/video-uploads/withdraw': (r) => { withdraws.push(r.request().postDataJSON()); return json(200, { ok: true, upload: { ...queued, status: 'skipped' } })(r) },
      },
    })
    await ready(page, '/app/clips?upload')
    await page.waitForSelector('.send-card .send-msg')
    check('desktop: ?upload uses the inline card, no sheet', (await page.locator('.sheet-clip').count()) === 0)
    check('one in the queue: the form explains why it waits', (await page.textContent('.send-card .send-msg')).includes("hasn't been posted yet"))
    await shot(page, 'upload-1440-inline')
    await page.click('.upload-wd')
    await page.waitForSelector('.dialog-confirm')
    check('withdraw asks first', withdraws.length === 0 && (await page.textContent('.dialog-confirm .dialog-title')) === 'Withdraw this video?')
    await page.click('.dialog-confirm .btn-primary')
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('Withdrawn'))
    check('withdraw posts the video id once', withdraws.length === 1 && withdraws[0].video_post_id === 'v9', JSON.stringify(withdraws))
    check('no unmocked writes and no page errors (withdraw)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 7. The Studio (CL-12–20): render / save / force / veto all mocked ──
  const srcReady = (page) => page.waitForFunction(() => (document.querySelector('.st-src')?.readyState ?? 0) >= 1, null, { timeout: 15_000 })
  const at = (page, t) => page.evaluate(async (t) => {
    const v = document.querySelector('.st-src')
    v.currentTime = t
    await new Promise((ok) => v.addEventListener('seeked', ok, { once: true }))
  }, t)

  {
    const r0 = REELS[0]
    const detail = (over = {}) => ({
      clip: { clip_id: 'r0', sender: 'Goopy', game: 'Rocket League', duration: 20, when: r0.when, message: 'what a save 🔥' },
      analysis: {
        primary_start: 4, primary_end: 12, featured_label: 'Goopy', identity_confidence: 'high', caption_draft: 'Clutch save',
        subtitle_segments: [{ start: 5, end: 7, subtitle_text: 'no way' }],
      },
      override: null, vetoed: false, pipeline: { state: 'daily_eligible' }, latest_render: null, ...over,
    })
    const renders = [], overrides = [], vetoes = [], forces = []
    let polls = 0
    const studioMocks = (d, extra = {}) => ({
      ...CLIP_READS,
      'GET /api/admin/check': json(200, { admin: false }),
      'GET /api/reels/clips/r0': json(200, d),
      'GET /api/reels/clips/r0/source': serveRange(STUDIO_VIDEO, 'video/webm'),
      'GET /api/reels/clips/r0/frame': (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: STUDIO_FRAME }),
      'GET /api/reels/renders/rd1': (r) => { polls++; return json(200, { status: polls < 2 ? 'running' : 'done' })(r) },
      'GET /api/reels/renders/rd1/video': serveRange(STUDIO_VIDEO, 'video/webm'),
      'GET /api/reels/renders/rd1/trajectory': json(200, { t0: 5, traj: [[0, 400], [3, 900], [6, 650]] }),
      'POST /api/reels/clips/r0/render': (r) => { renders.push(r.request().postDataJSON()); return json(200, { render_id: 'rd1' })(r) },
      'POST /api/reels/clips/r0/override': (r) => { overrides.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      'POST /api/reels/clips/r0/veto': (r) => { vetoes.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      'POST /api/reels/clips/r0/force-post': (r) => { forces.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      ...extra,
    })
    // Phone: open from the reel sheet, edit, render, save, veto.
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: studioMocks(detail()) })
    await ready(page, '/app/clips')
    await page.waitForSelector('.reel-card')
    await page.click('.reel-card >> nth=0')
    await page.click('.sheet-clip a:has-text("Edit in the Studio")')
    await page.waitForSelector('.studio .st-top')
    check('Edit in the Studio opens /app/clips/r0/edit in /app', new URL(page.url()).pathname === '/app/clips/r0/edit', page.url())
    await srcReady(page)
    check('Studio title is sender · duration', (await page.textContent('.st-title b')) === 'Goopy · 20s')
    check('pipeline strip explains where the clip is headed', (await page.textContent('.st-pipe')).includes('daily highlights'))
    check('phone: no tool panel until a tool is picked', (await page.locator('.st-panel').count()) === 0)
    const cv = await page.$eval('.st-canvas', (e) => { const r = e.getBoundingClientRect(); return [r.width, r.height] })
    check('Live view is 9:16', Math.abs(cv[0] / cv[1] - 9 / 16) < 0.01, cv.join('×'))
    check('Live view shows the featured player label', (await page.textContent('.st-label')) === 'Goopy')
    await shot(page, 'studio-375')
    await axe(page, 'Studio 375', '.studio')
    await tapTargets(page, 'Studio 375 top bar')

    await page.click('.st-tab:has-text("Trim")')
    check('Trim opens its panel over the tool strip', await page.isVisible('.st-panel[aria-label="Trim"]'))
    check('trim starts on the whole clip', (await page.textContent('.st-kv')).includes('0.0s → 20.0s'))
    await at(page, 5)
    await page.click('.st-panel button:has-text("Start here")')
    await at(page, 13)
    await page.keyboard.press('o')
    check('Start here + O key set the trim (5 → 13)', (await page.textContent('.st-kv')).includes('5.0s → 13.0s'), await page.textContent('.st-kv'))
    await shot(page, 'studio-375-trim')
    await page.click('.st-tab:has-text("Trim")')
    check('tapping the active tool closes its panel', (await page.locator('.st-panel').count()) === 0)

    await page.click('.st-top button[aria-label="Close the Studio"]')
    await page.waitForSelector('.dialog-confirm')
    check('closing with edits asks first', (await page.textContent('.dialog-confirm')).includes('Leave without saving'))
    await page.click('.dialog-confirm button:has-text("Cancel")')

    await page.click('.st-top button[aria-label="Render"]')
    await page.waitForSelector('.st-busy')
    check('render shows progress over the stage', /Queued|Rendering/.test(await page.textContent('.st-busy')))
    await page.waitForSelector('.st-view[aria-pressed="true"]:has-text("Render")', { timeout: 10_000 })
    check('render POSTs once with the trimmed window', renders.length === 1 && renders[0].window_start === 5 && renders[0].window_end === 13 && renders[0].subtitles === null, JSON.stringify(renders))
    check('when done the Render view shows the exact reel', await page.isVisible('.st-reel'))
    check('render done toast', (await page.textContent('.toasts')).includes('Rendered'))
    await shot(page, 'studio-375-rendered')

    await page.click('.st-top button[aria-label="Save and approve"]')
    await page.waitForSelector('.dialog-confirm')
    check('save asks first (Muse posts exactly these settings)', overrides.length === 0 && (await page.textContent('.dialog-confirm')).includes('exactly these settings'))
    await page.click('.dialog-confirm .btn-primary')
    await page.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('Saved & approved'))
    check('save POSTs the edit once', overrides.length === 1 && overrides[0].window_start === 5 && overrides[0].label === 'Goopy' && overrides[0].caption === 'Clutch save', JSON.stringify(overrides))
    check('once approved, Force post appears', await page.isVisible('.st-top .st-force'))

    await page.click('.st-top .st-veto')
    await page.waitForSelector('.dialog-confirm')
    check('veto asks first (fire, fail and daily highlights)', vetoes.length === 0 && (await page.textContent('.dialog-confirm')).includes('fire, fail or daily'))
    await page.click('.dialog-confirm .btn-primary')
    await page.waitForSelector('.st-veto[data-on]')
    check('veto POSTs once', vetoes.length === 1)
    await page.click('.st-top button[aria-label="Close the Studio"]')
    await page.waitForURL(/\/app\/clips$/)
    check('saved: ✕ closes straight back to Clips', new URL(page.url()).pathname === '/app/clips')
    check('no unmocked writes and no page errors (Studio phone)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Desktop: side card, zoom aim, force post; a 409 on save is explained.
    const overrides = [], forces = []
    const saved = { window_start: 2, window_end: 10, crop_mode: 'manual', crop_box: { x: 0.2, y: 0, w: 0.3164, h: 1 }, label: 'Goopy', caption: 'x', zooms: [], subtitles: null }
    const { ctx, page } = await newPage({
      width: 1440, height: 900,
      mocks: {
        ...CLIP_READS,
        'GET /api/admin/check': json(200, { admin: false }),
        'GET /api/reels/clips/r0': json(200, {
          clip: { clip_id: 'r0', sender: 'Goopy', game: 'Rocket League', duration: 20 }, analysis: null, override: saved, vetoed: false,
          pipeline: { state: 'posted', ig_url: 'https://www.instagram.com/reel/abc/' }, latest_render: null,
        }),
        'GET /api/reels/clips/r0/source': serveRange(STUDIO_VIDEO, 'video/webm'),
        'GET /api/reels/clips/r0/frame': (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: STUDIO_FRAME }),
        'POST /api/reels/clips/r0/override': (r) => {
          overrides.push(r.request().postDataJSON())
          return overrides.length === 1 ? json(409, { detail: 'twin' })(r) : json(200, { ok: true })(r)
        },
        'POST /api/reels/clips/r0/force-post': (r) => { forces.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      },
    })
    await ready(page, '/app/clips/r0/edit')
    await page.waitForSelector('.studio .st-side')
    await srcReady(page)
    const sw = await page.$eval('.st-side', (e) => e.getBoundingClientRect().width)
    check('desktop: 400px side card', Math.round(sw) === 400, `${sw}`)
    check('desktop: Trim is open by default', await page.isVisible('.st-panel[aria-label="Trim"]'))
    check('saved edit loads its trim', (await page.textContent('.st-kv')).includes('2.0s → 10.0s'))
    check('no analysis: says so', (await page.textContent('.st-panel')).includes('No AI analysis'))
    check('posted: Save says it won’t repost', (await page.textContent('.st-actions')).includes('won’t repost'))
    check('Instagram link is shown for a posted clip', (await page.getAttribute('.st-pipe a', 'href')) === 'https://www.instagram.com/reel/abc/')
    await page.click('.st-tab:has-text("Crop")')
    check('saved manual crop reopens in Manual', (await page.getAttribute('.st-seg [aria-checked="true"]', 'role')) === 'radio' && (await page.textContent('.st-seg [aria-checked="true"]')) === 'Manual')
    await page.click('.st-view:has-text("Frame")')
    await page.waitForSelector('.st-cbox[data-manual]')
    await shot(page, 'studio-1440-frame')
    await page.click('.st-view:has-text("Live")')

    await page.click('.st-tab:has-text("Zoom")')
    await at(page, 4)
    await page.click('.st-panel button:has-text("Add zoom here")')
    const box = await page.$eval('.st-canvas', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
    await page.mouse.click(box.x + box.w * 0.25, box.y + box.h * 0.75)
    await page.waitForFunction(() => document.querySelector('.st-panel')?.textContent?.includes('25% across'))
    check('tap the preview aims the zoom (25% across, 75% down)', (await page.textContent('.st-panel')).includes('75% down'))
    check('the zoom shows as a block on the timeline', (await page.locator('.st-blk[data-kind="z"]').count()) === 1)
    await shot(page, 'studio-1440-zoom')
    await axe(page, 'Studio 1440', '.studio')

    await page.click('.st-actions .btn-primary')
    await page.waitForSelector('.dialog-confirm')
    check('posted: save confirm says it won’t repost', (await page.textContent('.dialog-confirm')).includes('won’t repost'))
    await page.click('.dialog-confirm .btn-primary')
    await page.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('same post'))
    check('409 on save is explained in words', overrides.length === 1)
    check('the zoom rides in the save body', overrides[0].zooms.length === 1 && Math.abs(overrides[0].zooms[0].x - 0.25) < 0.01 && Math.abs(overrides[0].zooms[0].y - 0.75) < 0.01 && overrides[0].crop_mode === 'manual', JSON.stringify(overrides[0]))

    await page.click('.st-actions .st-force')
    check('Force post with unsaved edits is refused', forces.length === 0 && (await page.textContent('.toasts')).includes('Save your edits first'))
    await page.click('.st-actions .btn-primary')
    await page.click('.dialog-confirm .btn-primary')
    await page.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('won’t repost'))
    await page.click('.st-actions .st-force')
    await page.waitForSelector('.dialog-confirm')
    await page.click('.dialog-confirm .btn-primary')
    await page.waitForSelector('.st-actions .st-force[data-on]')
    check('force post sends {force:true} once', forces.length === 1 && forces[0].force === true, JSON.stringify(forces))
    await shot(page, 'studio-1440')
    check('no unmocked writes and no page errors (Studio desktop)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // A twin can't be saved; a missing clip explains itself.
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...CLIP_READS,
        'GET /api/admin/check': json(200, { admin: false }),
        'GET /api/reels/clips/r0': json(200, { clip: { clip_id: 'r0', sender: 'Goopy', duration: 20 }, analysis: null, override: null, pipeline: { state: 'twin_of_posted' } }),
        'GET /api/reels/clips/r0/source': serveRange(STUDIO_VIDEO, 'video/webm'),
        'GET /api/reels/clips/r0/frame': (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: STUDIO_FRAME }),
        'GET /api/reels/clips/nope': json(404, { detail: 'not found' }),
      },
    })
    await ready(page, '/app/clips/r0/edit')
    await page.waitForSelector('.st-top')
    check('twin: Save is marked unavailable', (await page.getAttribute('.st-top button[aria-label="Save and approve"]', 'aria-disabled')) === 'true')
    await page.click('.st-top button[aria-label="Save and approve"]', { force: true })
    await page.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('same post'))
    check('twin: save is refused without a request', (await page.locator('.dialog-confirm').count()) === 0 && !page.writes.some((w) => w.includes('override')))
    await page.goto(`${BASE}/app/clips/nope/edit`)
    await page.waitForSelector('.st-loading[role=alert]')
    check('404 says not found or not yours', (await page.textContent('.st-loading')).includes("isn't one of yours"))
    check('no unmocked writes and no page errors (Studio edge cases)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 8. Slap (PS-3): Listen, the mini-player and sheet, Together, Stats ──
  {
    const favs = [], plays = []
    const { ctx, page } = await newPage({
      width: 375, height: 800, mocks: SLAP_BASE,
      match: (key, url) => (key.startsWith('POST /api/slap/favorites/') ? (r) => { favs.push(url.pathname.split('/').pop()); return json(200, { fav: true })(r) } : null) || slapMatch({
        'POST /api/slap/listen/play': (r) => { plays.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
        'POST /api/slap/listen/skip': (r) => { plays.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      })(key),
    })
    await ready(page, '/app/slap')
    await page.waitForSelector('.track-row')
    check('Slap header names the music account', (await page.textContent('.slap-sub')).includes('Listening as moiz'))
    check('three segmented tabs (Listen / Together / Stats)', (await page.locator('.seg-3 [role=tab]').count()) === 3)
    const segCols = await page.$eval('.seg-3', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
    check('.seg-3 lays out three columns', segCols === 3, `${segCols}`)
    check('no mini-player before anything plays', (await page.locator('.miniplayer-bar').count()) === 0)
    await shot(page, 'slap-375')
    await axe(page, 'Slap Listen 375', '.app-main')
    await tapTargets(page, 'Slap Listen 375')

    await page.fill('.search-field input', 'Track 1')
    await page.waitForFunction(() => [...document.querySelectorAll('.track-row .track-title')].every((e) => e.textContent.includes('Track 1')))
    check('search filters the track list', (await page.locator('.track-row').count()) >= 1)
    await page.fill('.search-field input', '')

    await page.click('.track-row .track-main >> nth=0')
    await page.waitForSelector('.miniplayer-bar')
    check('playing a track shows the mini-player bar', (await page.textContent('.miniplayer-title')).startsWith('Track'))
    check('html[data-player] is set while something plays', await page.evaluate(() => 'player' in document.documentElement.dataset))
    const geo = await page.evaluate(() => {
      const b = document.querySelector('.miniplayer-bar').getBoundingClientRect()
      const t = document.querySelector('.tabbar')?.getBoundingClientRect()
      return { bar: [b.top, b.bottom, b.height], tab: t ? [t.top] : null }
    })
    check('mini-player sits directly above the tab bar', geo.tab && Math.abs(geo.bar[1] - geo.tab[0]) <= 1.5, JSON.stringify(geo))
    await shot(page, 'slap-375-miniplayer')
    await tapTargets(page, 'Slap mini-player 375')

    await page.click('.miniplayer-open')
    await page.waitForSelector('.sheet-player .player-controls')
    check('mini-player opens the player sheet', (await page.textContent('.sheet-player .player-title')).startsWith('Track'))
    await page.click('.sheet-player button[aria-label="Add to favourites"]')
    await page.waitForFunction(() => document.querySelector('.sheet-player button[aria-label="Remove from favourites"]'), null, { timeout: 5000 }).catch(() => {})
    const title = await page.textContent('.sheet-player .player-title')
    check('favourite POSTs once for the current track', favs.length === 1 && `Track ${favs[0].slice(1)}` === title, `${JSON.stringify(favs)} ${title} ${page.violations}`)
    await shot(page, 'slap-375-sheet')
    await axe(page, 'Slap player sheet 375', '.sheet-player')
    await page.click('.sheet-player button[aria-label="Close player"]')
    await page.waitForSelector('.sheet-player', { state: 'detached' })

    await page.click('.seg-tab:has-text("Together")')
    await page.waitForSelector('.together-who')
    check('Together peek shows who is in the room', (await page.textContent('.together-who')).includes('2 listening'))
    check('no unmocked writes and no page errors (Slap Listen)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const ops = []
    const { ctx, page } = await newPage({
      width: 375, height: 800, mocks: SLAP_BASE,
      match: slapMatch({
        'GET /api/slap/together/events': sse(SLAP_ROOM),
        'POST /api/slap/together': (r) => {
          const b = r.request().postDataJSON(); ops.push(b)
          return json(200, { ...SLAP_ROOM, version: SLAP_ROOM.version + ops.length, queue: [...SLAP_ROOM.queue, qi(SLAP_TRACKS[0], 9, 'moiz')] })(r)
        },
        'POST /api/slap/listen/play': json(200, { ok: true }),
        'POST /api/slap/listen/skip': json(200, { ok: true }),
      }),
    })
    await ready(page, '/app/slap?tab=together')
    await page.waitForSelector('.together-actions .btn-primary')
    check('peek offers "Join them" when people are in', (await page.textContent('.together-actions .btn-primary')).includes('Join them'))
    await shot(page, 'slap-375-together-peek')
    await page.click('.together-actions .btn-primary')
    await page.waitForSelector('.together-now-big')
    check('joined: the room\'s track is shown', (await page.textContent('.together-now-big')).includes('Track 3'))
    check('joined: the shared queue is listed', (await page.locator('.together-queue .queue-row').count()) === 2)
    check('joined: the tab shows the member count', (await page.textContent('.seg-tab[data-state=active]')).includes('2'))
    check('joined: the mini-player shows Together', (await page.textContent('.miniplayer-bar')).includes('Together'))
    await shot(page, 'slap-375-together')
    await axe(page, 'Slap Together 375', '.app-main')
    await page.click('.together-actions button:has-text("Add from the library")')
    await page.waitForSelector('.track-row')
    await page.click('.track-row .track-main >> nth=0')
    await page.waitForFunction(() => document.querySelectorAll('.miniplayer-bar').length === 1)
    await page.waitForTimeout(300)
    check('in the room, tapping a track adds it to the shared queue', ops.length === 1 && ops[0].op === 'add', JSON.stringify(ops))
    await page.click('.seg-tab:has-text("Together")')
    await page.click('.together-banner button:has-text("Leave")')
    await page.waitForSelector('.together-intro')
    check('Leave returns to the room peek', await page.isVisible('.together-actions .btn-primary'))
    check('no unmocked writes and no page errors (Together)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({
      width: 1440, height: 900, mocks: SLAP_BASE,
      match: slapMatch({ 'GET /api/slap/social/dashboard/streaks': json(502, { detail: 'slap down' }) }),
    })
    await ready(page, '/app/slap?tab=stats')
    await page.waitForFunction(() => document.querySelector('.kpis dd')?.textContent?.includes('1,234'))
    check('Stats: library totals render', true)
    check('Stats: leaderboard renders', (await page.textContent('.slap-stats')).includes('Leaderboard'))
    await page.waitForSelector('.stat-err', { timeout: 15_000 })
    check('Stats: one failed panel shows Retry, the rest carry on', (await page.locator('.stat-err').count()) === 1 && (await page.textContent('.stat-err')).includes('Retry'))
    for (const id of ['compare', 'charts', 'listening', 'feed']) {
      await page.evaluate((id) => document.getElementById(`stats-${id}`)?.scrollIntoView(), id)
      await page.waitForTimeout(250)
    }
    await page.waitForFunction(() => document.querySelector('.digest')?.textContent?.includes('Drake spike'), null, { timeout: 10_000 })
    check('Stats: lazy AI panels load when scrolled to', true)
    check('Stats: heatmap draws 7 rows × 24 hours', (await page.locator('.heat-row:not(.heat-hours) i').count()) === 7 * 24)
    check('desktop: no sidebar mini-player when nothing plays', (await page.locator('.miniplayer-sidebar').count()) === 0)
    await page.evaluate(() => scrollTo(0, 0))
    await shot(page, 'slap-1440-stats', true)
    await axe(page, 'Slap Stats 1440', '.slap-stats')
    check('no unmocked writes and no page errors (Stats)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 9. Settings (PS-10): sub-routed tabs, passkeys, password, PSN, Mattermost, MCP ──
  {
    const deleted = [], completes = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...ACCT_BASE,
        'DELETE /auth/settings/passkeys/pk2': (r) => { deleted.push('pk2'); return json(200, { ok: true })(r) },
        'POST /auth/passkey/register/begin': json(200, { passkeyId: 'reg-1', options: { challenge: 'AQID', rp: { id: 'localhost', name: 'CRCMZ' }, user: { id: 'dXNlcg', name: 'goopy', displayName: 'Goopy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ type: 'public-key', id: 'BAUG' }] } }),
        'POST /auth/passkey/register/complete': (r) => { completes.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
        'POST /auth/settings/password': json(400, { error: 'Current password is incorrect.' }),
      },
    })
    await ctx.addInitScript(FAKE_WEBAUTHN)
    await ready(page, '/app/settings')
    await page.waitForSelector('.acct-row')
    check('/app/settings opens the passkeys tab', new URL(page.url()).pathname === '/app/settings/passkeys', page.url())
    check('settings tabs are a tablist of 5', (await page.locator('.tabstrip[role=tablist] [role=tab]').count()) === 5)
    check('passkeys are listed', (await page.locator('.acct-row').count()) === 2)
    await shot(page, 'settings-375-passkeys')
    await axe(page, 'Settings passkeys 375', '.app-main')
    await tapTargets(page, 'Settings passkeys 375')

    await page.click('button[aria-label="Remove MacIntel passkey"]')
    await page.waitForSelector('[role=alertdialog]')
    check('removing a passkey asks first, naming it', (await page.textContent('[role=alertdialog]')).includes('MacIntel passkey') && deleted.length === 0)
    await page.click('[role=alertdialog] button:has-text("Remove passkey")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Removed')))
    check('confirmed remove sends one DELETE', deleted.length === 1)

    await page.click('.settings-card-head button:has-text("Add a passkey")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Passkey added')))
    const args = await page.evaluate(() => window.__createArgs)
    const c = completes[0]
    check('passkey options are decoded from base64url', JSON.stringify(args.challenge) === '[1,2,3]' && JSON.stringify(args.user) === JSON.stringify([...Buffer.from('user')]) && args.exclude[0] === true, JSON.stringify(args))
    check('passkey credential is sent base64url, like the classic app', c && c.passkeyId === 'reg-1' && c.credential.rawId === 'cmF3Pz4' && c.credential.response.clientDataJSON === 'eyJjIjoxfQ' && c.credential.response.attestationObject === 'YXR0fn4' && /passkey$/.test(c.passkeyName), JSON.stringify(c))
    await page.evaluate(() => { window.__cancelPasskey = true })
    await page.click('.settings-card-head button:has-text("Add a passkey")')
    await page.waitForTimeout(400)
    check('cancelling the passkey prompt is not an error', completes.length === 1 && !(await page.locator('.toast[data-tone=error]').count()))

    await page.click('.tabstrip-tab[data-state=active]')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    const focused = await page.evaluate(() => document.activeElement?.textContent ?? '')
    check('arrow keys move between tabs', focused === 'Password', focused)
    await page.keyboard.press('Enter')
    await page.waitForSelector('#pw-cur')
    check('tabs are sub-routes', new URL(page.url()).pathname === '/app/settings/security')
    await page.fill('#pw-new', 'short')
    await page.locator('#pw-new').blur()
    check('new password is checked on blur (≥ 8)', (await page.textContent('#pw-new-hint')) === 'At least 8 characters' && (await page.getAttribute('#pw-new', 'aria-invalid')) === 'true')
    await page.fill('#pw-cur', 'wrong-one')
    await page.fill('#pw-new', 'long-enough-1')
    await page.fill('#pw-conf', 'long-enough-1')
    await page.click('button:has-text("Change password")')
    await page.waitForSelector('#pw-cur-err')
    check('a wrong current password is flagged on that field', (await page.textContent('#pw-cur-err')).includes('incorrect') && (await page.getAttribute('#pw-cur', 'aria-describedby')) === 'pw-cur-err')
    check('new password is kept after a wrong current one', (await page.inputValue('#pw-new')) === 'long-enough-1')
    await shot(page, 'settings-375-security')
    await axe(page, 'Settings security 375', '.app-main')

    await page.click('.tabstrip-tab:has-text("PSN")')
    await page.waitForSelector('.acct-status .badge')
    check('PSN tab says "Expiring in 3 days"', (await page.textContent('.acct-status .badge')) === 'Expiring in 3 days', await page.textContent('.acct-status .badge'))
    check('PSN tab re-links in Link PSN', (await page.getAttribute('.settings-card a:has-text("Re-link")', 'href')) === '/app/portal')
    await shot(page, 'settings-375-psn')
    await axe(page, 'Settings PSN 375', '.app-main')

    await page.click('.tabstrip-tab:has-text("Mattermost")')
    await page.click('button:has-text("Connect Mattermost")')
    await page.waitForSelector('.field-err a')
    check('blocked Mattermost pop-up offers the connect page', (await page.getAttribute('.field-err a', 'href')) === '/auth/settings/mattermost/connect')
    await axe(page, 'Settings Mattermost 375', '.app-main')

    await page.click('.tabstrip-tab:has-text("MCP")')
    await page.waitForSelector('.code-block pre')
    check('MCP not connected shows the config block', (await page.textContent('.code-block pre')).includes('https://app.crcmz.me/mcp'))
    await shot(page, 'settings-375-mcp', true)
    await axe(page, 'Settings MCP 375', '.app-main')
    await tapTargets(page, 'Settings MCP 375')
    await page.goto(BASE + '/app/settings')
    await page.waitForSelector('.code-block pre')
    check('/app/settings returns to the last tab', new URL(page.url()).pathname === '/app/settings/mcp')
    check('no unmocked writes and no page errors (Settings)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 10. Link PSN (PS-12): claim, the stepper, a failed then good link ──
  {
    const links = [], claims = []
    let linkOk = false
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...ACCT_BASE,
        'GET /auth/settings/psn': json(200, { linked: false, unclaimed: [{ key: 'bizzle', online_id: 'Bizzle', mm_username: 'bizzle', linked_at: NOW - 90 * 86400 }] }),
        'POST /auth/settings/psn/claim': (r) => { claims.push(r.request().postDataJSON()); return json(404, { error: 'record not found or already claimed' })(r) },
        'POST /api/psn/link': (r) => { links.push(r.request().postDataJSON()); return linkOk ? json(200, { ok: true, online_id: 'Goopy' })(r) : json(400, { error: "That token didn't work. It may have expired." })(r) },
      },
    })
    await ready(page, '/app/portal')
    await page.waitForSelector('.step[data-state=open]')
    check('portal: status card says not linked', (await page.textContent('.acct-status')).includes('Not linked'))
    check('portal: step 0 shows when unclaimed accounts exist', (await page.locator('.step').count()) === 4)
    check('portal: later steps are visible but locked', (await page.locator('.step[data-state=locked]').count()) === 2)
    await shot(page, 'portal-375', true)
    await axe(page, 'Link PSN 375', '.app-main')
    await tapTargets(page, 'Link PSN 375')
    await page.click('button:has-text("This is mine")')
    await page.click('[role=alertdialog] button:has-text("Yes, it\'s mine")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('already claimed')))
    check('claim 404 says someone already claimed it', claims.length === 1 && claims[0].key === 'bizzle')
    const ext = await page.$$eval('.step a[target=_blank]', (as) => as.map((a) => a.href))
    check('step 1 opens playstation.com in a new tab', ext.includes('https://www.playstation.com/'), ext.join(' '))
    await page.click('button:has-text("I\'m already signed in")')
    check('step 2 links the Sony token page', (await page.getAttribute('.step[data-state=open] a[target=_blank]', 'href')) === 'https://ca.account.sony.com/api/v1/ssocookie')
    await page.click('button:has-text("I\'ve copied it")')
    await page.fill('#po-token', '{"npsso":"abc123"}')
    check('the token is masked once entered', (await page.getAttribute('#po-token', 'data-masked')) === 'true')
    await page.click('button:has-text("Link my account")')
    await page.waitForSelector('.po-err')
    check('a failed link shows the server message + Try a fresh token', (await page.textContent('.po-err')).includes("didn't work") && (await page.isVisible('.po-err button:has-text("Try a fresh token")')))
    check('the pasted token is kept after a failure', (await page.inputValue('#po-token')) === '{"npsso":"abc123"}')
    await shot(page, 'portal-375-error')
    await axe(page, 'Link PSN error 375', '.app-main')
    check('the token is never stored locally', await page.evaluate(() => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes('abc123')))
    linkOk = true
    await page.click('button:has-text("Link my account")')
    await page.waitForSelector('.portal-done')
    check('a good link replaces the stepper with See the Squad', (await page.textContent('.portal-done')).includes('Linked as Goopy') && (await page.getAttribute('.portal-done a', 'href')) === '/app')
    check('link posts the token once per try', links.length === 2 && links[1].npsso === '{"npsso":"abc123"}')
    await shot(page, 'portal-375-done')
    check('no unmocked writes and no page errors (Link PSN)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 11. Admin (PS-11): health, ops, queue, PSN accounts, users + reset ──
  {
    const resets = []
    const { ctx, page } = await newPage({
      width: 1440, height: 900,
      mocks: {
        ...ACCT_BASE, ...ADMIN_READS,
        'GET /api/admin/check': json(200, { admin: true }),
        'POST /api/admin/users/u2/reset-password': (r) => { resets.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      },
    })
    await ready(page, '/app/admin')
    await page.waitForSelector('.svc-row')
    await page.waitForSelector('.admin-lists .acct-row')
    check('admin: a down service is data (red dot + Unreachable)', (await page.textContent('.svc-row[data-status=down]')).includes('Unreachable'))
    check('admin: queue depth 0 reads "Queue is clear"', (await page.textContent('.admin-queue')) === 'Queue is clear')
    const order = await page.$$eval('section[aria-labelledby=ad-p] .acct-row-title', (els) => els.map((e) => e.textContent))
    check('admin: PSN accounts list expired, then expiring, first', order.join(',') === 'Bizzle,NoorAmin,Goopy', order.join(','))
    check('admin: unclaimed accounts say so', (await page.textContent('section[aria-labelledby=ad-p]')).includes('unclaimed'))
    await shot(page, 'admin-1440', true)
    await axe(page, 'Admin 1440', '.app-main')
    await tapTargets(page, 'Admin 1440')
    await page.click('button[aria-label="Reset password for Bizzle"]')
    await page.waitForSelector('.dialog #rp-new')
    check('reset dialog names the user', (await page.textContent('.dialog-title')).includes('Bizzle'))
    await page.fill('#rp-new', 'short')
    await page.fill('#rp-conf', 'short')
    await page.click('.dialog button[type=submit]')
    check('reset under 8 characters is blocked client-side', resets.length === 0 && (await page.getAttribute('#rp-new', 'aria-invalid')) === 'true')
    await page.fill('#rp-new', 'brand-new-pass')
    await page.fill('#rp-conf', 'brand-new-pass')
    await page.click('.dialog button[type=submit]')
    await page.waitForSelector('.dialog', { state: 'detached' })
    check('reset posts once with the new password', resets.length === 1 && resets[0].newPassword === 'brand-new-pass')
    check('no unmocked writes and no page errors (Admin)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { ...ADMIN_READS, 'GET /api/admin/check': json(200, { admin: true }), 'GET /api/admin/users': json(403, { detail: 'admins only' }) } })
    await ready(page, '/app/admin')
    await page.waitForSelector('.handoff-lede')
    check('admin: a 403 from users turns into "Admins only"', (await page.textContent('.handoff-lede')) === 'Admins only')
    await page.goto(BASE + '/app/admin')
    await ctx.close()
  }
  // ── 12. Giveaway (PS-5): member view by state. Rendering never mutates. ──
  {
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { 'GET /api/giveaway': json(200, gwData()), 'GET /api/giveaway/history': json(200, GW_HISTORY) } })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-count')
    check('giveaway: open hero shows title, prize, Reveal in', (await page.textContent('.gw-hero')).includes('October drop') && (await page.textContent('.gw-hero')).includes('$50 PSN card') && (await page.textContent('.gw-lead')) === 'Reveal in')
    const label = await page.getAttribute('.gw-count', 'aria-label')
    check('giveaway: countdown is a silent timer with a spoken label', (await page.getAttribute('.gw-count', 'aria-live')) === 'off' && /^Reveal in 2 days, \d+ hours and \d+ minutes$/.test(label), label)
    check('giveaway: countdown has D / H / M / S cells', (await page.locator('.gw-count-cell').count()) === 4)
    check('giveaway: eligibility is said in words', (await page.textContent('.gw-elig-btn')).includes("You're in this draw"))
    await page.click('.gw-elig-btn')
    check('giveaway: tapping eligibility explains the rotation rule', (await page.isVisible('#gw-why')) && (await page.textContent('#gw-why')) === 'Everyone wins once before anyone wins twice.')
    check('giveaway: rotation progress line', (await page.textContent('.gw-rot-line')).replace(/\s+/g, ' ') === 'Cycle 2 · 4 of 6 still eligible')
    check('giveaway: past winners start collapsed on a phone', !(await page.isVisible('#gw-past-list')))
    await page.click('button:has-text("Show past winners")')
    check('giveaway: past winners expand', (await page.locator('#gw-past-list .acct-row').count()) === 2 && (await page.textContent('#gw-past-list')).includes('Moiz'))
    check('giveaway: members get no admin tools', (await page.locator('.gw-admin').count()) === 0)
    await shot(page, 'giveaway-375', true)
    await axe(page, 'Giveaway 375', '.app-main')
    await tapTargets(page, 'Giveaway 375')
    check('no unmocked writes and no page errors (Giveaway member)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    let gets = 0
    const posts = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: { 'GET /api/giveaway': (r) => { gets++; return json(200, gwData({ status: 'drawn', revealIn: -60e3, draw: null }))(r) }, 'GET /api/giveaway/history': json(200, []) },
      match: (key) => (key.startsWith('POST /api/giveaway') ? (r) => { posts.push(key); return json(200, {})(r) } : null),
    })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-due')
    check('giveaway: overdue reveal says "The reveal is on its way."', (await page.textContent('.gw-due')) === 'The reveal is on its way.')
    check('giveaway: drawn never shows a winner to members', !(await page.textContent('.gw-hero')).includes('Bizzle') && !(await page.locator('.gw-count').count()))
    const before = gets
    await page.waitForTimeout(6000)
    check('giveaway: overdue re-fetches on a backoff (5 s first)', gets > before, `${before} → ${gets}`)
    check('giveaway: overdue page never POSTs', posts.length === 0, posts.join(', '))
    check('giveaway: empty history hides Past winners', (await page.locator('#gw-past').count()) === 0)
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { 'GET /api/giveaway': json(200, gwData({ status: 'draft' })), 'GET /api/giveaway/history': json(200, GW_HISTORY) } })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-title')
    check('giveaway: members never see a draft', (await page.textContent('.gw-title')) === 'No giveaway running right now.' && !(await page.textContent('.app-main')).includes('October drop'))
    await ctx.close()
  }
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const { ctx, page } = await newPage({
      width: 375, height: 800, reducedMotion,
      mocks: {
        'GET /api/giveaway': json(200, gwData({ status: 'revealed', revealIn: -3600e3, draw: { ...GW_DRAW, winner_id: 'z1', winner_name: 'Goopy' }, wonCycle: true })),
        'GET /api/giveaway/history': json(200, GW_HISTORY),
        'GET /auth/settings/psn': json(200, { linked: true, online_id: 'Goopy', token_ok: true, refresh_expires_at: NOW + 40 * 86400 }),
      },
    })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-winner')
    await page.waitForFunction(() => document.querySelector('.gw-elig-btn')?.textContent?.includes('You won'))
    const confetti = await page.locator('.gw-confetti').count()
    if (reducedMotion === 'reduce') {
      check('giveaway: no confetti with reduced motion', confetti === 0)
    } else {
      check('giveaway: revealed hero shows 🏆 winner + 🎁 prize', (await page.textContent('.gw-winner')).includes('Goopy') && (await page.textContent('.gw-hero')).includes('$50 PSN card'))
      check('giveaway: the winner sees "You won! 🏆"', (await page.textContent('.gw-elig-btn')).includes('You won! 🏆'))
      check('giveaway: confetti once per giveaway', confetti === 1 && (await page.evaluate(() => localStorage.getItem('celebrated_gw_7'))) === 'true')
      await shot(page, 'giveaway-375-revealed')
      await page.reload()
      await page.waitForSelector('.gw-winner')
      check('giveaway: no confetti the second time', (await page.locator('.gw-confetti').count()) === 0)
    }
    await ctx.close()
  }
  // ── 13. Giveaway admin desk (1440): lifecycle, draw, entries, edit, danger zone ──
  {
    const calls = []
    const rec = (key, res) => (r) => { calls.push({ key, body: r.request().postData() ? r.request().postDataJSON() : null }); return res(r) }
    let seedTries = 0
    const { ctx, page } = await newPage({
      width: 1440, height: 900,
      mocks: {
        'GET /api/admin/check': json(200, { admin: true }),
        'GET /api/giveaway': json(200, gwData({ admin: true })),
        'GET /api/giveaway/history': json(200, GW_HISTORY),
        'POST /api/giveaway/7/draw-and-reveal': rec('draw', json(200, { status: 'revealed' })),
        'DELETE /api/giveaway/7/entries/z4': rec('rm', json(200, { status: 'removed' })),
        'POST /api/giveaway/7/entries': rec('add', json(200, { status: 'added' })),
        'PUT /api/giveaway/7': rec('put', json(200, { id: 7 })),
        'POST /api/giveaway/admin/reset-and-seed': (r) => { seedTries++; calls.push({ key: 'seed', body: r.request().postDataJSON() }); return seedTries === 1 ? json(409, { error: 'ambiguous', matches: [GW_MEMBERS[0], GW_MEMBERS[5]] })(r) : json(200, { status: 'ok', seeded_winner: GW_MEMBERS[5] })(r) },
      },
    })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-strip')
    check('admin desk: open by default on desktop', await page.isVisible('#gw-admin-body'))
    check('admin desk: lifecycle marks Open as the current step', (await page.textContent('.gw-strip [aria-current=step]')).startsWith('Open') && (await page.locator('.gw-strip [data-past]').count()) === 2)
    check('admin desk: state line in text', (await page.textContent('.gw-state-line')).replace(/\s+/g, ' ').startsWith('Open · 4 entries · reveal'))
    check('admin desk: entries header counts entered + eligible', (await page.textContent('#gw-en ~ *, section[aria-labelledby=gw-en] .settings-card-head')).includes('4 entered · 4 eligible'))
    await shot(page, 'giveaway-1440-admin', true)
    await axe(page, 'Giveaway admin 1440', '.app-main')
    await tapTargets(page, 'Giveaway admin 1440')

    await page.click('button:has-text("Draw & reveal now")')
    await page.waitForSelector('[role=alertdialog]')
    check('draw & reveal asks first, saying it cannot be undone', (await page.textContent('[role=alertdialog]')).includes('cannot be undone') && !calls.some((c) => c.key === 'draw'))
    await page.click('[role=alertdialog] button:has-text("Draw & reveal now")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Winner revealed')))
    check('confirmed draw posts once', calls.filter((c) => c.key === 'draw').length === 1)

    await page.click('button[aria-label="Remove Shah"]')
    await page.waitForSelector('[role=alertdialog]')
    check('remove entry confirm names the member', (await page.textContent('[role=alertdialog]')).includes('Remove Shah from this draw?'))
    await page.click('[role=alertdialog] button:has-text("Remove")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Removed Shah')))

    await page.click('button:has-text("＋ Add entry")')
    await page.fill('#ae-q', 'goo')
    check('add entry lists only rotation members not entered, filtered', (await page.locator('.gw-pick .acct-row').count()) === 1 && (await page.textContent('.gw-pick')).includes('Goofy'))
    await page.click('button[aria-label="Add Goofy"]')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Added Goofy')))
    const add = calls.find((c) => c.key === 'add')
    check('add entry posts member_id + display_name', add?.body?.member_id === 'z6' && add?.body?.display_name === 'Goofy', JSON.stringify(add))
    await page.keyboard.press('Escape')

    await page.fill('#gw-f-title', '')
    await page.locator('#gw-f-title').blur()
    check('edit validates the title on blur', (await page.textContent('#gw-f-title-err')) === 'Give it a title')
    await page.fill('#gw-f-title', 'October drop!')
    await page.fill('#gw-f-when', '2026-10-31T20:00')
    await page.click('button:has-text("Save")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent === 'Saved'))
    const put = calls.find((c) => c.key === 'put')
    check('edit PUTs title, prize, local reveal time', put?.body?.title === 'October drop!' && put?.body?.reveal_at === '2026-10-31T20:00' && put?.body?.prize === '$50 PSN card', JSON.stringify(put))

    await page.fill('#dz-name', 'goo')
    await page.click('.gw-danger button:has-text("Reset & seed")')
    await page.waitForSelector('[role=alertdialog]')
    check('reset & seed asks first, naming what is wiped', (await page.textContent('[role=alertdialog]')).includes('deletes every giveaway') && seedTries === 0)
    await page.click('[role=alertdialog] button:has-text("Reset & seed")')
    await page.waitForSelector('.gw-picklist')
    check('reset & seed 409 shows "Multiple matches. Pick one:"', (await page.textContent('.gw-picklist')).includes('Multiple matches. Pick one:') && (await page.locator('.gw-picklist button').count()) === 2)
    await page.click('.gw-picklist button:has-text("Goofy")')
    check('picking a match fills the name', (await page.inputValue('#dz-name')) === 'Goofy')
    await page.click('.gw-danger button:has-text("Reset & seed")')
    await page.click('[role=alertdialog] button:has-text("Reset & seed")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Goofy is recorded')))
    check('reset & seed posts the picked name', calls.filter((c) => c.key === 'seed').map((c) => c.body.winner_query).join(',') === 'goo,Goofy')
    check('no unmocked writes and no page errors (Giveaway admin)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const calls = []
    let role = true
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        'GET /api/admin/check': json(200, { admin: true }),
        'GET /api/giveaway': (r) => json(200, gwData({ admin: role, status: 'drawn', revealIn: 3600e3, draw: GW_DRAW }))(r),
        'GET /api/giveaway/history': json(200, GW_HISTORY),
        'POST /api/giveaway/7/redraw': (r) => { calls.push(r.request().postDataJSON()); return json(200, { status: 'ok', winner: 'NoorAmin' })(r) },
        'POST /api/giveaway/7/draw-and-reveal': (r) => { role = false; return json(403, { detail: 'admin only' })(r) },
      },
    })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-admin')
    check('admin tools start collapsed on a phone', !(await page.isVisible('#gw-admin-body')) && (await page.getAttribute('.gw-admin-toggle', 'aria-expanded')) === 'false')
    check('admins see "Winner reveal in" for a drawn giveaway, members-style', (await page.textContent('.gw-lead')) === 'Winner reveal in')
    await page.click('.gw-admin-toggle')
    check('winner preview shows draw #, hash, winner (admins only)', (await page.textContent('.gw-preview')).includes('Bizzle') && (await page.textContent('.gw-preview')).includes('9f2c1ab04e77d3c1'))
    await page.click('button:has-text("More actions")')
    await page.click('button:has-text("Disqualify & redraw")')
    await page.waitForSelector('#rd-why')
    check('redraw dialog names the current winner', (await page.textContent('#rd-desc')).includes('Bizzle'))
    await page.click('.dialog button[type=submit]')
    check('redraw needs a reason', calls.length === 0 && (await page.isVisible('#rd-err')))
    await page.fill('#rd-why', 'Alt account')
    await page.click('.dialog button[type=submit]')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('New winner: NoorAmin')))
    check('redraw posts the reason', calls.length === 1 && calls[0].reason === 'Alt account')
    await shot(page, 'giveaway-375-admin', true)
    await axe(page, 'Giveaway admin 375', '.app-main')
    await page.click('button:has-text("Reveal now")')
    await page.click('[role=alertdialog] button:has-text("Reveal now")')
    await page.waitForSelector('#gw-admin-body .field-err[role=alert]', { state: 'attached', timeout: 5000 }).catch(() => {})
    await page.waitForFunction(() => !document.querySelector('.gw-admin'), null, { timeout: 8000 }).catch(() => {})
    check('a 403 on an admin action re-fetches and the tools hide', (await page.locator('.gw-admin').count()) === 0)
    check('no unmocked writes and no page errors (Giveaway admin 375)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const calls = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        'GET /api/admin/check': json(200, { admin: true }),
        'GET /api/giveaway': json(200, gwData({ admin: true, none: true })),
        'GET /api/giveaway/history': json(200, GW_HISTORY),
        'POST /api/giveaway': (r) => { calls.push(r.request().postDataJSON()); return json(200, { id: 9, status: 'draft' })(r) },
        'POST /api/giveaway/9/publish': json(400, { detail: 'no members found in portal' }),
      },
    })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-admin')
    check('no giveaway: hero says so', (await page.textContent('.gw-title')) === 'No giveaway running right now.')
    await page.click('.gw-admin-toggle')
    await page.click('button:has-text("Start a giveaway")')
    check('Start a giveaway jumps to the title field', (await page.evaluate(() => document.activeElement?.id)) === 'gw-f-title')
    await page.fill('#gw-f-title', 'November drop')
    await page.fill('#gw-f-when', localIso(Date.now() - 86400e3))
    await page.click('button:has-text("Create & publish")')
    check('create refuses a reveal time in the past', calls.length === 0 && (await page.textContent('#gw-f-when-err')) === 'Pick a time in the future')
    await page.fill('#gw-f-when', localIso(Date.now() + 7 * 86400e3))
    await page.click('button:has-text("Create & publish")')
    await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((t) => t.textContent.includes('Saved as a draft')))
    check('create posts once; a failed publish leaves a visible draft, no retry', calls.length === 1 && calls[0].title === 'November drop' && page.writes.filter((w) => w === 'POST /api/giveaway/9/publish').length === 1)
    check('no unmocked writes and no page errors (Giveaway create)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
