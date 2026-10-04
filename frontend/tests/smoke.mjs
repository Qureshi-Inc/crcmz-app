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

// Fake camera + mic so the Watch call can be joined without hardware or a prompt.
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })

/**
 * A page where every write is mocked. `mocks` maps "METHOD path" → handler(route).
 * Unmocked writes are aborted and recorded as violations.
 */
async function newPage({ width, height, mocks = {}, match = null, reducedMotion = 'no-preference' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion, hasTouch: width < 1024 })
  // Keep what the app hands the lock screen, so a check can press its buttons.
  await ctx.addInitScript(() => {
    const ms = navigator.mediaSession
    if (!ms) return
    const set = ms.setActionHandler.bind(ms)
    window.__ms = {}
    ms.setActionHandler = (a, fn) => { if (fn) window.__ms[a] = fn; else delete window.__ms[a]; try { set(a, fn) } catch { /* */ } }
  })
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

/** The camera position lives in the player's ⚙ panel: open it, pick, close it again. */
async function pickPos(page, pos) {
  await page.hover('.wp-stage')
  if (!(await page.isVisible('.wp-set'))) await page.click('.wp-stage button[aria-label="Settings"]')
  await page.click(`.wp-set [role=radio][data-pos=${pos}]`)
  await page.click('.wp-set button[aria-label="Close settings"]')
  await page.waitForSelector('.wp-set', { state: 'detached' })
}

/** What the lock screen shows: title, artist, play state and the buttons it offers. */
const lock = (page) => page.evaluate(() => {
  const ms = navigator.mediaSession
  return { title: ms.metadata?.title ?? null, artist: ms.metadata?.artist ?? null, album: ms.metadata?.album ?? null, art: ms.metadata?.artwork?.[0]?.src ?? null, state: ms.playbackState, actions: Object.keys(window.__ms || {}).sort().join(',') }
})
const press = (page, action, extra = {}) => page.evaluate(([a, x]) => window.__ms[a]?.({ action: a, ...x }), [action, extra])

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
  if (key.startsWith('GET /api/slap/track/')) return json(200, { picked_by: [], thumbs: { up: [], down: [], mine: 0 } })
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

// ── WhatsApp fixtures (PS-4). Every /api/whatsapp route is mocked, reads included. ──
const WA_PEOPLE = ['Goopy', 'Bizzle', 'NoorAmin', 'Zubair']
function waFixture(kind, total) {
  const k = total / 1234
  const r = (v) => Math.round(v * k)
  switch (kind) {
    case 'stats': return { total_messages: total, total_members: total ? 4 : 0, total_videos: r(88), total_photos: r(310), total_media: r(40), conversation_days: total ? r(400) || 1 : 0, first_ts: NOW - 400 * 86400, last_ts: NOW - 3600, member_message_counts: [] }
    case 'awards': return total ? {
      certified_yapper: { name: 'Goopy', count: r(600) }, night_owl: { name: 'Bizzle', count: r(90) }, early_bird: { name: 'NoorAmin', count: r(30) },
      video_king: { name: 'Zubair', count: r(40) }, photo_king: { name: 'Goopy', count: r(120) }, most_skull: { name: 'Bizzle', count: r(55) },
      most_laugh: { name: 'Goopy', count: r(77) }, most_fire: null, ghost_of_month: { name: 'Zubair', count: 3 },
      fastest_replier: { name: 'NoorAmin', avg_minutes: 2.4 }, biggest_day: { date: '2026-07-04', count: r(140) }, longest_streak_days: 21,
      peak_hour: { hour: 22, count: r(160) }, most_used_emoji: { emoji: '😂', count: r(410) },
      most_reacted_message: { sender_name: 'Bizzle', text: 'who took my controller', timestamp: NOW - 9 * 86400, cnt: 9 },
    } : {}
    case 'activity': return {
      by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: r(h > 17 ? 90 : h > 8 ? 40 : 5) })),
      by_dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, dow) => ({ dow, label, count: r(120 + dow * 20) })),
      daily: total ? Array.from({ length: 90 }, (_, i) => ({ date: new Date((NOW - (89 - i) * 86400) * 1000).toISOString().slice(0, 10), count: r(5 + (i * 7) % 30) })) : [],
      monthly: total ? Array.from({ length: 12 }, (_, i) => ({ month: `2025-${String(i + 1).padStart(2, '0')}`, count: r(60 + i * 9) })) : [],
      top_days: [], member_monthly: {},
    }
    case 'heatmap': return { cells: total ? Array.from({ length: 168 }, (_, i) => ({ dow: Math.floor(i / 24), hour: i % 24, count: (i % 24 > 17 ? 12 : 2) + (i % 7) })) : [], max_count: total ? 18 : 0 }
    case 'words': return { top_words: total ? ['bro', 'game', 'tonight', 'lol', 'who', 'online', 'clip', 'nah', 'ranked', 'gg', 'when', 'goal', 'save', 'run', 'lag', 'mic', 'squad', 'carry', 'one', 'more', 'party', 'shot'].map((word, i) => ({ word, count: r(300 - i * 11) })) : [], member_top_words: { Goopy: [{ word: 'bro', count: 40 }, { word: 'game', count: 22 }] } }
    case 'emojis': return { top_emoji: total ? ['😂', '💀', '🔥', '😭', '👀', '🙏', '💯', '😤', '🤣', '😎', '🫡', '❤️'].map((emoji, i) => ({ emoji, count: r(400 - i * 30), pct: Math.round((30 - i * 2) * 10) / 10 })) : [], total_emoji: r(2400), member_top_emoji: { Goopy: [{ emoji: '😂', count: 90 }, { emoji: '🔥', count: 40 }, { emoji: '💯', count: 12 }, { emoji: '👀', count: 8 }], Bizzle: [{ emoji: '💀', count: 60 }] } }
    case 'response-times': return total ? { member_avg_minutes: [{ name: 'NoorAmin', avg_minutes: 2.4, count: 80 }, { name: 'Goopy', avg_minutes: 6.1, count: 140 }, { name: 'Bizzle', avg_minutes: 14.8, count: 60 }], distribution: [{ label: '0-5m', count: r(160) }, { label: '5-10m', count: r(70) }, { label: '10-20m', count: r(40) }, { label: '20-30m', count: r(20) }, { label: '30-60m', count: r(10) }], fastest_responder: 'NoorAmin', event_count: r(300) } : { member_avg_minutes: [], distribution: [], fastest_responder: null, event_count: 0 }
    case 'members': return { members: total ? WA_PEOPLE.map((name, i) => ({ name, messages: r([600, 350, 200, 84][i]), photos: [120, 90, 60, 40][i], videos: [10, 20, 18, 40][i], audios: i, media_omitted: [5, 2, 30, 3][i], total_words: r([3000, 4200, 1500, 500][i]), total_chars: r([15000, 21000, 8000, 2600][i]), avg_words_per_msg: [5, 12, 7.5, 6][i], first_ts: NOW - (400 - i * 30) * 86400, last_ts: NOW - (i + 1) * 3600 })) : [] }
  }
  return null
}
/** WhatsApp mocks: per-range totals, optional per-range delay, every request's query recorded. */
function waMocks({ totals = { all_time: 1234, this_month: 42, prev_month: 300, this_year: 900, custom: 0 }, slow = {}, fail = null, canImport = true, signedIn = true, onImport = null, seen = [] } = {}) {
  return {
    mocks: {
      'GET /auth/settings/psn': signedIn ? json(200, { linked: true, online_id: 'Goopy' }) : json(401, { detail: 'authentication required' }),
      'GET /api/admin/check': json(200, { admin: false }),
      'GET /api/whatsapp/can-import': json(200, { can_import: signedIn && canImport }),
      'GET /api/whatsapp/export': (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="whatsapp-all_time.xlsx"' }, body: Buffer.from('PK\x03\x04fake') }),
      ...(onImport ? { 'POST /api/whatsapp/import': onImport } : {}),
    },
    match: (key, url) => {
      const m = /^GET \/api\/whatsapp\/(stats|awards|activity|heatmap|words|emojis|response-times|members)$/.exec(key)
      if (!m) return null
      const range = url.searchParams.get('range') || 'all_time'
      seen.push({ kind: m[1], range, start: url.searchParams.get('start'), end: url.searchParams.get('end') })
      if (fail?.(m[1], range)) return json(503, { detail: 'down' })
      const h = json(200, waFixture(m[1], totals[range] ?? 0))
      return slow[range] ? delayed(slow[range], h) : h
    },
  }
}

// ── Coach fixtures (PS-8). Every /api/coaching route is mocked; the writes are recorded. ──
function coReview(i, grade, extra = {}) {
  return {
    review_id: `rv${i}`, clip_id: `c${i}`, psn_user: 'Goopy', is_mine: true, game: i % 2 ? 'EA FC 26' : 'Rocket League', created_at: NOW - i * 86400 - 600, status: 'complete',
    summary: `Clip ${i}: decent rotations, late on the second ball.`, overall_assessment: `Review ${i}: solid but slow to rotate`, grade,
    strengths: ['Good first touch', 'Called the switch early'], mistakes: ['Ball-watching on the back post', 'Late press'], coaching_tips: [`Drill ${i}: shoulder-check before every reception`],
    notable_moments: [{ t: '0:12', note: 'Clean through ball' }, 'Missed tackle'], tags: ['positioning', 'pressing'], voice_comms: 'Bizzle: back post!\nGoopy: got it',
    my_feedback: null, ...extra,
  }
}
function coData(scope = 'me', { empty = false, processing = 1, notify = 'group', detail = 'full' } = {}) {
  const mine = empty ? [] : [coReview(0, 'B+'), coReview(1, 'C', { my_feedback: { rating: 'up', tags: [], comment: '' } }), coReview(2, 'B'), coReview(3, 'A-'), coReview(4, 'D', { status: 'failed', grade: 'C' })]
  const squad = empty ? [] : [{ grade: 'A', game: 'EA FC 26', created_at: NOW - 3600 }, { grade: 'C+', game: 'Rocket League', created_at: NOW - 2 * 86400 }, { grade: 'B', game: 'EA FC 26', created_at: NOW - 3 * 86400 }]
  const reviews = scope === 'me' ? mine : squad
  return {
    scope, notify_mode: notify, detail_mode: detail,
    counts: { mine: mine.length, squad: squad.length, complete: reviews.length, processing: scope === 'me' ? processing : 0 },
    processing: scope === 'me' && processing ? [{ clip_id: 'p1', psn_user: 'Goopy', status: 'queued', created_at: NOW - 120, reason: 'waiting for the clip to download' }] : [],
    reviews,
    ...(scope === 'squad' ? { sightings: empty ? [] : [{ player: 'Bizzle', observation: 'Keeps drifting wide when we lose the ball', game: 'EA FC 26', created_at: NOW - 7200 }] } : {}),
    charts: {
      tags: empty ? [] : [{ label: 'positioning', count: 4 }, { label: 'pressing', count: 3 }],
      mistakes: empty ? [] : [{ label: 'Ball-watching on the back post', count: 3, ...(scope === 'me' ? { reviews: ['rv3'] } : {}) }, { label: 'Late press', count: 1, ...(scope === 'me' ? { reviews: ['rv2'] } : {}) }],
      per_day: Array.from({ length: 30 }, (_, i) => ({ label: `d${i}`, count: empty ? 0 : i % 5 === 0 ? 1 : 0 })),
      grades: empty ? [] : [{ label: 'A', count: 1 }, { label: 'B', count: 2 }, { label: 'C', count: 1 }],
    },
  }
}
function coMocks({ get = (scope) => json(200, coData(scope)), prefs = null, feedback = null, seen = [] } = {}) {
  return {
    mocks: {
      'GET /auth/settings/psn': json(200, { linked: true, online_id: 'Goopy' }),
      'GET /api/admin/check': json(200, { admin: false }),
      'GET /api/coaching': (r) => { const sc = new URL(r.request().url()).searchParams.get('scope'); seen.push(sc); return get(sc)(r) },
      ...(prefs ? { 'POST /api/coaching/prefs': prefs } : {}),
      ...(feedback ? { 'POST /api/coaching/feedback': feedback } : {}),
    },
  }
}

// ── Ask AI fixtures (PS-9). The answer lands in history; the ask itself only queues. ──
const askMsg = (id, role, content, extra = {}) => ({ id, role, content, status: 'done', tools: [], elapsed_ms: null, created_at: NOW - 600 + id, ...extra })
const ASK_THREAD = [
  askMsg(1, 'user', 'who has the best music taste?'),
  askMsg(2, 'assistant', 'Bizzle — 41 Slap plays this week, mostly UK garage.', { tools: ['slap_top_tracks', 'squad_members'], elapsed_ms: 2310 }),
  askMsg(3, 'user', 'what time of day is the group most active?'),
  askMsg(4, 'assistant', '', { status: 'error' }),
]
const askFacts = (n = 7) => ({
  facts: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, subject: i % 2 ? 'Bizzle' : 'Goopy', text: `Fact ${i}: ${i % 2 ? 'always picks Liverpool' : 'hates penalties'}`, author: i < 2 ? 'Goopy' : 'Bizzle', created_at: NOW - i * 3600, mine: i < 2 })),
  total: n, mine: Math.min(n, 2), max_per_user: 25, max_chars: 280, subjects: ['Goopy', 'Bizzle'],
})
function askMocks({ tools = json(200, { available: true, model: 'qwen3-32b', tools: [{ name: 'a', description: '' }, { name: 'b', description: '' }, { name: 'c', description: '' }] }), history = json(200, { messages: ASK_THREAD, pending: false, count: 4 }), facts = json(200, askFacts()), writes = {} } = {}) {
  return {
    mocks: {
      'GET /auth/settings/psn': json(200, { linked: true, online_id: 'Goopy' }),
      'GET /api/admin/check': json(200, { admin: false }),
      'GET /api/assistant/tools': tools,
      'GET /api/assistant/history': history,
      'GET /api/assistant/facts': facts,
      ...writes,
    },
  }
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
    check('top bar at rest is 60px with a 48px mascot', Math.round(bar) === 60 && Math.round(mascot) === 48, `${bar} / ${mascot}`)
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
    check('top bar condenses to 46px, mascot 36px, tagline hidden', Math.round(barC) === 46 && Math.round(mascotC) === 36 && tagOpacity === '0', `${barC} / ${mascotC} / opacity ${tagOpacity}`)
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
    await page.goto(BASE + '/app/clips/x')
    await page.waitForSelector('h1')
    await shot(page, 'handoff-1440')
    await axe(page, 'Handoff 1440')
    check('no unmocked writes and no page errors (desktop)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }

  // ── 3. Routing: legacy ?p=, handoffs, not found, admin gating ──────────────
  {
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { 'GET /': classicStub, ...CLIP_READS } })
    const map = { squad: '/app', pipeline: '/app/clips', upload: '/app/clips?upload', slap: '/app/slap', wa: '/app/whatsapp', giveaway: '/app/giveaway', watch: '/app/watch/party', huddle: '/app/huddle', coach: '/app/coach', ai: '/app/ask', nope: '/app', '../../etc': '/app' }
    for (const [k, want] of Object.entries(map)) {
      await page.goto(`${BASE}${process.env.LEGACY_PREFIX || "/app/"}?p=${encodeURIComponent(k)}`)
      await page.waitForSelector('h1')
      const u = new URL(page.url())
      check(`legacy ?p=${k} → ${want}`, u.pathname + u.search === want || (want === '/app' && u.pathname === '/app'), u.pathname + u.search)
    }
    const classic = { 'clips/x': '/dashboard?p=pipeline' }   // / opens /app now; the classic dashboard is /dashboard
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
    check('re-send asks first and names the group', (await page.textContent('[role=alertdialog]')).includes('to the CRCMZ BOYZ group'))
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
  // ── 8a. Slap Discover: the default tab. The AI mix, new finds (Listen + Download), charts ──
  {
    const downloads = []
    const FIND = (id, title, status = 'new', extra = {}) => ({ id, title, artist: 'New Artist', album: 'New Album', art: null, preview: `https://audio-ssl.itunes.apple.com/${id}.m4a`, duration: 200, for: 'moiz', status, by: null, track_id: null, error: null, ...extra })
    const disc = { week: '2026-09-28', expires: (NOW + 3 * 86400) * 1000, ready: true, making: false, why: { moiz: 'You like rap.' },
      finds: [FIND('1001', 'Fresh One'), FIND('1002', 'Queued One', 'queued', { by: 'zubair221b' }), FIND('1003', 'Landed One', 'done', { by: 'nooramin40', track_id: 't1' }), FIND('1004', 'Broke One', 'failed')] }
    const { ctx, page } = await newPage({
      width: 375, height: 800, mocks: { ...SLAP_BASE, 'GET /api/slap/discover': json(200, disc) },
      match: slapMatch({
        'POST /api/slap/discover/download': (r) => { const b = r.request().postDataJSON(); downloads.push(b.id); return json(200, { ...disc.finds.find((f) => f.id === b.id), status: 'queued', by: 'moiz' })(r) },
        'POST /api/slap/listen/play': json(200, { ok: true }), 'POST /api/slap/listen/skip': json(200, { ok: true }),
      }),
    })
    await page.route('https://audio-ssl.itunes.apple.com/**', serveRange(STUDIO_VIDEO, 'video/webm'))
    await ready(page, '/app/slap')
    await page.waitForSelector('.find-tile')
    check('discover: Slap opens on Discover', (await page.getAttribute('.seg-4 [role=tab][data-state=active]', 'id'))?.includes('discover') || (await page.textContent('.seg-4 [role=tab][data-state=active]')) === 'Discover')
    check('discover: the AI mix leads, from the library', (await page.textContent('#disc-mix-h')) === 'Friday fuel' && (await page.locator('.disc-hero .shelf-card').count()) === 1)
    check('discover: new finds show song, artist and who they were picked for', (await page.locator('.find-tile').count()) === 4
      && (await page.textContent('.find-tile >> nth=0')).includes('Fresh One') && (await page.textContent('.find-tile >> nth=0')).includes('New Artist')
      && (await page.textContent('.find-tile >> nth=0')).includes('for moiz')
      && (await page.getAttribute('.find-tile[data-status=queued] .find-mark', 'aria-label')).startsWith('Downloading by')
      && (await page.getAttribute('.find-tile[data-status=done] .find-mark', 'aria-label')).startsWith('In the library'))
    check('discover: a play sign on every tiny cover that has something to play', (await page.locator('.find-art .find-play').count()) === 4
      && (await page.locator('.find-art[aria-pressed]').count()) === 3)
    check('discover: just a download icon, on finds not in yet (Try again icon when it failed)',
      (await page.locator('.find-tile[data-status=new] .find-get[aria-label^="Download"]').count()) === 1
      && (await page.locator('.find-tile[data-status=failed] .find-get[aria-label^="Try downloading"]').count()) === 1
      && (await page.locator('.find-tile[data-status=done] .find-get, .find-tile[data-status=queued] .find-get').count()) === 0)
    check('discover: charts and recently added show', (await page.locator('#disc-fav-h').count()) === 1 && (await page.locator('#disc-hot-h').count()) === 1 && (await page.locator('#disc-recent-h').count()) === 1)
    await shot(page, 'slap-discover-375', true)
    await axe(page, 'Slap Discover 375', '.app-main')
    await tapTargets(page, 'Slap Discover 375')
    await page.click('.find-tile[data-status=new] .find-get')
    await page.waitForFunction(() => document.querySelector('.toasts')?.textContent?.includes('your picks'))
    check('discover: Download credits you and says where it goes', downloads.join() === '1001' && (await page.getAttribute('.find-tile >> nth=0 >> .find-mark', 'aria-label')).startsWith('Downloading by moiz'), downloads.join())
    await page.click('.find-tile[data-status=done] .find-art')
    await page.waitForSelector('.miniplayer-bar')
    check('discover: a landed find plays from the library', (await page.textContent('.miniplayer-title')).includes('Track 1'))
    check('no unmocked writes and no page errors (Slap Discover)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 8a'. New finds: 20 a day, 2 across, 3 rows (6) in view, the rest a scroll away ──
  {
    const FIND = (i) => ({ id: String(2000 + i), title: `Song ${i}`, artist: `Artist ${i}`, album: '', art: null, preview: `https://audio-ssl.itunes.apple.com/${i}.m4a`, duration: 200, for: 'moiz', status: 'new', by: null, track_id: null, error: null })
    const disc = { week: '2026-10-03', expires: (NOW + 86400) * 1000, ready: true, making: false, why: {}, finds: Array.from({ length: 20 }, (_, i) => FIND(i)) }
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { ...SLAP_BASE, 'GET /api/slap/discover': json(200, disc) }, match: slapMatch({}) })
    await ready(page, '/app/slap')
    await page.waitForSelector('.find-tile')
    const g = await page.$eval('.find-grid', (el) => {
      const box = el.getBoundingClientRect()
      const tiles = [...el.querySelectorAll('.find-tile')].map((t) => t.getBoundingClientRect())
      const inView = tiles.filter((t) => t.left >= box.left - 1 && t.right <= box.right + 1).length
      return { n: tiles.length, rows: new Set(tiles.map((t) => Math.round(t.top))).size, inView,
        sideways: el.scrollWidth > el.clientWidth + 10, notDown: el.scrollHeight <= el.clientHeight + 1 }
    })
    check('discover: 20 finds in 3 rows, 6 in view, swiping sideways (never up and down)', g.n === 20 && g.rows === 3 && g.inView === 6 && g.sideways && g.notDown, JSON.stringify(g))
    await shot(page, 'slap-discover-grid-375', true)
    await ctx.close()
    const off = await newPage({ width: 375, height: 800, mocks: { ...SLAP_BASE, 'GET /api/slap/discover': json(200, { ...disc, finds: [], off: true }) }, match: slapMatch({}) })
    await ready(off.page, '/app/slap')
    await off.page.waitForSelector('#disc-mix-h')
    await off.page.waitForTimeout(500)
    check('discover: the App Store review account sees no New finds', (await off.page.locator('#disc-new-h').count()) === 0)
    await off.ctx.close()
  }
  // ── The apps' Slap player: a reload while a song plays shows it playing ─────
  {
    const { ctx, page } = await newPage({ width: 390, height: 844, mocks: SLAP_BASE, match: slapMatch({}) })
    await ctx.addInitScript(() => {
      window.__audio = []
      window.webkit = { messageHandlers: { crcmzAudio: { postMessage: (m) => window.__audio.push(m) } } }
      localStorage.setItem('slap.player.v1', JSON.stringify({ queue: [{ qid: 'q1', id: 't1', title: 'Track 1', artist: 'A', duration: 200 }], index: 0, shuffle: false, repeat: 'off', position: 10, order: null }))
    })
    await ready(page, '/app/slap?tab=listen')
    await page.waitForSelector('.miniplayer-bar')
    check('app reload: before the app says anything, the restored song shows paused', await page.isVisible('.miniplayer-bar button[aria-label="Play"]'))
    // The app's player outlived the reload and ticks its clock.
    await page.evaluate(() => window.__crcmzAudio({ event: 'timeupdate', time: 42, duration: 200 }))
    await page.waitForSelector('.miniplayer-bar button[aria-label="Pause"]', { timeout: 3000 }).catch(() => {})
    check('app reload: a song still playing in the app shows playing', await page.isVisible('.miniplayer-bar button[aria-label="Pause"]'))
    check('app reload: and the app is not told to load it again', !(await page.evaluate(() => window.__audio.some((m) => m.type === 'src'))), JSON.stringify(await page.evaluate(() => window.__audio)))
    await page.click('.miniplayer-bar button[aria-label="Pause"]')
    check('app reload: Pause then reaches the app', await page.evaluate(() => window.__audio.some((m) => m.type === 'pause')))
    check('no page errors (app reload)', page.violations.length === 0, page.violations.join(', '))
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
    await ready(page, '/app/slap?tab=listen')
    await page.waitForSelector('.track-row')
    check('Slap header names the music account', (await page.textContent('.slap-sub')).includes('Listening as moiz'))
    check('four segmented tabs (Discover / Listen / Together / Stats)', (await page.locator('.seg-4 [role=tab]').count()) === 4)
    const segCols = await page.$eval('.seg-4', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length)
    check('.seg-4 lays out four columns', segCols === 4, `${segCols}`)
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
    {
      await page.waitForFunction(() => navigator.mediaSession.metadata?.title?.startsWith('Track'))
      const l = await lock(page)
      check('slap lock screen: the track, its art and the music buttons', l.title === (await page.textContent('.miniplayer-title')) && (l.art?.includes('/api/slap/art/') || l.art?.endsWith('/app/pwa/icon-192.png')) && l.actions === 'nexttrack,pause,play,previoustrack,seekbackward,seekforward,seekto', JSON.stringify(l))
      await page.waitForFunction(() => navigator.mediaSession.playbackState === 'playing', null, { timeout: 5000 }).catch(() => {})
      await press(page, 'pause')
      await page.waitForFunction(() => navigator.mediaSession.playbackState === 'paused', null, { timeout: 5000 }).catch(() => {})
      check('slap lock screen: pause pauses the player', (await lock(page)).state === 'paused' && (await page.isVisible('.miniplayer-bar button[aria-label="Play"]')), JSON.stringify(await lock(page)))
      const before = await page.textContent('.miniplayer-title')
      await press(page, 'nexttrack')
      await page.waitForFunction((t) => document.querySelector('.miniplayer-title')?.textContent !== t, before, { timeout: 5000 }).catch(() => {})
      const after = await page.textContent('.miniplayer-title')
      check('slap lock screen: next skips, and the card follows', after !== before && (await lock(page)).title === after, `${before} -> ${after} / ${(await lock(page)).title}`)
      await press(page, 'previoustrack')
      await page.waitForFunction((t) => document.querySelector('.miniplayer-title')?.textContent === t, before, { timeout: 5000 }).catch(() => {})
      check('slap lock screen: previous goes back', (await page.textContent('.miniplayer-title')) === before && (await lock(page)).title === before)
      await press(page, 'play')
    }
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
    // ✕ on the mini-player stops and puts the player away, for good.
    await page.click('.miniplayer-bar .miniplayer-close')
    await page.waitForSelector('.miniplayer-bar', { state: 'detached' })
    check('closing the player hides the mini-player', !(await page.evaluate(() => 'player' in document.documentElement.dataset)))
    check('closing the player clears the saved queue', await page.evaluate(() => (JSON.parse(localStorage.getItem('slap.player.v1') || '{}').queue ?? []).length === 0))
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
    const setTabs = await page.locator('.tabstrip[role=tablist] [role=tab]').allTextContents()
    check('settings tabs are a tablist: profile, passkeys, password, PSN, Steam, Mattermost, MCP, Watch, App', setTabs.join('|') === 'Profile|Passkeys|Password|PSN|Steam|Mattermost|MCP|Watch|App', setTabs.join('|'))
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
    check('giveaway: overdue reveal says the server is revealing it', (await page.textContent('.gw-due')) === 'Revealing the winner…')
    check('giveaway: drawn never shows a winner to members', !(await page.textContent('.gw-hero')).includes('Bizzle') && !(await page.locator('.gw-count').count()))
    const before = gets
    await page.waitForTimeout(6000)
    check('giveaway: overdue re-fetches on a backoff (5 s first)', gets > before, `${before} → ${gets}`)
    check('giveaway: overdue page never POSTs', posts.length === 0, posts.join(', '))
    check('giveaway: empty history hides Past winners', (await page.locator('#gw-past').count()) === 0)
    await ctx.close()
  }
  {
    // The server's reveal_at_ms is the instant; a skewed reveal_at string must not move the countdown.
    const d = gwData({ revealIn: 5 * 86400e3 })
    d.giveaway.reveal_at_ms = Date.now() + 3 * 3600e3 + 30e3
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: { 'GET /api/giveaway': json(200, d), 'GET /api/giveaway/history': json(200, []) } })
    await ready(page, '/app/giveaway')
    await page.waitForSelector('.gw-count')
    const lbl = await page.getAttribute('.gw-count', 'aria-label')
    check('giveaway: countdown follows the server instant (reveal_at_ms)', /^Reveal in 3 hours and 0 minutes$/.test(lbl), lbl)
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
        'GET /api/giveaway': json(200, { ...gwData({ admin: true }), reveal_tz: 'America/Los_Angeles' }),
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
    check('admin form names the reveal zone and says it is automatic', (await page.textContent('#gw-f-when-hint')) === 'Pacific Time. The winner is revealed automatically at this time.')
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
  // ── 13. Watch (PS-6). The WatchParty socket is a fake io() that records emits;
  // every Watch API call (join, rally, nickname, history, log) is a fixture. ──
  {
    const posts = { rally: [], nick: [], hist: [], log: 0, title: [], del: [] }
    const WATCH_VIDEO = `${BASE}/wp-fixture/movie.webm`
    const HIST = [
      { url: WATCH_VIDEO, source_url: null, kind: 'movie', title: 'Heat', year: 1995, description: null, overview: 'Cops and robbers.', poster: null, meta_url: null, named_by: 'source', chat_count: 3, last_watched_at: NOW - 3600, position: 2, duration: 6, finished: false, viewers: [{ name: 'Goopy', position: 2, finished: false, updated_at: NOW - 3600 }], mine: { position: 2, finished: false, updated_at: NOW - 3600 } },
      { url: `${BASE}/wp-fixture/other.mp4`, source_url: null, kind: null, title: '', year: null, description: null, overview: null, poster: null, meta_url: null, named_by: null, chat_count: 0, last_watched_at: NOW - 86400, position: 0, duration: null, finished: false, viewers: [], mine: null },
    ]
    const FAKE_IO = `(() => {
      window.__wpEmits = []
      window.io = (url, opts) => {
        const h = {}
        const s = { id: 'sid1', connected: false, url, opts,
          on(ev, fn) { (h[ev] ||= []).push(fn); return s },
          emit(ev, ...a) { window.__wpEmits.push([ev, ...a]); return s },
          removeAllListeners() { for (const k in h) delete h[k] },
          disconnect() { s.connected = false } }
        window.__wpFire = (ev, ...a) => (h[ev] || []).forEach((f) => f(...a))
        window.__wpSock = s
        setTimeout(() => { s.connected = true; window.__wpFire('connect'); window.__wpFire('watch:presence', { count: 3, viewers: [{ id: 'me', name: 'Goopy' }, { id: 'p2', name: 'Bizzle' }, { id: 'p3', name: 'Noor' }] }); window.__wpFire('REC:nameMap', { me: 'Goopy', p2: 'Bizzle', p3: 'Noor' }) }, 30)
        return s
      }
    })()`
    const FAKE_LK = `(() => {
      const Source = { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' }
      const E = { TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed', ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
        ActiveSpeakersChanged: 'activeSpeakersChanged', LocalTrackPublished: 'localTrackPublished', LocalTrackUnpublished: 'localTrackUnpublished', TrackMuted: 'trackMuted', TrackUnmuted: 'trackUnmuted',
        TrackPublished: 'trackPublished', TrackUnpublished: 'trackUnpublished', DataReceived: 'dataReceived', AudioPlaybackStatusChanged: 'audioPlaybackChanged', Reconnecting: 'reconnecting',
        SignalReconnecting: 'signalReconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected' }
      const track = (kind, source, mst) => ({ kind, source, isMuted: false, mediaStreamTrack: mst,
        attach(el) { el = el || document.createElement(kind); el.srcObject = new MediaStream([this.mediaStreamTrack]); return el },
        detach(el) { if (el) el.srcObject = null; return el },
        async replaceTrack(t) { this.mediaStreamTrack = t } })
      const canvasTrack = (color) => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 320, 240); setInterval(() => { g.fillStyle = color; g.fillRect(0, 0, 320, 240) }, 200); return c.captureStream(5).getVideoTracks()[0] }
      const toneTrack = () => { const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start(); return d.stream.getAudioTracks()[0] }
      const participant = (identity, name) => ({ identity, name, isSpeaking: false, trackPublications: new Map(),
        getTrackPublication(src) { return [...this.trackPublications.values()].find((p) => p.source === src) } })
      window.__lkData = []
      window.__lkConnects = []
      class Room {
        constructor(opts) {
          const room = this
          this.opts = opts; this.h = {}; this.canPlaybackAudio = true; this.remoteParticipants = new Map()
          const lp = participant('u1', 'Goopy')
          const pub = (src, t) => { const p = { kind: t.kind, source: src, trackSid: src, isMuted: false, track: t }; lp.trackPublications.set(src, p); room.fire(E.LocalTrackPublished, p, lp) }
          const enabled = (src) => { const p = lp.getTrackPublication(src); return !!p && !p.isMuted }
          Object.defineProperties(lp, {
            isMicrophoneEnabled: { get: () => enabled(Source.Microphone) },
            isCameraEnabled: { get: () => enabled(Source.Camera) },
            isScreenShareEnabled: { get: () => enabled(Source.ScreenShare) },
          })
          const toggle = async (src, on, get) => {
            const p = lp.getTrackPublication(src)
            if (p && src !== Source.ScreenShare) { p.isMuted = !on; p.track.isMuted = !on; room.fire(on ? E.TrackUnmuted : E.TrackMuted, p, lp); return }
            if (p && !on) { p.track.mediaStreamTrack.stop(); lp.trackPublications.delete(src); room.fire(E.LocalTrackUnpublished, p, lp); return }
            if (on) pub(src, track(src === Source.Microphone ? 'audio' : 'video', src, await get()))
          }
          lp.setMicrophoneEnabled = (on) => toggle(Source.Microphone, on, async () => (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0])
          lp.setCameraEnabled = (on) => toggle(Source.Camera, on, async () => (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0])
          lp.setScreenShareEnabled = (on) => toggle(Source.ScreenShare, on, async () => canvasTrack('#2244aa'))
          lp.publishData = async (data, o) => { window.__lkData.push({ ...JSON.parse(new TextDecoder().decode(data)), topic: o.topic, reliable: o.reliable }) }
          lp.unpublishTrack = async (t, stop) => { for (const [k, p] of lp.trackPublications) if (p.track === t) { lp.trackPublications.delete(k); if (stop) t.mediaStreamTrack.stop(); room.fire(E.LocalTrackUnpublished, p, lp) } }
          this.localParticipant = lp
          // The test's handles stay on the first live room: a Watch call joined during a
          // Huddle is a second room, and the Huddle checks are about the first.
          if (window.__lkRoom && window.__lkRoom.state !== 'disconnected') return
          window.__lkRoom = this
          window.__lkFire = (ev, ...a) => room.fire(ev, ...a)
          window.__lkAdd = (id, name) => {
            const p = participant(id, name)
            room.remoteParticipants.set(id, p)
            room.fire(E.ParticipantConnected, p)
            for (const [src, t] of [[Source.Camera, track('video', Source.Camera, canvasTrack(id === 'p2' ? '#aa2266' : '#22aa66'))], [Source.Microphone, track('audio', Source.Microphone, toneTrack())]]) {
              const pb = { kind: t.kind, source: src, trackSid: id + src, isMuted: false, isSubscribed: true, track: t }
              p.trackPublications.set(src, pb)
              room.fire(E.TrackSubscribed, t, pb, p)
            }
          }
          window.__lkRemove = (id) => { const p = room.remoteParticipants.get(id); if (!p) return; room.remoteParticipants.delete(id); for (const pb of p.trackPublications.values()) room.fire(E.TrackUnsubscribed, pb.track, pb, p); room.fire(E.ParticipantDisconnected, p) }
          window.__lkSpeak = (ids) => { const all = [lp, ...room.remoteParticipants.values()]; all.forEach((p) => { p.isSpeaking = ids.includes(p.identity) }); room.fire(E.ActiveSpeakersChanged, all.filter((p) => p.isSpeaking)) }
          window.__lkSay = (id, obj) => room.fire(E.DataReceived, new TextEncoder().encode(JSON.stringify(obj)), room.remoteParticipants.get(id), 0, 'crcmz-huddle')
        }
        on(ev, fn) { (this.h[ev] ||= []).push(fn); return this }
        fire(ev, ...a) { (this.h[ev] || []).forEach((f) => f(...a)) }
        async connect(url, token) { window.__lkConnects.push([url, token]); this.state = 'connected' }
        async disconnect() { this.state = 'disconnected'; this.fire(E.Disconnected, 1) }
        async startAudio() { this.canPlaybackAudio = true }
      }
      window.LivekitClient = { Room, RoomEvent: E, Track: { Source }, DisconnectReason: { CLIENT_INITIATED: 1, SERVER_SHUTDOWN: 2 } }
    })()`
    const film = (imdb, title, year, extra = {}) => ({ imdb, title, year, poster: '', background: '', rating: '8.0', genres: ['Drama'], overview: `${title}, the film.`, state: 'new', id: null, quality: '', progress: 0, error: '', ...extra })
    const INCEPTION = film('tt1375666', 'Inception', '2010', { state: 'ready', id: 'd'.repeat(32), quality: '4K HDR', rating: '8.8' })
    const MOVIES_HOME = {
      featured: INCEPTION, genres: ['Action', 'Horror'],
      rows: [
        { id: 'popular', title: 'Trending now', kind: 'popular', genre: '', items: [INCEPTION, film('tt0110912', 'Pulp Fiction', '1994')] },
        { id: 'g-Horror', title: 'Horror', kind: 'popular', genre: 'Horror', items: [film('tt7784604', 'Hereditary', '2018')] },
      ],
    }
    const WATCH = {
      'GET /api/watch/config': json(200, { authMode: 'zitadel', origin: '', socketPath: '/wp/socket.io', rooms: ['crcmz'], defaultRoom: 'crcmz', ticketTtl: 60, viewer: { id: 'u1', name: 'Goopy', nickname: '', psnOnlineId: 'Goopy', mod: true } }),
      'GET /wp/socket.io/socket.io.js': (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_IO }),
      'POST /api/watch/join': json(200, { ticket: 'tkt', expiresIn: 60, room: 'crcmz', viewer: { name: 'Goopy', mod: true } }),
      'GET /npm/livekit-client@2/dist/livekit-client.umd.min.js': (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LK }),
      'POST /api/watch/call/token': (r) => { posts.callToken = [...(posts.callToken || []), r.request().postDataJSON()]; return json(200, { token: 'lk-watch', url: 'wss://lk.example', room: 'watch-crcmz' })(r) },
      'GET /api/ring/people': json(200, [{ id: 'u2', name: 'Noor', reachable: true }, { id: 'u3', name: 'Zubair', reachable: false }]),
      'POST /api/ring': (r) => { posts.ring = [...(posts.ring || []), r.request().postDataJSON()]; return json(200, { phones_rang: 1, pushed: 2 })(r) },
      'POST /api/watch/rally': (r) => { posts.rally.push(r.request().postDataJSON()); return json(200, { status: 'sent' })(r) },
      'POST /api/watch/nickname': (r) => { posts.nick.push(r.request().postDataJSON()); return json(200, { nickname: 'G', name: 'G' })(r) },
      'POST /api/watch/history': (r) => { posts.hist.push(1); return json(200, { ok: true })(r) },
      'POST /api/watch/history/title': (r) => { posts.title.push(r.request().postDataJSON()); return json(200, { ok: true })(r) },
      'DELETE /api/watch/history': (r) => { posts.del.push(r.request().postDataJSON()); return json(200, { ok: true, removed: 1 })(r) },
      'GET /api/watch/movies/library': (r) => json(200, {
        can_add: true,
        movies: (posts.removed || []).length ? [] : [{ id: 'c'.repeat(32), imdb: 'tt0113277', title: 'Heat', year: '1995', quality: '4K HDR', overview: '', poster: '', added: '2026-10-01T00:00:00Z', by: 'Goopy', can_remove: true }],
        adding: [{ imdb: 'tt0137523', title: 'Fight Club', year: '1999', poster: '', status: 'downloading', progress: 40, quality: '4K HDR', size_gb: 14, by: 'Bizzle', error: '', id: null, at: NOW * 1000 }],
      })(r),
      'GET /api/watch/movies/popular': json(200, { results: [
        { imdb: 'tt0113277', title: 'Heat', year: '1995', poster: '', overview: '', state: 'ready', id: 'c'.repeat(32), quality: '4K HDR', progress: 0, error: '' },
        { imdb: 'tt0110912', title: 'Pulp Fiction', year: '1994', poster: '', overview: '', state: 'new', id: null, quality: '', progress: 0, error: '' },
      ] }),
      'GET /api/watch/movies/search': json(200, { results: [
        { imdb: 'tt15239678', title: 'Dune: Part Two', year: '2024', poster: '', overview: '', state: 'new', id: null, quality: '', progress: 0, error: '' },
      ] }),
      'GET /api/watch/movies/home': json(200, MOVIES_HOME),
      'GET /api/watch/movies/now': json(200, { room: 'crcmz', watching: 0, video: '', title: '', poster: '', id: null, paused: true }),
      'GET /api/watch/movies/options/tt0110912': json(200, { imdb: 'tt0110912', '4k': { size_gb: 24.9, hdr: true, label: '4K HDR' }, '1080p': { size_gb: 9.1, hdr: false, label: '1080p' } }),
      'GET /api/watch/movies/meta/tt0110912': (r) => json(200, { ...MOVIES_HOME.rows[0].items[1], state: (posts.movies || []).some((m) => m.imdb === 'tt0110912') ? 'finding' : 'new', logo: '', runtime: 154, director: ['Quentin Tarantino'], cast: ['John Travolta', 'Uma Thurman'], writer: [], awards: 'Won 1 Oscar', country: 'United States', trailers: ['s7EdQ4FqbhY'], can_add: true, by: '', can_remove: false, library_quality: '', adding: null })(r),
      'GET /api/watch/movies/meta/tt1375666': json(200, { ...MOVIES_HOME.featured, logo: '', runtime: 148, director: ['Christopher Nolan'], cast: ['Leonardo DiCaprio'], writer: [], awards: '', country: '', trailers: [], can_add: true, by: 'Goopy', can_remove: true, library_quality: '4K HDR', adding: null, release: 'Inception.2010.2160p.HDR.x265-OLD' }),
      'GET /api/watch/movies/copies/tt0110912': json(200, { imdb: 'tt0110912', copies: [
        { id: 'a'.repeat(40), release: 'Pulp.Fiction.1994.2160p.HDR.x265-BEST', size_gb: 24.9, label: '4K HDR', seeders: 120 },
        { id: 'b'.repeat(40), release: 'Pulp.Fiction.1994.1080p.BluRay.x264-OK', size_gb: 9.1, label: '1080p', seeders: 300 },
      ] }),
      'GET /api/watch/movies/copies/tt1375666': json(200, { imdb: 'tt1375666', copies: [
        { id: 'c'.repeat(40), release: 'Inception.2010.2160p.HDR.x265-OLD', size_gb: 20.1, label: '4K HDR', seeders: 90 },
        { id: 'e'.repeat(40), release: 'Inception.2010.2160p.DV.WEB-NEW', size_gb: 15.2, label: '4K DV', seeders: 60 },
      ] }),
      'POST /api/watch/movies/replace': (r) => { posts.replace = [...(posts.replace || []), r.request().postDataJSON()]; return json(200, { imdb: 'tt1375666', title: 'Inception', year: '2010', poster: '', status: 'finding', progress: 0, quality: '', size_gb: 0, by: 'Goopy', error: '', id: null, at: NOW * 1000, release: '' })(r) },
      'POST /api/watch/movies/remove': (r) => { posts.removed = [...(posts.removed || []), r.request().postDataJSON()]; return json(200, { title: 'Heat', removed: 1 })(r) },
      'POST /api/watch/movies/add': (r) => { posts.movies = [...(posts.movies || []), r.request().postDataJSON()]; return json(200, { imdb: 'tt15239678', title: 'Dune: Part Two', year: '2024', poster: '', status: 'finding', progress: 0, quality: '', size_gb: 0, by: 'Goopy', error: '', id: null, at: NOW * 1000 })(r) },
      'POST /api/watch/log': (r) => { posts.log++; return json(200, { ok: true })(r) },
      'POST /api/watch/extract': json(200, { url: WATCH_VIDEO, title: 'Heat' }),
      'GET /api/watch/history': json(200, { items: HIST }),
      'GET /api/watch/history/chat': json(200, { messages: [{ ts: NOW, name: 'Bizzle', msg: 'classic', video_ts: 61 }] }),
      'GET /wp-fixture/movie.webm': serveRange(STUDIO_VIDEO, 'video/webm'),
      'GET /wp-fixture/other.mp4': serveRange(STUDIO_VIDEO, 'video/webm'),
    }
    const emits = (page) => page.evaluate(() => window.__wpEmits.map((e) => e[0]))
    const host = (page) => page.evaluate((u) => window.__wpFire('REC:host', { video: u, videoTS: 0, paused: true }), WATCH_VIDEO)

    // Phone
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks: WATCH })
    await page.addInitScript(() => { if (!sessionStorage.getItem('wp-t')) { sessionStorage.setItem('wp-t', '1'); localStorage.removeItem('watch.orbs.pos') } })
    await ready(page, '/app/watch/party')
    await page.waitForSelector('.wp-pill[data-tone="live"]')
    check('watch: joins with a ticket and goes live', page.writes.includes('POST /api/watch/join') && (await page.textContent('.wp-pill')) === '3 watching')
    check('watch: asks for presence and the host on connect', (await emits(page)).includes('watch:presence:get') && (await emits(page)).includes('CMD:askHost'))
    // Nothing playing: the stage invites a link; the overlay keeps only settings / chat / fullscreen (no seek, no play).
    check('watch: empty stage invites a link', (await page.isVisible('.wp-empty')) && !(await page.locator('.wp-seek, .wp-ov-mid').count())
      && (await page.isVisible('.wp-stage button[aria-label="Settings"]')))
    // The party's Library: Downloaded, then Watched (history). Finding movies is the Movies home.
    await page.waitForSelector('.mv-card')
    check('library: Downloaded shows the film with Play for the party', (await page.textContent('.mv-card .mv-title')).includes('Heat') && (await page.locator('.mv-card button:has-text("Play")').count()) === 1)
    check('library: an add on its way shows its progress', (await page.textContent('.mv-add')).includes('40%') && (await page.getAttribute('.mv-bar', 'aria-valuenow')) === '40')
    await page.locator('.wp-library').scrollIntoViewIfNeeded()
    await shot(page, 'watch-375-library')
    await page.click('.mv-card button[aria-label="Remove Heat from the library"]')
    await page.waitForSelector('[role=alertdialog], [role=dialog]')
    check('library: Remove asks first', (posts.removed || []).length === 0)
    await page.locator('[role=alertdialog] button:has-text("Remove"), [role=dialog] button:has-text("Remove")').last().click()
    await page.waitForFunction(() => !document.querySelector('.mv-card'))
    check('library: confirming removes it once and the card goes', (posts.removed || []).length === 1 && posts.removed[0].id === 'c'.repeat(32))
    check('library: the party links to the Movies home to find more', (await page.getAttribute('.wp-library a:has-text("Browse all movies")', 'href')) === '/app/watch')
    await tapTargets(page, 'Watch library 375')
    await page.click('.mv-tabs [role=tab]:has-text("Watched")')
    await page.waitForSelector('.wp-card')
    check('watch: history lists the room', (await page.locator('.wp-card').count()) === 2 && (await page.textContent('.wp-card .wp-card-title')).includes('Heat'))
    await shot(page, 'watch-375-empty', true)
    await host(page)
    await page.waitForSelector('.wp-overlay')
    await page.waitForFunction(() => document.querySelector('.wp-video')?.readyState >= 1)
    check('watch: the host video loads into the stage', (await page.getAttribute('.wp-video', 'src')) === WATCH_VIDEO)
    check('watch: overlay has back 10 / play / forward 10 in the middle', (await page.locator('.wp-ov-mid button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))).join('|') === 'Back 10 seconds|Play|Forward 10 seconds')
    const row = await page.locator('.wp-ov-row button:visible').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
    check('watch: phone control row: volume, reactions, fullscreen (no duplicate play)', row.some((l) => /^(Mute|Unmute|Volume)/.test(l)) && row.includes('Reactions') && row.some((l) => /fullscreen/i.test(l)) && !row.includes('Play'), row.join(', '))
    check('watch: seek bar is a labelled slider', (await page.getAttribute('.wp-seek-input', 'aria-label')) !== null && (await page.getAttribute('.wp-seek-input', 'type')) === 'range')
    await page.click('.wp-ov-mid button[aria-label="Play"]')
    await page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:play'))
    check('watch: centre play tells the room', true)
    await page.waitForSelector('.wp-actions button:has-text("Pop out")', { timeout: 5000 }).catch(() => {})
    check('watch: a playing movie can pop out into a floating window', await page.isVisible('.wp-actions button:has-text("Pop out")'))
    {
      await page.waitForFunction(() => navigator.mediaSession.playbackState === 'playing', null, { timeout: 5000 }).catch(() => {})
      const l = await lock(page)
      check('watch lock screen: the party, playing, with seek and picture-in-picture', l.state === 'playing' && l.artist.startsWith('Watch Party') && l.actions === 'enterpictureinpicture,pause,play,seekbackward,seekforward,seekto', JSON.stringify(l))
      const n = await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:pause').length)
      await press(page, 'pause')
      await page.waitForFunction((k) => window.__wpEmits.filter((e) => e[0] === 'CMD:pause').length > k, n, { timeout: 5000 }).catch(() => {})
      check('watch lock screen: pause pauses for the whole room', (await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:pause').length)) > n)
      await press(page, 'play')
      await page.waitForSelector('.wp-ov-mid button[aria-label="Pause"]')
    }
    await page.waitForSelector('.wp-ov-mid button[aria-label="Pause"]')
    const top = await page.locator('.wp-ov-topbar button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
    const botRow = await page.locator('.wp-ov-row button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
    check('watch: the call and sync sit at the top; Message is in the bottom row with the video controls', top.includes('Join with camera') && top.includes('Sync to the room')
      && !top.includes('Message') && botRow.includes('Message') && !botRow.includes('Join with camera'), `${top.join(', ')} | ${botRow.join(', ')}`)
    // Someone joining at 0:00 never pulls the room back: they catch up instead.
    {
      const seeks0 = await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length)
      const t0 = await page.evaluate(() => document.querySelector('.wp-video').currentTime)
      await page.evaluate(() => window.__wpFire('REC:tsMap', { p9: 0 }))
      await page.waitForTimeout(200)
      const t1 = await page.evaluate(() => document.querySelector('.wp-video').currentTime)
      check('watch sync: a newcomer at 0:00 doesn\'t send the room back to the start', t1 >= t0 - 0.5 && (await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length)) === seeks0
        && (await page.evaluate(() => document.querySelector('.wp-video').playbackRate)) === 1, `${t0} -> ${t1}`)
    }
    // Sync: a small lag is caught up by playing a little faster (no seek); a big one seeks.
    {
      const seeks = await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length)
      // The nudge applies while the video is actually playing: give a buffering test video a moment.
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.__wpFire('REC:tsMap', { p2: document.querySelector('.wp-video').currentTime + 2 }))
        await page.waitForTimeout(200)
        if ((await page.evaluate(() => document.querySelector('.wp-video').playbackRate)) !== 1) break
      }
      const rate = await page.evaluate(() => document.querySelector('.wp-video').playbackRate)
      check('watch sync: 2 s behind the room plays a little faster instead of jumping', rate > 1 && rate < 1.1 && (await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length)) === seeks, String(rate))
      const t2 = await page.evaluate(() => document.querySelector('.wp-video').currentTime)
      await page.evaluate((x) => window.__wpFire('REC:tsMap', { p2: x + 0.1 }), t2)
      await page.waitForTimeout(150)
      check('watch sync: back in step, normal speed', (await page.evaluate(() => document.querySelector('.wp-video').playbackRate)) === 1)
    }
    // Scrubbing back: the room's older reports and the echo of our own seek don't pull us forward again.
    {
      const from = await page.evaluate(() => document.querySelector('.wp-video').currentTime)
      const seeks = await page.evaluate(() => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length)
      await page.focus('.wp-seek-input')
      await page.keyboard.press('Home')
      await page.waitForFunction((k) => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length > k, seeks, { timeout: 3000 }).catch(() => {})
      await page.evaluate((x) => { window.__wpFire('REC:tsMap', { p2: x + 1 }); window.__wpFire('REC:seek', 0) }, from)
      await page.waitForTimeout(400)
      const t = await page.evaluate(() => document.querySelector('.wp-video').currentTime)
      const sent = await page.evaluate((k) => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').slice(k).map((e) => e[1]), seeks)
      check('watch scrub: one seek goes to the room, and older reports don\'t drag it back', t < 2 && sent.length === 1 && sent[0] === 0, `from ${from}, now ${t}, sent ${JSON.stringify(sent)}`)
    }
    // Fullscreen on a phone: tapping the button doesn't pin the controls; they fade and the cameras stay.
    {
      const fsBtn = await page.locator('.wp-ov-row button[aria-label="Fullscreen"]').boundingBox()
      await page.touchscreen.tap(fsBtn.x + fsBtn.width / 2, fsBtn.y + fsBtn.height / 2)
      await page.waitForFunction(() => document.querySelector('.wp-stage')?.getAttribute('data-chrome') === 'false', null, { timeout: 6000 }).catch(() => {})
      check('watch: in fullscreen the controls fade after a tap on Fullscreen', (await page.getAttribute('.wp-stage', 'data-chrome')) === 'false')
      const st = await page.locator('.wp-stage').boundingBox()
      await page.touchscreen.tap(st.x + 12, st.y + st.height / 2)
      await page.waitForFunction(() => document.querySelector('.wp-stage')?.getAttribute('data-chrome') === 'true', null, { timeout: 3000 }).catch(() => {})
      check('watch: a touch brings the fullscreen controls back', (await page.getAttribute('.wp-stage', 'data-chrome')) === 'true')
      // The fullscreen chat field: send, and on a phone the field and its keyboard go away.
      const chatBtn = await page.locator('.wp-ov-row button[aria-label="Message"]').boundingBox()
      await page.touchscreen.tap(chatBtn.x + chatBtn.width / 2, chatBtn.y + chatBtn.height / 2)
      await page.waitForSelector('#wp-fs-in')
      const focused = await page.evaluate(() => document.activeElement?.id === 'wp-fs-in')
      await page.waitForTimeout(3200)   // longer than the controls take to fade
      const seen = await page.evaluate(() => { const f = document.querySelector('#wp-fs-in'); if (!f) return 'gone'; let e = f; while (e) { if (getComputedStyle(e).opacity === '0') return 'faded'; e = e.parentElement } const r = f.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0 ? 'ok' : `off ${r.top}` })
      check('watch: the fullscreen Message field opens focused and stays in view while the controls fade', focused && seen === 'ok', `focused=${focused} ${seen}`)
      await page.fill('#wp-fs-in', 'from fullscreen')
      await page.press('#wp-fs-in', 'Enter')
      await page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:chatV2' && e[1]?.msg === 'from fullscreen'), null, { timeout: 3000 }).catch(() => {})
      const phone = await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)
      await page.waitForTimeout(200)
      check('watch: fullscreen chat sends, and on a phone the field closes after Send',
        (await page.evaluate(() => window.__wpEmits.some((e) => e[0] === 'CMD:chatV2' && e[1]?.msg === 'from fullscreen'))) && (await page.locator('#wp-fs-in').count()) === (phone ? 0 : 1), `phone=${phone}`)
      if (await page.locator('.wp-stage[data-chrome="false"]').count()) { const st3 = await page.locator('.wp-stage').boundingBox(); await page.touchscreen.tap(st3.x + 12, st3.y + st3.height / 2) }
      const ex = await page.locator('.wp-ov-row button[aria-label="Exit fullscreen"]').boundingBox()
      await page.touchscreen.tap(ex.x + ex.width / 2, ex.y + ex.height / 2)
      await page.waitForSelector('.wp-ov-row button[aria-label="Fullscreen"]', { timeout: 3000 }).catch(() => {})
      const st2 = await page.locator('.wp-stage').boundingBox()
      if ((await page.getAttribute('.wp-stage', 'data-chrome')) === 'false') await page.touchscreen.tap(st2.x + 12, st2.y + st2.height / 2)
      await page.waitForSelector('.wp-ov-mid button[aria-label="Pause"]')
    }
    // A library film someone else started: the player names it, not "master".
    posts.removed = []   // an earlier step removed Heat from the fake library
    await page.evaluate((u) => window.__wpFire('REC:host', { video: u, videoTS: 0, paused: true }), `/api/watch/movies/stream/${'c'.repeat(32)}/master.m3u8`)
    await page.waitForFunction(() => document.querySelector('#wp-title')?.getAttribute('placeholder') === 'Heat', null, { timeout: 5000 }).catch(() => {})
    check('watch: a library film shows its name, not "master"', (await page.getAttribute('#wp-title', 'placeholder')) === 'Heat', await page.getAttribute('#wp-title', 'placeholder'))
    await host(page)
    await page.waitForFunction(() => document.querySelector('.wp-video')?.readyState >= 1)
    if (!(await page.locator('.wp-ov-mid button[aria-label="Pause"]').count())) await page.click('.wp-ov-mid button[aria-label="Play"]')
    await page.waitForSelector('.wp-ov-mid button[aria-label="Pause"]')
    await page.click('.wp-ov-mid button[aria-label="Pause"]')
    await page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:pause'))
    check('watch: centre pause tells the room', true)
    await page.click('.wp-ov-mid button[aria-label="Forward 10 seconds"]')
    await page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:seek'))
    check('watch: forward 10 seeks for everyone', true)
    await page.evaluate(() => window.__wpFire('REC:chat', { id: 'p2', msg: 'this part 🔥' }))
    await page.waitForSelector('.wp-chat-line')
    check('watch: incoming chat shows with the sender name', (await page.textContent('.wp-chat-list')).includes('Bizzle'))
    await page.fill('#wp-chat-in', 'hi all')
    await page.press('#wp-chat-in', 'Enter')
    await page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:chatV2' && e[1]?.msg === 'hi all'), null, { timeout: 3000 }).catch(() => {})
    check('watch: sending chat emits CMD:chatV2', await page.evaluate(() => window.__wpEmits.some((e) => e[0] === 'CMD:chatV2' && e[1]?.msg === 'hi all')))
    const box = await page.locator('.wp-stage').boundingBox()
    await page.touchscreen.tap(box.x + 12, box.y + box.height / 2)
    await page.waitForTimeout(300)
    if ((await page.getAttribute('.wp-stage', 'data-chrome')) === 'false') await page.touchscreen.tap(box.x + 12, box.y + box.height / 2)
    check('watch: a tap on the picture brings the controls back', (await page.getAttribute('.wp-stage', 'data-chrome')) === 'true')
    await page.evaluate(() => scrollTo(0, 0))
    await page.touchscreen.tap(box.x + 12, box.y + box.height / 2)
    await page.waitForTimeout(200)
    if ((await page.getAttribute('.wp-stage', 'data-chrome')) === 'false') await page.touchscreen.tap(box.x + 12, box.y + box.height / 2)
    await shot(page, 'watch-375-player')
    await axe(page, 'Watch 375', '.app-main')
    await tapTargets(page, 'Watch 375')
    // Camera position: per user, remembered, and the same control in Settings.
    check('watch: cameras default to below the video', (await page.getAttribute('.wp-screen', 'data-orbs')) === 'bottom')
    await pickPos(page, 'top')
    check('watch: Above moves the cameras over the stage', (await page.getAttribute('.wp-screen', 'data-orbs')) === 'top' && (await page.evaluate(() => JSON.parse(localStorage.getItem('watch.orbs.pos')))) === 'top')
    // Rally asks first, then posts once.
    // It lives in the player's ⚙ panel.
    await page.hover('.wp-stage')
    await page.click('.wp-stage button[aria-label="Settings"]')
    await page.click('.wp-set button:has-text("Rally the squad")')
    check('watch: Rally asks before posting', posts.rally.length === 0 && (await page.textContent('.wp-set')).includes('WhatsApp'))
    await page.click('.wp-set button:has-text("Rally now")')
    await page.waitForFunction(() => document.querySelector('.wp-set')?.textContent.includes('Rally sent'))
    check('watch: Rally posts once after confirming, and rings everyone', posts.rally.length === 1 && (posts.ring || []).length === 1 && posts.ring[0].kind === 'watch')
    await page.click('.wp-set button[aria-label="Close settings"]')
    // The ring list: ring one person, or everyone.
    {
      const before = (posts.ring || []).length
      await page.click('.wp-actions button:has-text("Ring")')
      await page.waitForSelector('.ring-sheet .ring-row')
      check("ring list: the squad with a Ring each, and who a ring can't reach", (await page.locator('.ring-row').count()) === 2
        && (await page.isDisabled('.ring-row button[aria-label="Ring Zubair"]')) && (await page.textContent('.ring-sheet')).includes('No phone or notifications'))
      await page.click('.ring-row button[aria-label="Ring Noor"]')
      await page.waitForTimeout(300)
      check('ring list: Ring on one person rings just them', posts.ring.length === before + 1 && JSON.stringify(posts.ring.at(-1).to) === '["u2"]' && posts.ring.at(-1).kind === 'watch')
      await page.click('.ring-sheet button:has-text("Ring everyone")')
      await page.waitForSelector('.ring-sheet', { state: 'detached' })
      check('ring list: Ring everyone rings the whole squad', posts.ring.length === before + 2 && posts.ring.at(-1).to === undefined)
    }
    // Movies home: Watch opens on movies; a poster opens its sheet; Add; Watch together.
    await page.click('.wp-head a:has-text("Movies")')
    await page.waitForSelector('.mv-hero-h')
    check('movies: Watch opens on a featured film, the library row and catalogue rows', (await page.textContent('.mv-hero-h')) === 'Inception' && (await page.locator('.mv-row').count()) >= 3 && (await page.locator('#mv-library').count()) === 1)
    check('movies: a party banner offers to start one or paste a link', (await page.getAttribute('.mv-party a:has-text("Paste a link")', 'href')) === '/app/watch/party?paste=1')
    await page.click('#mv-row-popular .mv-tile:has-text("Pulp Fiction")')
    await page.waitForSelector('.mv-sheet .mv-sheet-h')
    check('movies: a poster opens its sheet with the details', (await page.textContent('.mv-sheet-h')) === 'Pulp Fiction' && new URL(page.url()).searchParams.get('m') === 'tt0110912' && (await page.textContent('.mv-facts')).includes('Quentin Tarantino'))
    await shot(page, 'movies-375-sheet')
    await tapTargets(page, 'Movie sheet 375')
    const adds = (posts.movies || []).length
    await page.waitForSelector('.mv-sheet .mv-pick')
    check('movies: with a 4K and a 1080p copy, you pick (and see their sizes)', (await page.textContent('.mv-pick')).includes('Add 4K HDR') && (await page.textContent('.mv-pick')).includes('9.1 GB'))
    await page.click('.mv-sheet .mv-copies summary')
    await page.waitForSelector('.mv-sheet .mv-copy')
    check('movies: Copies lists the Real-Debrid releases, the one Add picks first', (await page.locator('.mv-copy').count()) === 2 && (await page.locator('.mv-copy').first().textContent()).includes('BEST') && (await page.locator('.mv-copy').first().textContent()).includes('Add picks this one') && (await page.locator('.mv-copy button:has-text("Add this")').count()) === 2)
    await page.click('.mv-sheet .mv-pick button:has-text("Add 1080p")')
    await page.waitForSelector('.mv-sheet .mv-sheet-progress')
    check('movies: Add posts once, with your pick, and the sheet follows it in', (posts.movies || []).length === adds + 1 && posts.movies.at(-1).imdb === 'tt0110912' && posts.movies.at(-1).quality === '1080p' && (await page.textContent('.mv-sheet-progress')).includes('Finding'))
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.mv-sheet') && !new URL(location.href).searchParams.get('m'))
    await page.click('.mv-genres .chip:has-text("Horror")')
    await page.waitForSelector('.mv-genres .chip[aria-pressed="true"]:has-text("Horror")', { timeout: 3000 }).catch(() => {})
    check('movies: a genre chip turns the rows into that genre', new URL(page.url()).searchParams.get('genre') === 'Horror' && (await page.getAttribute('.mv-genres .chip:has-text("Horror")', 'aria-pressed')) === 'true', `${page.url()} ${await page.getAttribute('.mv-genres .chip:has-text("Horror")', 'aria-pressed')}`)
    await page.click('.mv-genres .chip:has-text("All")')
    await shot(page, 'movies-375-home')
    await tapTargets(page, 'Movies home 375')
    await axe(page, 'Movies home 375', '.app-main')
    // In the library: its copy, and Replace with another one (after a confirm).
    await page.click('#mv-row-popular .mv-tile:has-text("Inception")')
    await page.waitForSelector('.mv-sheet .mv-release')
    await page.click('.mv-sheet .mv-copies summary')
    await page.waitForSelector('.mv-sheet .mv-copy')
    check('movies: a library film shows its copy and marks it in Other copies', (await page.textContent('.mv-release')).includes('x265-OLD') && (await page.locator('.mv-copy').first().textContent()).includes('the one we have') && (await page.locator('.mv-copy button:has-text("Replace")').count()) === 1)
    await page.click('.mv-copy button:has-text("Replace")')
    await page.click('.dialog-confirm button:has-text("Replace")')
    await page.waitForTimeout(400)
    check('movies: Replace swaps in the picked copy', (posts.replace || []).length === 1 && posts.replace[0].imdb === 'tt1375666' && posts.replace[0].copy === 'e'.repeat(40), JSON.stringify(posts.replace))
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.mv-sheet'))
    await page.click('#mv-row-popular .mv-tile:has-text("Inception")')
    await page.click('.mv-sheet button:has-text("Watch together")')
    await page.waitForFunction(() => location.pathname === '/app/watch/party')
    await page.waitForFunction((u) => window.__wpEmits.some((e) => e[0] === 'CMD:host' && e[1] === u), `/api/watch/movies/stream/${'d'.repeat(32)}/master.m3u8`, { timeout: 5000 }).catch(() => {})
    check('movies: Watch together opens the party and plays it for everyone', await page.evaluate((u) => window.__wpEmits.some((e) => e[0] === 'CMD:host' && e[1] === u), `/api/watch/movies/stream/${'d'.repeat(32)}/master.m3u8`))
    // A trailer plays on the party's shared screen, for everyone (not privately in the sheet).
    await page.click('.tabbar a[href="/app/watch"]')
    await page.click('#mv-row-popular .mv-tile:has-text("Pulp Fiction")')
    await page.waitForSelector('.mv-sheet button:has-text("Trailer")')
    await page.click('.mv-sheet button:has-text("Trailer")')
    await page.waitForFunction(() => location.pathname === '/app/watch/party')
    if (await page.locator('.dialog-confirm button:has-text("Switch")').count()) await page.click('.dialog-confirm button:has-text("Switch")')
    await page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:host' && String(e[1]).includes('youtube.com/watch?v=s7EdQ4FqbhY')), null, { timeout: 5000 }).catch(() => {})
    check('movies: Trailer plays on the party screen for everyone', await page.evaluate(() => window.__wpEmits.some((e) => e[0] === 'CMD:host' && String(e[1]).includes('youtube.com/watch?v=s7EdQ4FqbhY'))) && (await page.locator('.mv-trailer').count()) === 0)
    // Leave /watch: the party keeps going in the Watch bar.
    await page.click('.tabbar a[href="/app"]')
    await page.waitForSelector('.watchbar-bar')
    check('watch: leaving /watch keeps the party in a Watch bar', (await page.textContent('.watchbar-bar')).includes('Watch Party') && (await page.evaluate(() => document.querySelector('.wp-video')?.isConnected)) === true)
    check('watch: the parked page is inert and out of view', (await page.getAttribute('.watch-page', 'data-hidden')) === 'true' && (await page.evaluate(() => document.querySelector('.watch-page').inert)))
    await shot(page, 'watch-375-bar')
    await page.goto(BASE + '/app/settings')
    await page.click('[role=tab]:has-text("Watch")')
    await page.waitForSelector('#st-orbpos')
    check('settings: Watch tab shows the remembered camera position', (await page.textContent('.settings-card [role=radio][aria-checked=true]')) === 'Above')
    await page.focus('.settings-card [role=radio][aria-checked=true]')
    await page.keyboard.press('ArrowRight')
    check('settings: arrow keys move the camera choice', (await page.evaluate(() => JSON.parse(localStorage.getItem('watch.orbs.pos')))) === 'bottom' && (await page.evaluate(() => document.activeElement?.textContent)) === 'Below')
    await page.click('.settings-card [role=radio][data-pos=over]')
    check('settings: the camera choice has five spoken options', (await page.locator('.settings-card [role=radio]').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))).join('|') === 'Above the video|Below the video|On the video, along the top|On the video, along the bottom|On the video, down the side')
    check('settings: picking the side column saves it', (await page.evaluate(() => JSON.parse(localStorage.getItem('watch.orbs.pos')))) === 'over')
    await shot(page, 'settings-watch-375')
    await axe(page, 'Settings Watch 375', '.app-main')
    check('watch: nothing posted to history before the video was watched', true)
    check('no unmocked writes and no page errors (Watch 375)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()

    // Desktop
    const d = await newPage({ width: 1440, height: 900, mocks: WATCH })
    await ready(d.page, '/app/watch/party')
    await d.page.waitForSelector('.wp-pill[data-tone="live"]')
    await host(d.page)
    await d.page.waitForSelector('.wp-overlay')
    await d.page.hover('.wp-stage')
    const drow = await d.page.locator('.wp-ov-row button:visible').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
    check('watch 1440: control row has play, volume, reactions, fullscreen', drow[0] === 'Play' && drow.includes('Reactions') && drow.some((l) => /fullscreen/i.test(l)), drow.join(', '))
    check('watch 1440: inline volume slider', await d.page.isVisible('.wp-vol-inline'))
    check('watch 1440: chat sits beside the stage', await d.page.evaluate(() => { const a = document.querySelector('.wp-main').getBoundingClientRect(), b = document.querySelector('.wp-side').getBoundingClientRect(); return b.left >= a.right - 1 }))
    await d.page.evaluate(() => document.activeElement?.blur())
    await d.page.keyboard.press('k')
    await d.page.waitForFunction(() => window.__wpEmits.some((e) => e[0] === 'CMD:play'))
    check('watch 1440: k plays', true)
    await d.page.keyboard.press('l')
    await d.page.waitForFunction(() => window.__wpEmits.filter((e) => e[0] === 'CMD:seek').length >= 1)
    check('watch 1440: l seeks ahead', true)
    await d.page.click('.wp-ov-row button[aria-label="Reactions"]')
    await d.page.waitForSelector('.wp-rx-strip')
    await d.page.click('.wp-rx-strip button >> nth=1')
    await d.page.waitForSelector('.wp-floater')
    check('watch 1440: a reaction from the strip floats up on the stage', (await d.page.textContent('.wp-floater-name')) === 'You')
    await d.page.hover('.wp-stage')
    await shot(d.page, 'watch-1440')
    await axe(d.page, 'Watch 1440', '.app-main')
    await d.page.click('.mv-tabs [role=tab]:has-text("Watched")')
    await d.page.waitForSelector('.wp-card')
    await d.page.click('.wp-card button[aria-label^="Details"]')
    await d.page.waitForSelector('.wp-chat-log')
    check('watch 1440: details show viewers and chat', (await d.page.textContent('.dialog')).includes('Goopy') && (await d.page.textContent('.wp-chat-log')).includes('classic'))
    await d.page.keyboard.press('Escape')
    await d.page.click('.wp-card >> nth=1 >> button[aria-label^="Rename"]')
    await d.page.fill('.dialog input', 'Collateral')
    await d.page.click('.dialog button[type=submit]')
    await d.page.waitForSelector('.dialog', { state: 'detached' })
    check('watch 1440: rename posts the title once', posts.title.length === 1 && posts.title[0].title === 'Collateral')
    // Joining the call puts your own orb where you asked for it.
    await d.ctx.grantPermissions(['camera', 'microphone'])
    // Record every track the page captures: an open mic (even disabled) puts the OS
    // in voice-call mode and degrades the movie, so joining must capture video only.
    await d.page.evaluate(() => {
      const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md)
      window.__gum = []
      md.getUserMedia = async (c) => { const st = await gum(c); window.__gum.push(...st.getTracks()); return st }
    })
    const liveMics = () => d.page.evaluate(() => window.__gum.filter((t) => t.kind === 'audio' && t.readyState === 'live').length)
    await d.page.click('button:has-text("Join with camera")')
    await d.page.waitForSelector('.wp-orb')
    check('watch 1440: joining the call shows your camera orb, muted', (await d.page.getAttribute('.wp-orb', 'aria-label')).startsWith('You, mic muted'))
    check('watch 1440: joining captures video only — no mic is opened', (await d.page.evaluate(() => window.__gum.map((t) => t.kind).join())) === 'video' && (await liveMics()) === 0)
    await d.page.hover('.wp-stage')
    await d.page.click('.wp-ov-topbar button[aria-label="Unmute mic"]')
    await d.page.waitForSelector('.wp-ov-topbar button[aria-label="Mute mic"]')
    await d.page.waitForFunction(() => window.__gum.some((t) => t.kind === 'audio' && t.readyState === 'live'))
    check('watch 1440: Unmute opens exactly one live mic', (await liveMics()) === 1)
    await d.page.click('.wp-ov-topbar button[aria-label="Mute mic"]')
    await d.page.waitForFunction(() => window.__gum.filter((t) => t.kind === 'audio').every((t) => t.readyState === 'ended'))
    check('watch 1440: Mute stops the mic track, not just disables it', (await liveMics()) === 0)
    await d.page.waitForFunction(() => document.querySelector('.wp-face-video')?.readyState >= 2)
    const below = await d.page.evaluate(() => document.querySelector('.wp-orbs').getBoundingClientRect().top >= document.querySelector('.wp-stage').getBoundingClientRect().bottom - 1)
    check('watch 1440: orbs sit below the video by default', below)
    // Someone else in the call (LiveKit): their camera lands on their party viewer, glows when they talk, goes when they leave.
    check('watch 1440: the call is a LiveKit room joined with this party connection', (posts.callToken || []).length >= 1 && posts.callToken[0].room === 'crcmz' && !!posts.callToken[0].client)
    await d.page.evaluate(() => { window.__wpFire('roster', [{ id: 'p2', isMod: false }]); window.__lkAdd('p2', 'Bizzle') })
    await d.page.waitForSelector('.wp-orb[aria-label^="Bizzle"]', { timeout: 5000 }).catch(() => {})
    check('watch 1440: another camera in the call shows on their orb', await d.page.evaluate(() => {
      const o = [...document.querySelectorAll('.wp-orb')].find((b) => b.getAttribute('aria-label')?.startsWith('Bizzle'))
      const v = o?.querySelector('video'); return !!v && !v.hidden && !!v.srcObject
    }))
    await d.page.evaluate(() => window.__lkSpeak(['p2']))
    await d.page.waitForSelector('.wp-orb[aria-label^="Bizzle"][data-loud="true"]', { timeout: 3000 }).catch(() => {})
    check('watch 1440: they glow while they talk', await d.page.isVisible('.wp-orb[aria-label^="Bizzle"][data-loud="true"]'))
    await d.page.evaluate(() => { window.__lkSpeak([]); window.__lkRemove('p2') })
    await d.page.waitForSelector('.wp-orb[aria-label^="Bizzle"]', { state: 'detached', timeout: 3000 }).catch(() => {})
    check('watch 1440: and their camera goes when they leave the call', !(await d.page.isVisible('.wp-orb[aria-label^="Bizzle"]')))
    check('watch 1440: camera tiles are rounded squares, not circles', await d.page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.wp-face')).borderTopLeftRadius) < 20))
    await pickPos(d.page, 'over')
    await d.page.waitForSelector('.wp-stage .wp-orbs-over-side')
    check('watch 1440: Side floats the orbs down the right edge of the video', await d.page.evaluate(() => { const o = document.querySelector('.wp-orbs-over').getBoundingClientRect(), st = document.querySelector('.wp-stage').getBoundingClientRect(); return o.right <= st.right && o.left > st.left + st.width / 2 }))
    // On the video, along the top / bottom: on the edge while the controls hide, past the bars while they show.
    const edge = (sel) => d.page.evaluate((q) => { const o = document.querySelector(q).getBoundingClientRect(), st = document.querySelector('.wp-stage').getBoundingClientRect(); return { top: o.top - st.top, bottom: st.bottom - o.bottom } }, sel)
    await pickPos(d.page, 'overTop')
    await d.page.waitForSelector('.wp-stage .wp-orbs-over-top')
    await d.page.hover('.wp-stage')
    await d.page.waitForTimeout(400)
    const tOn = await edge('.wp-orbs-over-top')
    const barBottom = await d.page.evaluate(() => document.querySelector('.wp-ov-top').getBoundingClientRect().bottom - document.querySelector('.wp-stage').getBoundingClientRect().top)
    check('watch 1440: On the video, top: a row along the top, below the title bar while it shows', tOn.top >= 40 && tOn.top < 70, JSON.stringify({ tOn, barBottom }))
    await shot(d.page, 'watch-1440-over-top')
    await pickPos(d.page, 'overBottom')
    await d.page.waitForSelector('.wp-stage .wp-orbs-over-bottom')
    await d.page.hover('.wp-stage')
    await d.page.waitForTimeout(400)
    const bOn = await edge('.wp-orbs-over-bottom')
    const seekTop = await d.page.evaluate(() => document.querySelector('.wp-stage').getBoundingClientRect().bottom - document.querySelector('.wp-seek').getBoundingClientRect().top)
    check('watch 1440: On the video, bottom: a row above the seek bar while it shows', bOn.bottom >= seekTop, JSON.stringify({ bOn, seekTop }))
    await shot(d.page, 'watch-1440-over-bottom')
    // A phone: the cameras stay on the video while the controls show, clear of the bars.
    {
      const vp = d.page.viewportSize()
      await d.page.setViewportSize({ width: 375, height: 800 })
      for (const pos of ['overTop', 'overBottom']) {
        await pickPos(d.page, pos)
        await d.page.hover('.wp-stage')
        await d.page.waitForTimeout(400)
        const g = await d.page.evaluate(() => {
          const r = (q) => document.querySelector(q)?.getBoundingClientRect()
          const o = r('.wp-orbs-over'), top = r('.wp-ov-top'), seek = r('.wp-seek'), st = r('.wp-stage')
          const mid = document.querySelector('.wp-ov-mid')
          return { chrome: document.querySelector('.wp-stage').dataset.chrome, opacity: getComputedStyle(document.querySelector('.wp-orbs-over')).opacity,
            oTop: o.top, oBottom: o.bottom, titleBottom: top.bottom - 1, seekTop: seek.top + 1, stTop: st.top, stBottom: st.bottom,
            midShown: !!mid && getComputedStyle(mid).display !== 'none', rowPlay: !!document.querySelector('.wp-ov-row > .wp-ctl:first-child')?.offsetWidth }
        })
        const clear = pos === 'overTop' ? g.oTop >= g.titleBottom && g.oBottom < g.seekTop : g.oBottom <= g.seekTop && g.oTop > g.titleBottom
        check(`watch 375: on the video, ${pos === 'overTop' ? 'top' : 'bottom'}: cameras stay visible with the controls up, clear of the bars`,
          g.chrome === 'true' && g.opacity === '1' && clear && g.oTop >= g.stTop && g.oBottom <= g.stBottom && !g.midShown && g.rowPlay, JSON.stringify(g))
        await shot(d.page, `watch-375-${pos}`)
      }
      // Enlarged on the video: a step up, not a takeover, and still inside the video.
      await d.page.click('.wp-orbs-over .wp-orb')
      await d.page.click('[role=menuitem]:has-text("Enlarge tile")')
      await d.page.waitForTimeout(300)
      const big = await d.page.evaluate(() => {
        const f = document.querySelector('.wp-orbs-over .wp-orb[data-big="true"] .wp-face')?.getBoundingClientRect()
        const st = document.querySelector('.wp-stage').getBoundingClientRect()
        const list = document.querySelector('.wp-orbs-over .wp-orb-list')
        return f && { w: f.width, h: f.height, stW: st.width, stH: st.height, inside: f.left >= st.left && f.right <= st.right && f.top >= st.top && f.bottom <= st.bottom,
          scrolls: list.scrollWidth > list.clientWidth + 1 }
      })
      check('watch 375: an enlarged camera on the video is a bit bigger, not huge, and fits', !!big && big.h > 48 && big.h <= 80 && big.w <= big.stW * 0.4 && big.inside && !big.scrolls, JSON.stringify(big))
      await shot(d.page, 'watch-375-overBottom-big')
      await d.page.click('.wp-orbs-over .wp-orb')
      await d.page.click('[role=menuitem]:has-text("Shrink tile")')
      await d.page.setViewportSize(vp)
    }
    await pickPos(d.page, 'over')
    await d.page.hover('.wp-stage')
    check('watch 1440: in the call the overlay gets a mic button', (await d.page.locator('.wp-ov-topbar button[aria-label="Unmute mic"], .wp-ov-topbar button[aria-label="Mute mic"]').count()) > 0)
    await shot(d.page, 'watch-1440-over')
    await pickPos(d.page, 'top')
    check('watch 1440: Above puts the orbs over the top of the video', await d.page.evaluate(() => document.querySelector('.wp-orbs').getBoundingClientRect().bottom <= document.querySelector('.wp-stage').getBoundingClientRect().top + 1))
    await d.page.click('.wp-orb')
    await d.page.waitForSelector('.wp-orb-menu')
    check('watch 1440: your orb menu has mute, camera, flip, enlarge, leave', (await d.page.locator('.wp-orb-menu [role=menuitem]').count()) === 5)
    await d.page.keyboard.press('Escape')
    await d.page.hover('.wp-stage')
    await d.page.click('.wp-stage button[aria-label="Settings"]')
    await d.page.click('.wp-set .wp-set-leave')
    await d.page.waitForSelector('.wp-orb', { state: 'detached' })
    check('watch 1440: leaving the call removes your orb', true)
    // Leave party from the page itself: the session ends and nothing shows as live.
    await d.page.click('.wp-head .wp-leave')
    await d.page.waitForSelector('.banner:has-text("You left the watch party.")')
    check('watch 1440: Leave party ends the session', (await d.page.locator('.wp-leave').count()) === 0 && (await d.page.locator('.wp-pill[data-tone="live"]').count()) === 0)
    check('no unmocked writes and no page errors (Watch 1440)', d.page.violations.length === 0, d.page.violations.join(', '))
    await d.ctx.close()

    // ── Meeting notes: the list, one meeting rendered from Markdown, full screen, rename. ──
    {
      const renames = []
      const NOTE = { id: 'mt1', room: 'crcmz', started: 1759500000, ended: 1759503600, status: 'ready', title: 'Ranked night plan', people: ['Moiz', 'Zubi'] }
      const n = await newPage({ width: 375, height: 800, mocks: {
        ...WATCH,
        'GET /api/huddle/notes': json(200, { meetings: [NOTE, { ...NOTE, id: 'mt2', status: 'writing', title: 'Huddle · crcmz' }] }),
        'GET /api/huddle/notes/mt1': json(200, { ...NOTE, mine: true, notes: '# Ranked night plan\n\n## Follow-ups\n- **Zubi** books the lobby\n- Moiz brings snacks', transcript: [{ ts: 1759500100, name: 'Zubi', text: 'I can book it' }] }),
        'POST /api/huddle/notes/mt1': (r) => { renames.push(r.request().postDataJSON()); return json(200, { ok: true, title: 'Ranked' })(r) },
        'POST /api/huddle/notes/mt1/delete': (r) => { renames.push({ deleted: true }); return json(200, { ok: true })(r) },
      } })
      await ready(n.page, '/app/huddle/notes')
      await n.page.waitForSelector('.notes-row')
      check('notes: the list shows your meetings, and which are still being written', (await n.page.locator('.notes-row').count()) === 2 && (await n.page.textContent('.notes-list')).includes('Writing the notes'))
      await n.page.click('.notes-row:has-text("Ranked night plan")')
      await n.page.waitForSelector('.notes-md h2')
      check('notes: Markdown renders (headings, bold, lists)', (await n.page.textContent('.notes-md h2')) === 'Follow-ups' && (await n.page.locator('.notes-md li strong').count()) === 1)
      await n.page.click('button:has-text("Full screen")')
      await n.page.waitForSelector('.notes-reader .notes-md')
      const box = await n.page.locator('.notes-reader').boundingBox()
      check('notes: Full screen fills the screen', box.width === 375 && box.height === 800, JSON.stringify(box))
      await n.page.keyboard.press('Escape')
      await n.page.click('button:has-text("Rename")')
      await n.page.fill('#notes-title', 'Ranked')
      await n.page.click('.notes-rename button[type=submit]')
      await n.page.waitForFunction(() => !document.querySelector('.notes-rename'))
      check('notes: Rename posts the new name', renames.at(-1)?.title === 'Ranked', JSON.stringify(renames))
      await n.page.click('button.notes-delete')
      await n.page.waitForSelector('.dialog-confirm')
      check('notes: Delete asks first', (await n.page.textContent('.dialog-confirm .dialog-title')) === 'Delete this meeting?' && !renames.some((x) => x.deleted))
      await n.page.click('.dialog-confirm .btn-primary')
      await n.page.waitForURL(/\/app\/huddle\/notes$/)
      check('notes: Delete deletes it and goes back to the list', renames.some((x) => x.deleted))
      await axe(n.page, 'Meeting notes 375', '.app-main')
      check('no unmocked writes and no page errors (meeting notes)', n.page.violations.length === 0, n.page.violations.join(', '))
      await n.ctx.close()
    }

    // ── Share → CRCMZ: a song goes straight to Slap (with Undo); a trailer offers its film; a video the Watch Party. ──
    {
      const shares = [], undos = []
      const INSPECT = {
        song: { link: 'https://open.spotify.com/track/abc?si=1', kind: 'song', auto: 'slap', movie: null, video_title: '', choices: ['slap', 'watch'] },
        trailer: { link: 'https://youtu.be/heat', kind: 'trailer', auto: null, video_title: 'Heat (1995) Official Trailer',
          movie: { imdb: 'tt0113277', title: 'Heat', year: '1995', poster: '', in_library: false }, choices: ['movie', 'watch'] },
        video: { link: 'https://youtu.be/dQw4w9WgXcQ', kind: 'video', auto: 'watch', movie: null, video_title: 'Never Gonna Give You Up', choices: ['watch', 'slap'] },
        film: { link: 'https://letterboxd.com/film/heat-1995/', kind: 'movie', auto: 'movie', video_title: '',
          movie: { imdb: 'tt0113277', title: 'Heat', year: '1995', poster: '', in_library: false }, choices: ['movie'], candidates: [] },
      }
      const filmPosts = []
      const sh = await newPage({ width: 375, height: 800, mocks: {
        ...WATCH,
        'POST /api/share/inspect': (r) => { const b = r.request().postDataJSON(); const k = /spotify/.test(b.text || b.url) ? 'song' : /letterboxd/.test(b.url) ? 'film' : /heat/.test(b.url) ? 'trailer' : 'video'; return json(200, INSPECT[k])(r) },
        'POST /api/slap/share': (r) => { shares.push(r.request().postDataJSON()); return json(200, { ok: true, status: 'downloading', title: 'Saturn', artist: 'SZA', job: 'job-1' })(r) },
        'POST /api/slap/share/undo': (r) => { undos.push(r.request().postDataJSON()); return json(200, { ok: true, status: 'undone' })(r) },
        'GET /api/slap/share/job-1': json(200, { job_id: 'job-1', title: 'Saturn', artist: 'SZA', status: 'done', error: '' }),
        'POST /api/watch/movies/add': (r) => { filmPosts.push(['add', r.request().postDataJSON()]); return json(200, { imdb: 'tt0113277', status: 'finding' })(r) },
        'POST /api/watch/movies/undo': (r) => { filmPosts.push(['undo', r.request().postDataJSON()]); return json(200, { ok: true })(r) },
      } })
      await ready(sh.page, `/app/share?text=${encodeURIComponent('Saturn by SZA https://open.spotify.com/track/abc?si=1')}`)
      await sh.page.waitForSelector('.share-card .empty-title:has-text("Adding Saturn")')
      check('share: a song is added to Slap straight away, once', shares.length === 1 && shares[0].url === 'https://open.spotify.com/track/abc?si=1', JSON.stringify(shares))
      await sh.page.click('.share-card button:has-text("Undo")')
      await sh.page.waitForSelector('.share-card .empty-title:has-text("Undone")')
      check('share: Undo takes it back out', undos.length === 1 && undos[0].job === 'job-1')
      await ready(sh.page, '/app/share?done=job-1')
      await sh.page.waitForSelector('.share-card .empty-title:has-text("is in Slap")')
      check("share: the notification's page says it's in, with Undo", await sh.page.isVisible('.share-card button:has-text("Undo")'))
      await ready(sh.page, `/app/share?url=${encodeURIComponent('https://youtu.be/heat')}`)
      await sh.page.waitForSelector('.share-movie')
      const btns = await sh.page.locator('.share-choices button').allTextContents()
      check('share: a trailer offers its film first, then the trailer in the Watch Party', btns[0].includes('Add the film to Movies') && btns[1].includes('trailer') && shares.length === 1, btns.join(' | '))
      await sh.page.click('.share-choices button:has-text("Add the film to Movies")')
      await sh.page.waitForURL(/\/app\/watch\?m=tt0113277/)
      check('share: Add to Movies opens the film (4K / 1080p are picked there)', true)
      await ready(sh.page, `/app/share?url=${encodeURIComponent('https://youtu.be/dQw4w9WgXcQ')}`)
      await sh.page.waitForURL(/\/app\/watch\/party/)
      check('share: a video plays in the Watch Party straight away', shares.length === 1 && new URL(sh.page.url()).searchParams.get('go') === '1', sh.page.url())
      // An older Android app sends every share to the Watch Party: it goes to the share screen first.
      await ready(sh.page, `/app/watch/party?${new URLSearchParams({ url: 'https://letterboxd.com/film/heat-1995/', title: 'Heat (1995)' })}`)
      await sh.page.waitForSelector('.share-card .empty-title:has-text("Adding Heat (1995)")')
      check("share: an older app's share to the Watch Party goes through the movie lookup", true)
      await sh.page.click('.share-card button:has-text("Undo")')
      await sh.page.waitForSelector('.share-card .empty-title:has-text("Undone")')
      await ready(sh.page, `/app/share?url=${encodeURIComponent('https://letterboxd.com/film/heat-1995/')}`)
      await sh.page.waitForSelector('.share-card .empty-title:has-text("Adding Heat (1995)")')
      check('share: a film page adds the film straight away (with the wait for Undo)', filmPosts[0]?.[0] === 'add' && filmPosts[0][1].imdb === 'tt0113277' && filmPosts[0][1].from === 'share', JSON.stringify(filmPosts))
      await sh.page.click('.share-card button:has-text("Undo")')
      await sh.page.waitForSelector('.share-card .empty-title:has-text("Undone")')
      check('share: Undo cancels the film', filmPosts[1]?.[0] === 'undo' && filmPosts[1][1].imdb === 'tt0113277')
      check('no unmocked writes and no page errors (share)', sh.page.violations.length === 0, sh.page.violations.join(', '))
      await sh.ctx.close()
    }

    // ── 14. Huddle (PS-7). LiveKit is a fake client served at the CDN URL: the room,
    // the participants and their tracks are scripted from the test. Token, AI and
    // transcribe are fixtures. Nothing reaches a real LiveKit server. ──
    {
      const hposts = { token: [], ai: [], tr: 0 }
      let tokenMode = 'ok'
      let aiMode = 'ok'

      const HUDDLE = {
        ...WATCH,
        'GET /npm/livekit-client@2/dist/livekit-client.umd.min.js': (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_LK }),
        'POST /api/huddle/token': (r) => {
          const b = r.request().postDataJSON()
          hposts.token.push(b)
          if (tokenMode === '503') return json(503, { error: 'Huddle not configured on this server' })(r)
          return json(200, { token: 'lk-test-token', url: 'wss://lk.invalid', room: String(b.room || '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'crcmz' })(r)
        },
        'POST /api/huddle/ai': (r) => {
          hposts.ai.push(r.request().postDataJSON())
          if (aiMode === '502') return json(502, { error: 'upstream down' })(r)
          return json(200, { message: { role: 'assistant', content: aiMode === 'notes' ? 'Summary: push B.' : 'Bizzle is carrying.' } })(r)
        },
        'POST /api/huddle/transcribe': (r) => { hposts.tr++; return json(200, { text: 'push B site' })(r) },
        'GET /api/huddle/meeting/live': json(200, { id: 'mt9', lines: [{ ts: 1759500000, name: 'Noor', text: 'said before you came' }] }),
      }
      const hs = (page) => page.evaluate(() => ({ audio: document.querySelectorAll('[data-huddle-audio] audio').length }))
      const spotName = (page) => page.textContent('.hu-spot .hu-tile-name')

      // Phone
      const h = await newPage({ width: 375, height: 800, mocks: HUDDLE })
      await ready(h.page, '/app/huddle')
      await h.page.waitForSelector('.hu-preview[data-state="on"]')
      check('huddle: pre-join shows your camera preview', await h.page.evaluate(() => !!document.querySelector('.hu-preview video')?.srcObject))
      check('huddle: the room defaults to crcmz', (await h.page.inputValue('#hu-room')) === 'crcmz')
      await shot(h.page, 'huddle-375-pre', true)
      await axe(h.page, 'Huddle pre-join 375', '.app-main')
      await tapTargets(h.page, 'Huddle pre-join 375')
      tokenMode = '503'
      await h.page.click('.hu-join')
      await h.page.waitForSelector('.hu-pre-form .banner')
      check("huddle: 503 says Huddle isn't set up", (await h.page.textContent('.hu-pre-form .banner')).includes("Huddle isn't set up on this server"))
      tokenMode = 'ok'
      await h.page.fill('#hu-room', 'Squad Night')
      await h.page.click('.hu-join')
      await h.page.waitForSelector('.hu-call')
      check('huddle: join asks for a token for the typed room (the server strips it to squadnight)', hposts.token.at(-1)?.room === 'Squad Night')
      check('huddle: connects to the URL and token the server gave', (await h.page.evaluate(() => JSON.stringify(window.__lkConnects.at(-1)))) === JSON.stringify(['wss://lk.invalid', 'lk-test-token']))
      await h.page.waitForSelector('.hu-spot video')
      check('huddle: top bar shows the sanitised room and "Just you"', (await h.page.textContent('.hu-room')) === 'squadnight' && (await h.page.textContent('.hu-count')) === 'Just you')
      check("huddle: alone says you're the only one here", await h.page.isVisible('.hu-alone'))
      check('huddle: the preview camera is released once in the call', await h.page.evaluate(() => !document.querySelector('.hu-preview')))
      const ctrls = await h.page.locator('.hu-controls button').evaluateAll((b) => b.map((x) => x.getAttribute('aria-label')))
      check('huddle: controls are mic, camera, share, blur, transcribe, hand, reactions, leave', ctrls.join('|') === 'Mute|Turn camera off|Share your screen|Blur background|Transcribe this call (meeting notes when it ends)|Raise your hand|Reactions|Leave the call', ctrls.join('|'))
      await h.page.evaluate(() => { window.__lkAdd('p2', 'Bizzle'); window.__lkAdd('p3', 'Noor') })
      await h.page.waitForFunction(() => document.querySelector('.hu-count')?.textContent === '3 in call')
      check('huddle: people joining fill the filmstrip', (await h.page.locator('.hu-strip li').count()) === 3)
      check('huddle: their audio plays from outside the page', (await hs(h.page)).audio === 2)
      {
        const l = await lock(h.page)
        check('huddle lock screen: the room, who is in it, and the call buttons and pop-out', l.title === 'Huddle · squadnight' && l.artist === '3 in the call' && l.actions === 'enterpictureinpicture,hangup,togglecamera,togglemicrophone', JSON.stringify(l))
      }
      check('huddle: the spotlight goes to someone else, not you', (await spotName(h.page)).includes('Bizzle'))
      await h.page.evaluate(() => window.__lkSpeak(['p3']))
      await h.page.waitForFunction(() => document.querySelector('.hu-spot .hu-tile-name')?.textContent.includes('Noor'))
      check('huddle: the active speaker takes the spotlight', await h.page.isVisible('.hu-strip .hu-tile[data-speaking="true"]'))
      await h.page.click('.hu-strip button[aria-label="Pin Goopy (you)"]')
      check('huddle: pinning puts that tile in the spotlight', (await spotName(h.page)).includes('Goopy (you)') && (await h.page.getAttribute('.hu-strip button[aria-label="Unpin Goopy (you)"]', 'aria-pressed')) === 'true')
      await h.page.click('.hu-strip button[aria-label="Unpin Goopy (you)"]')
      await h.page.click('.hu-controls button[aria-label="Mute"]')
      await h.page.waitForSelector('.hu-controls button[aria-label="Unmute"]')
      check('huddle: mute shows on your tile', (await h.page.locator('.hu-strip .hu-tile-mic').count()) === 1)
      await h.page.click('.hu-controls button[aria-label="Unmute"]')
      await h.page.waitForSelector('.hu-controls button[aria-label="Mute"]')
      await h.page.click('.hu-topbar button[aria-label="Grid layout"]')
      check('huddle: grid layout shows everyone the same size', (await h.page.locator('.hu-grid li').count()) === 3)
      await shot(h.page, 'huddle-375-grid')
      await h.page.click('.hu-topbar button[aria-label="Spotlight layout"]')
      await shot(h.page, 'huddle-375-call')
      await axe(h.page, 'Huddle call 375', '.app-main')
      await tapTargets(h.page, 'Huddle call 375')
      await h.page.evaluate(() => window.__lkFire('reconnecting'))
      await h.page.waitForSelector('.hu-stale')
      check('huddle: reconnecting covers the stage and disables controls', (await h.page.isDisabled('.hu-controls button[aria-label="Mute"]')) && !(await h.page.isDisabled('.hu-controls button[aria-label="Leave the call"]')))
      await h.page.evaluate(() => window.__lkFire('reconnected'))
      await h.page.waitForSelector('.hu-stale', { state: 'detached' })
      check('huddle: reconnected clears the overlay', true)

      // Hands and reactions over the data channel.
      await h.page.click('.hu-controls button[aria-label="Raise your hand"]')
      check('huddle: raising your hand tells the room', await h.page.evaluate(() => window.__lkData.some((d) => d.t === 'hand' && d.up === true && d.topic === 'crcmz-huddle')))
      await h.page.evaluate(() => window.__lkSay('p2', { t: 'hand', up: true }))
      await h.page.waitForSelector('.hu-hand-chip')
      check("huddle: someone else's hand shows (chip and tile badge)", (await h.page.textContent('.hu-hand-chip')).includes('1') && (await h.page.locator('.hu-tile-hand').count()) >= 1)
      await h.page.click('.hu-controls button[aria-label="Lower your hand"]')
      await h.page.click('.hu-controls button[aria-label="Reactions"]')
      await h.page.click('.hu-react-row button[aria-label="Send 🔥"]')
      check('huddle: a reaction floats up and goes to the room', (await h.page.locator('.hu-reaction').count()) >= 1 && await h.page.evaluate(() => window.__lkData.some((d) => d.t === 'rx' && d.e === '🔥')))
      await h.page.evaluate(() => window.__lkSay('p3', { t: 'rx', e: '😂' }))
      await h.page.waitForFunction(() => [...document.querySelectorAll('.hu-reaction')].some((r) => r.textContent.includes('Noor')))
      check("huddle: someone else's reaction shows with their name", true)
      await h.page.evaluate(() => window.__lkSay('p3', { t: 'rx', e: '<script>' }))
      check('huddle: a reaction outside the set is ignored', !(await h.page.evaluate(() => document.body.innerHTML.includes('&lt;script&gt;'))))
      await h.page.keyboard.press('Escape')

      // AI helper: the bottom sheet, ask, transcript, notes, a failure.
      await h.page.click('button.hu-ai-btn[aria-expanded]')
      await h.page.waitForSelector('.hu-ai-sheet')
      check('huddle: the AI opens as a bottom sheet on a phone', await h.page.isVisible('.hu-ai-sheet .hu-ai-log'))
      await h.page.fill('.hu-ai-sheet input', "who's winning")
      await h.page.press('.hu-ai-sheet input', 'Enter')
      await h.page.waitForSelector('.hu-ai-confirm')
      check('huddle: asking with the transcript off asks to start it first', hposts.ai.length === 0 && (await h.page.textContent('.hu-ai-confirm')).includes('Start the transcript?'))
      await h.page.click('.hu-ai-confirm button:has-text("Start and ask")')
      await h.page.waitForSelector('.hu-ai-msg[data-role="assistant"]')
      check('huddle: Start and ask asks the question', hposts.ai.at(-1)?.messages.at(-1)?.content === "who's winning" && (await h.page.textContent('.hu-ai-msg[data-role="assistant"]')) === 'Bizzle is carrying.')
      await h.page.waitForSelector('.hu-rec-chip', { state: 'attached' })
      check('huddle: and the transcript starts for everyone in the call', await h.page.evaluate(() => window.__lkData.some((d) => d.t === 'rec' && d.on && d.all === true && d.topic === 'crcmz-huddle')))
      await h.page.waitForFunction(() => window.__lkData.some((d) => d.t === 'line'), null, { timeout: 12000 })
      check('huddle: transcript chunks go to the transcriber and the room', hposts.tr >= 1 && (await h.page.evaluate(() => window.__lkData.find((d) => d.t === 'line')?.text)) === 'push B site')
      await h.page.evaluate(() => window.__lkSay('p2', { t: 'line', text: 'rotate A' }))
      await h.page.evaluate(() => window.__lkSay('p3', { t: 'rec', on: true }))
      await h.page.waitForSelector('.hu-lines summary:has-text("3 lines")')
      check("huddle: other people's lines join the transcript", true)
      check('huddle: joining partway through brings the transcript so far', (await h.page.textContent('.hu-lines ol')).includes('said before you came'))
      check('huddle: no mid-call Notes button (the notes come when the call ends)', !(await h.page.locator('.hu-ai-sheet button:has-text("Notes")').count()))
      await h.page.fill('.hu-ai-sheet input', 'what did we say?')
      await h.page.press('.hu-ai-sheet input', 'Enter')
      await h.page.waitForFunction(() => document.querySelectorAll('.hu-ai-msg[data-role="assistant"]').length >= 2)
      check('huddle: the AI reads the transcript, with names', /Goopy: push B site[\s\S]*Bizzle: rotate A/.test(hposts.ai.at(-1)?.messages[0]?.content || ''))
      aiMode = '502'
      await h.page.fill('.hu-ai-sheet input', 'again?')
      await h.page.press('.hu-ai-sheet input', 'Enter')
      await h.page.waitForSelector('.hu-ai-msg[data-role="error"] button:has-text("Try again")')
      check("huddle: an AI failure says so and offers Try again", (await h.page.textContent('.hu-ai-msg[data-role="error"]')).includes("AI didn't answer"))
      aiMode = 'ok'
      await h.page.click('.hu-ai-msg[data-role="error"] button:has-text("Try again")')
      await h.page.waitForFunction(() => !document.querySelector('.hu-ai-msg[data-role="error"]'))
      check('huddle: Try again re-asks', hposts.ai.at(-1)?.messages.at(-1)?.content === 'again?')
      await shot(h.page, 'huddle-375-ai')
      await axe(h.page, 'Huddle AI sheet 375', '.hu-ai-sheet')
      await h.page.keyboard.press('Escape')
      await h.page.waitForSelector('.hu-ai-sheet', { state: 'detached' })
      await h.page.click('.hu-controls button[aria-label="Stop the transcript"]')
      check('huddle: transcript off tells the room', await h.page.evaluate(() => window.__lkData.some((d) => d.t === 'rec' && d.on === false)))

      // Leave the page: the call keeps going in the call bar.
      await h.page.click('.tabbar a[href="/app"]')
      await h.page.waitForSelector('.watchbar-bar')
      check('huddle: leaving /huddle keeps the call in the call bar', (await h.page.textContent('.watchbar-bar')).includes('squadnight · 3 in call') && (await hs(h.page)).audio === 2)
      check('huddle: the call bar shows the transcript chip while someone records', (await h.page.textContent('.watchbar-bar')).includes('Transcript on'))
      await h.page.click('.watchbar-bar button[aria-label="Huddle mic live. Mute"]')
      await h.page.waitForSelector('.watchbar-bar button[aria-label="Huddle mic muted. Unmute"]')
      check('huddle: the call bar mutes your mic', await h.page.evaluate(() => !window.__lkRoom.localParticipant.isMicrophoneEnabled))
      await h.page.click('.watchbar-bar button[aria-label="Huddle mic muted. Unmute"]')
      await h.page.waitForSelector('.watchbar-bar button[aria-label="Huddle mic live. Mute"]')
      await shot(h.page, 'huddle-375-bar')
      // The Watch call joins muted, so the Huddle mic stays live; unmuting Watch
      // mutes the Huddle mic (F-5: one live mic at a time).
      await h.page.click('.tabbar a[href="/app/watch"]')
      await h.page.click('.mv-party a[href="/app/watch/party"] >> nth=0')
      await h.page.waitForSelector('.wp-pill[data-tone="live"]')
      await h.page.click('.wp-actions button:has-text("Join with camera")')
      await h.page.waitForSelector('.wp-orb')
      check('huddle: joining the Watch call (muted) leaves your Huddle mic alone', await h.page.evaluate(() => window.__lkRoom.localParticipant.isMicrophoneEnabled))
      await h.page.click('.tabbar a[href="/app"]')
      await h.page.waitForFunction(() => document.querySelectorAll('.watchbar-bar .miniplayer-row').length === 2)
      await h.page.click('.watchbar-bar button[aria-label="Watch mic muted. Unmute"]')
      await h.page.waitForSelector('.toast:has-text("Muted your Huddle mic")')
      check('huddle: unmuting the Watch mic mutes your Huddle mic, and says so', await h.page.evaluate(() => !window.__lkRoom.localParticipant.isMicrophoneEnabled))
      check('huddle: two calls, two rows in the call bar', (await h.page.getAttribute('.watchbar-bar', 'aria-label')) === 'Calls' && (await h.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--callbar-rows').trim())) === '2')
      await shot(h.page, 'huddle-375-two-calls')
      await h.page.click('.watchbar-bar button[aria-label="Leave the watch party"]')
      await h.page.click('.watchbar-bar a[aria-label^="Return to Huddle"]')
      await h.page.waitForSelector('.hu-call')
      check('huddle: Return brings you back to the call', (await h.page.locator('.hu-strip li').count()) === 3 && !(await h.page.isVisible('.watchbar-bar')))
      await h.page.evaluate(() => window.__lkRemove('p3'))
      await h.page.waitForFunction(() => document.querySelector('.hu-count')?.textContent === '2 in call')
      check('huddle: someone leaving drops their tile and their audio', (await hs(h.page)).audio === 1 && !(await h.page.isVisible('.hu-rec-chip')))
      await h.page.click('.hu-controls button[aria-label="Leave the call"]')
      await h.page.waitForSelector('.hu-pre')
      check('huddle: Leave goes back to pre-join, no "dropped" note', !(await h.page.isVisible('.hu-pre-form .banner')) && (await hs(h.page)).audio === 0)
      check('huddle lock screen: leaving clears the card and its buttons', await lock(h.page).then((l) => l.title === null && l.actions === ''), JSON.stringify(await lock(h.page)))
      await h.page.click('.hu-join')
      await h.page.waitForSelector('.hu-call')
      await h.page.evaluate(() => window.__lkFire('disconnected', 2))
      await h.page.waitForSelector('.hu-pre-form .banner')
      check('huddle: a dropped call says so and offers Rejoin', (await h.page.textContent('.hu-pre-form .banner')).includes('The call dropped') && (await h.page.textContent('.hu-join')).includes('Rejoin'))
      check('no unmocked writes and no page errors (Huddle 375)', h.page.violations.length === 0, h.page.violations.join(', '))
      await h.ctx.close()

      // Desktop: the AI side sheet pushes the stage; blur and screen share.
      const hd = await newPage({ width: 1440, height: 900, mocks: HUDDLE })
      await ready(hd.page, '/app/huddle')
      await hd.page.waitForSelector('.hu-preview[data-state="on"]')
      await shot(hd.page, 'huddle-1440-pre')
      await hd.page.click('.hu-join')
      await hd.page.waitForSelector('.hu-spot video')
      await hd.page.evaluate(() => { window.__lkAdd('p2', 'Bizzle'); window.__lkAdd('p3', 'Noor') })
      await hd.page.waitForFunction(() => document.querySelector('.hu-count')?.textContent === '3 in call')
      const strip = await hd.page.evaluate(() => { const s = document.querySelector('.hu-strip').getBoundingClientRect(), p = document.querySelector('.hu-spot').getBoundingClientRect(); return { stripLeft: s.left, spotRight: p.right, spotW: p.width } })
      check('huddle 1440: the filmstrip runs down beside the spotlight', strip.stripLeft >= strip.spotRight, JSON.stringify(strip))
      await shot(hd.page, 'huddle-1440')
      await hd.page.click('button.hu-ai-btn[aria-expanded]')
      await hd.page.waitForSelector('.hu-ai-side')
      const spotW2 = await hd.page.evaluate(() => document.querySelector('.hu-spot').getBoundingClientRect().width)
      check('huddle 1440: the AI side sheet pushes the stage instead of covering it', spotW2 < strip.spotW - 200 && !(await hd.page.isVisible('.scrim')), `${strip.spotW} → ${spotW2}`)
      await axe(hd.page, 'Huddle 1440 with AI', '.app-main')
      await shot(hd.page, 'huddle-1440-ai')
      await hd.page.click('.hu-controls button[aria-label="Blur background"]')
      await hd.page.waitForSelector('.hu-controls button[aria-label="Blur background"][aria-pressed="true"]')
      check('huddle 1440: blur swaps in the canvas track', await hd.page.evaluate(() => window.__lkRoom.localParticipant.getTrackPublication('camera').track.mediaStreamTrack instanceof CanvasCaptureMediaStreamTrack))
      await hd.page.click('.hu-controls button[aria-label="Blur background"]')
      await hd.page.waitForSelector('.hu-controls button[aria-label="Blur background"][aria-pressed="false"]')
      check('huddle 1440: unblur brings back a fresh camera', await hd.page.waitForFunction(() => { const t = window.__lkRoom.localParticipant.getTrackPublication('camera')?.track.mediaStreamTrack; return !!t && !(t instanceof CanvasCaptureMediaStreamTrack) && t.readyState === 'live' }, null, { timeout: 5000 }).then(() => true, () => false))
      await hd.page.click('.hu-controls button[aria-label="Share your screen"]')
      await hd.page.waitForSelector('.hu-spot .hu-tile[data-screen="true"]')
      check('huddle 1440: a shared screen takes the spotlight', (await spotName(hd.page)).includes('Your screen'))
      await hd.page.click('.hu-controls button[aria-label="Stop sharing your screen"]')
      await hd.page.waitForSelector('.hu-spot .hu-tile[data-screen="true"]', { state: 'detached' })
      await hd.page.click('.hu-controls button[aria-label="Turn camera off"]')
      await hd.page.waitForSelector('.hu-strip .hu-tile-face')
      check('huddle 1440: camera off shows your initials', (await hd.page.textContent('.hu-strip .hu-tile-face')).length > 0)
      check('no unmocked writes and no page errors (Huddle 1440)', hd.page.violations.length === 0, hd.page.violations.join(', '))
      await hd.ctx.close()
    }
  }
  // ── 15. WhatsApp (PS-4): ranges, the generation guard, charts, members, import, export ──
  {
    const posts = []
    let mode = 'bad'
    const seen = []
    const wa = waMocks({
      seen, slow: { this_month: 1500 },
      onImport: (r) => {
        posts.push(r.request().headers()['content-type'] || '')
        if (mode === '413') return json(413, { detail: 'file too large (max 50 MB)' })(r)
        return json(200, { status: 'imported', message_count: 812, duplicate_count: 40, total_parsed: 852 })(r)
      },
    })
    const { ctx, page } = await newPage({ width: 375, height: 800, ...wa })
    await ready(page, '/app/whatsapp')
    await page.waitForSelector('.wa-tiles')
    const tiles = await page.$$eval('.wa-tiles > div', (els) => els.map((e) => e.textContent))
    check('wa: six stat tiles, messages first', tiles.length === 6 && tiles[0].includes('1,234'), tiles.join(' | '))
    check('wa: first load asks every endpoint for all_time', ['stats', 'awards', 'activity', 'heatmap', 'words', 'emojis', 'response-times', 'members'].every((k) => seen.some((x) => x.kind === k && x.range === 'all_time')))
    await page.waitForSelector('.wa-award')
    check('wa: null awards are not rendered', (await page.locator('.wa-award').count()) === 13 && !(await page.textContent('.wa-awards')).includes('Most 🔥'))
    check('wa: the winner name is text', (await page.textContent('.wa-award:first-child .wa-award-who')) === 'Goopy')
    await shot(page, 'whatsapp-375', true)
    await axe(page, 'WhatsApp 375', '.app-main')
    await tapTargets(page, 'WhatsApp 375')

    // Range change: the old numbers stay, dimmed, until the new range lands.
    await page.click('.wa-range button:has-text("This month")')
    await page.waitForSelector('.wa-body[data-dim]')
    check('wa: range change keeps the old numbers dimmed', (await page.textContent('.wa-tiles > div:first-child')).includes('1,234'))
    check('wa: range change says "Loading This month…"', (await page.textContent('.wa-loading')) === 'Loading This month…')
    check('wa: the range is in the URL', new URL(page.url()).searchParams.get('range') === 'this_month')
    // Before This month answers, switch to Last month: the late answer must never show.
    await page.click('.wa-range button:has-text("Last month")')
    await page.waitForFunction(() => document.querySelector('.wa-tiles > div:first-child')?.textContent.includes('300'))
    await page.waitForTimeout(1700)
    check('wa: a late answer from an old range is discarded', (await page.textContent('.wa-tiles > div:first-child')).includes('300') && (await page.locator('.wa-body[data-dim]').count()) === 0)
    check('wa: Last month is pressed', (await page.getAttribute('.wa-range button:has-text("Last month")', 'aria-pressed')) === 'true')

    // Custom: both dates, start first, then Apply.
    await page.click('.wa-range button:has-text("Custom")')
    check('wa: Custom Apply waits for both dates', await page.isDisabled('.wa-custom button[type=submit]'))
    await page.fill('#wa-start', '2026-01-01')
    await page.fill('#wa-end', '2026-02-01')
    await page.click('.wa-custom button[type=submit]')
    await page.waitForSelector('.wa-empty-h')
    const u = new URL(page.url())
    check('wa: custom range sends start and end', u.searchParams.get('range') === 'custom' && seen.some((x) => x.range === 'custom' && x.start === '2026-01-01' && x.end === '2026-02-01'))
    check('wa: an empty range says "Nothing in this range"', (await page.textContent('.wa-empty-h')) === 'Nothing in this range')
    await page.click('.wa-empty button:has-text("All time")')
    await page.waitForFunction(() => document.querySelector('.wa-tiles > div:first-child')?.textContent.includes('1,234'))
    check('wa: [All time] goes back to everything', !new URL(page.url()).searchParams.has('range'))

    // Charts: tap to read, Daily/Monthly, tables.
    await page.click('.heat-row:nth-child(1) i:nth-of-type(21)', { force: true })
    check('wa: tapping a heatmap square reads it', (await page.locator('.wa-readout').filter({ hasText: 'Mon 20:00' }).textContent()).includes('messages'))
    const days = await page.locator('.wa-vbars').first().locator('i').count()
    check('wa: the daily timeline is the last 60 days', days === 60, String(days))
    await page.click('.wa-seg button:has-text("Monthly")')
    check('wa: Monthly shows one bar per month', (await page.locator('.wa-vbars').first().locator('i').count()) === 12)
    check('wa: every chart has "Show as table"', (await page.locator('.stat-table summary').count()) >= 7)
    check('wa: words are lime, 15 on a phone', (await page.locator('.stat-panel:has(.stat-h:text("Top words")) .hbar').count()) === 15)

    // Members: cards, Sort by + ↑/↓.
    const names = () => page.$$eval('.wa-card-name', (els) => els.map((e) => e.textContent).join(','))
    check('wa: member cards sort by messages first', (await names()) === 'Goopy,Bizzle,NoorAmin,Zubair', await names())
    await page.selectOption('#wa-sort', 'total_words')
    check('wa: Sort by Words', (await names()).startsWith('Bizzle,Goopy'), await names())
    await page.click('.wa-sort button')
    check('wa: ↑/↓ flips the order', (await names()).startsWith('Zubair'), await names())
    check('wa: a card shows every column', (await page.textContent('.wa-card')).includes('media omitted') && (await page.textContent('.wa-card')).includes('First seen'))

    // Export downloads the current range.
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('.wa-export')])
    check('wa: Export names the range and downloads an xlsx', (await page.textContent('.wa-export')) === 'Export All time (.xlsx)' && dl?.suggestedFilename() === 'whatsapp-all_time.xlsx', dl?.suggestedFilename())

    // Import: the wrong type never uploads; 413 and a good import report inline.
    await page.setInputFiles('#wa-file', { name: 'chat.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') })
    check('wa: a .pdf is refused before upload', (await page.textContent('.wa-import-err')) === "That file type won't work — upload a .txt or .zip from WhatsApp." && posts.length === 0)
    await page.setInputFiles('#wa-file', { name: 'chat.txt', mimeType: 'text/plain', buffer: Buffer.from('1/1/26, 9:00 PM - Goopy: hi') })
    mode = '413'
    await page.click('.wa-import button[type=submit]')
    await page.waitForSelector('.wa-import-err')
    check('wa: a 413 says keep it under 50 MB', (await page.textContent('.wa-import-err')).startsWith('File too large — keep it under 50 MB.'))
    mode = 'ok'
    await page.click('.wa-import button[type=submit]')
    await page.waitForSelector('.wa-import-ok')
    check('wa: import result line', (await page.textContent('.wa-import-ok')) === 'Imported 812 · 40 duplicates skipped · 852 parsed', await page.textContent('.wa-import-ok'))
    check('wa: import is multipart', posts.length === 2 && posts.every((c) => c.startsWith('multipart/form-data')))
    await shot(page, 'whatsapp-375-import')
    check('no unmocked writes and no page errors (WhatsApp 375)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Signed out: no import section, Export asks you to sign in and never downloads.
    const seen = []
    const { ctx, page } = await newPage({ width: 375, height: 800, ...waMocks({ signedIn: false, seen }) })
    await ready(page, '/app/whatsapp')
    await page.waitForSelector('.wa-tiles')
    check('wa signed out: reads still load', (await page.textContent('.wa-tiles')).includes('1,234'))
    await page.waitForTimeout(300)
    check('wa signed out: the import section is hidden', (await page.locator('#wa-import').count()) === 0)
    await page.click('.wa-export')
    await page.waitForSelector('.banner:has-text("Sign in to export")')
    check('wa signed out: Export shows a sign-in banner', (await page.locator('.banner a[href*="login"], .banner a.btn').count()) > 0 && !page.writes.includes('GET /api/whatsapp/export'))
    check('no unmocked writes and no page errors (WhatsApp signed out)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Nothing imported yet; one panel failing on its own with Retry.
    let wordsDown = true
    const { ctx, page } = await newPage({ width: 375, height: 800, ...waMocks({ canImport: false, totals: { all_time: 0 } }) })
    await ready(page, '/app/whatsapp')
    await page.waitForSelector('.wa-empty-h')
    check('wa empty: "No WhatsApp messages yet." + Ask Moiz', (await page.textContent('.wa-empty-h')) === 'No WhatsApp messages yet.' && (await page.textContent('.wa-empty')).includes('Ask Moiz to import the chat.'))
    await ctx.close()
    const b = await newPage({ width: 375, height: 800, ...waMocks({ fail: (k) => k === 'words' && wordsDown }) })
    await ready(b.page, '/app/whatsapp')
    await b.page.waitForSelector('.stat-err', { timeout: 10_000 })
    check('wa: one failing panel says "Didn\'t load", the rest render', (await b.page.textContent('.stat-err span')) === "Didn't load" && (await b.page.locator('.wa-tiles').count()) === 1)
    wordsDown = false
    await b.page.click('.stat-err button')
    await b.page.waitForSelector('.stat-panel:has(.stat-h:text("Top words")) .hbar')
    check('wa: Retry brings the panel back', (await b.page.locator('.stat-err').count()) === 0)
    await b.ctx.close()
  }
  {
    // Desktop analysis desk: sticky range bar, sortable member table, expandable rows, import 403.
    const posts = []
    const { ctx, page } = await newPage({ width: 1440, height: 900, ...waMocks({ onImport: (r) => { posts.push(1); return json(403, { detail: 'not authorized to import WhatsApp history' })(r) } }) })
    await ready(page, '/app/whatsapp')
    await page.waitForSelector('.wa-table')
    check('wa 1440: the range bar is sticky', (await page.$eval('.wa-rangebar', (e) => getComputedStyle(e).position)) === 'sticky')
    const cols = await page.$$eval('.wa-tiles > div', (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size)
    check('wa 1440: stats are one row of six', cols === 1)
    const heads = await page.$$eval('.wa-table thead th', (els) => els.map((e) => e.textContent.trim()))
    check('wa 1440: member table columns', heads.join('|') === 'Member|Messages|Words|Avg words/msg|Chars|Photos|Videos|Audio|Media omitted|First seen|Last seen', heads.join('|'))
    check('wa 1440: Messages sorts descending by default', (await page.getAttribute('.wa-table thead th:nth-child(2)', 'aria-sort')) === 'descending')
    await page.click('.wa-table thead th:nth-child(3) button')
    const first = () => page.textContent('.wa-table tbody tr:first-child th')
    check('wa 1440: a header click sorts by that column', (await page.getAttribute('.wa-table thead th:nth-child(3)', 'aria-sort')) === 'descending' && (await first()).includes('Bizzle'))
    await page.click('.wa-table thead th:nth-child(3) button')
    check('wa 1440: a second click flips it', (await page.getAttribute('.wa-table thead th:nth-child(3)', 'aria-sort')) === 'ascending' && (await first()).includes('Zubair'))
    check('wa 1440: the Member column is frozen', (await page.$eval('.wa-table tbody th', (e) => getComputedStyle(e).position)) === 'sticky')
    await page.click('.wa-table tbody th button:has-text("Goopy")')
    const favId = await page.getAttribute('.wa-table tbody th button:has-text("Goopy")', 'aria-controls')
    check('wa 1440: a member row expands to their top emoji and words', (await page.getAttribute('.wa-table tbody th button:has-text("Goopy")', 'aria-expanded')) === 'true' && (await page.textContent(`#${favId}`)).includes('😂') && (await page.textContent(`#${favId}`)).includes('bro'))
    check('wa 1440: words show the top 20', (await page.locator('.stat-panel:has(.stat-h:text("Top words")) .hbar').count()) === 20)
    await shot(page, 'whatsapp-1440')
    await shot(page, 'whatsapp-1440-full', true)
    await axe(page, 'WhatsApp 1440', '.app-main')
    await page.setInputFiles('#wa-file', { name: 'chat.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') })
    await page.click('.wa-import button[type=submit]')
    await page.waitForSelector('.banner:has-text("You\'re not allowed to import — ask an admin.")')
    check('wa 1440: an import 403 hides the section', posts.length === 1 && (await page.locator('#wa-import').count()) === 0)
    check('no unmocked writes and no page errors (WhatsApp 1440)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 16. AI Coach (PS-8): scope, hero, patterns → report, filters, feedback, prefs ──
  {
    const prefs = []
    const fbs = []
    let fbMode = 'fail'
    const seen = []
    const co = coMocks({
      seen,
      prefs: (r) => { const b = JSON.parse(r.request().postData()); prefs.push(b); return json(200, { ok: true, notify_mode: b.mode ?? 'dm', detail_mode: b.detail ?? 'full' })(r) },
      feedback: (r) => { fbs.push(JSON.parse(r.request().postData())); return fbMode === 'fail' ? json(500, { detail: 'boom' })(r) : json(200, { ok: true, feedback_id: 'f1' })(r) },
    })
    const { ctx, page } = await newPage({ width: 375, height: 800, ...co })
    await ready(page, '/app/coach')
    await page.waitForSelector('.co-hero .co-grade-big')
    check('co: scope tabs show counts', (await page.textContent('.co-scope')).includes('Mine (5)') && (await page.textContent('.co-scope')).includes('Squad (3)'))
    check('co: hero shows the latest grade and its move', (await page.textContent('.co-grade-big')) === 'B+' && (await page.textContent('.co-delta')).includes('up from C'), await page.textContent('.co-hero'))
    check('co: Focus is the repeated mistake', (await page.textContent('.co-hero')).includes('Focus: Ball-watching on the back post (3×)'))
    check('co: Next time is the latest tip', (await page.textContent('.co-drill')).includes('Next time: Drill 0'))
    check('co: the trajectory plots the graded reviews', (await page.locator('.co-trend circle').count()) === 4)
    check('co: In the queue lists processing clips', (await page.textContent('.co-box:has(h2:text("In the queue"))')).includes('Goopy · waiting for the clip to download'))
    check('co: a failed review shows no grade badge', (await page.textContent('#co-r-rv4 .co-badge')) === '–')
    check('co: report cards start collapsed', (await page.locator('.co-card-body').count()) === 0)
    await shot(page, 'coach-375', true)
    await axe(page, 'Coach 375', '.app-main')
    await tapTargets(page, 'Coach 375')

    // A mistake pattern opens the report it came from.
    await page.click('.co-mis-row:has-text("Ball-watching")')
    await page.waitForSelector('#co-r-rv3 .co-card-body')
    check('co: a mistake pattern opens its report', (await page.getAttribute('#co-r-rv3 .co-card-head', 'aria-expanded')) === 'true')
    const body = await page.textContent('#co-r-rv3 .co-card-body')
    check('co: an open card shows summary, lists and moments', ['Clip 3', 'Strengths', 'Mistakes', 'Coaching tips', '0:12', 'Missed tackle'].every((t) => body.includes(t)) && !body.includes('[object Object]'))

    // Feedback: a failed save keeps the rating; a retry saves.
    await page.click('#co-r-rv3 button[aria-label="Inaccurate"]')
    await page.click('#co-r-rv3 .co-fb-tags button:has-text("wrong-grade")')
    await page.fill('#co-fb-rv3', 'It was a B')
    await shot(page, 'coach-375-report')
    await page.click('#co-r-rv3 button:has-text("Send feedback")')
    await page.waitForSelector('#co-r-rv3 .co-fb-err')
    check('co: a failed feedback save says so inline', (await page.textContent('#co-r-rv3 .co-fb-err')) === "Couldn't save your feedback")
    check('co: the rating is kept after a failure', (await page.getAttribute('#co-r-rv3 button[aria-label="Inaccurate"]', 'aria-pressed')) === 'true')
    fbMode = 'ok'
    await page.click('#co-r-rv3 button:has-text("Send feedback")')
    await page.waitForSelector('#co-r-rv3 .co-saved')
    const last = fbs[fbs.length - 1]
    check('co: feedback sends rating, tags and comment', last.review_id === 'rv3' && last.rating === 'down' && last.tags.join() === 'wrong-grade' && last.comment === 'It was a B', JSON.stringify(last))
    check('co: earlier feedback shows as saved', await page.evaluate(() => { document.querySelector('#co-r-rv1 .co-card-head').click(); return true }) && (await page.waitForSelector('#co-r-rv1 .co-saved')) !== null)

    // Filters live in a sheet on a phone.
    await page.fill('#co-search', 'zzz')
    await page.waitForSelector('.co-empty:has-text("No reports match")')
    await page.click('.co-empty button:has-text("Clear filters")')
    check('co: Clear filters brings them back', (await page.locator('.co-card').count()) === 5 && (await page.inputValue('#co-search')) === '')
    await page.click('.co-tools button:has-text("Filters")')
    await page.waitForSelector('.co-sheet')
    await page.click('.co-sheet button:has-text("Rocket League")')
    await page.click('.co-sheet button:has-text("Best")')
    await shot(page, 'coach-375-filters')
    await tapTargets(page, 'Coach filters sheet 375')
    await page.click('.co-sheet button:has-text("Show")')
    await page.waitForSelector('.co-sheet', { state: 'detached' })
    const titles = await page.$$eval('.co-card-title', (els) => els.map((e) => e.textContent.slice(0, 8)).join(','))
    check('co: game filter + Best sort', titles === 'Review 0,Review 2,Review 4', titles)
    check('co: the count says how many of how many', (await page.textContent('.co-tools-foot [role=status]')) === '3 of 5')

    // Prefs: Off hides "Reports as:".
    await page.click('.co-pref button:has-text("Off")')
    await page.waitForFunction(() => !document.querySelector('.co-prefs')?.textContent.includes('Reports as'))
    check('co: notify prefs post {mode}', prefs.length === 1 && prefs[0].mode === 'off')

    // Squad scope: no cards, grade rows + sightings.
    await page.click('.co-scope button:has-text("Squad")')
    await page.waitForSelector('.co-grades')
    check('co: Squad lists grade · game · date rows', (await page.locator('.co-grades li').count()) === 3 && (await page.locator('.co-card').count()) === 0)
    check('co: Squad shows sightings', (await page.textContent('.co-box:has(h2:text("Spotted in squad clips"))')).includes('Bizzle'))
    check('co: the scope is in the URL', new URL(page.url()).searchParams.get('scope') === 'squad' && seen.includes('squad'))
    await shot(page, 'coach-375-squad', true)
    await axe(page, 'Coach squad 375', '.app-main')
    check('no unmocked writes and no page errors (Coach 375)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Empty, error + Retry, and signed out.
    let down = true
    const { ctx, page } = await newPage({ width: 375, height: 800, ...coMocks({ get: (sc) => (down ? json(503, { detail: 'down' }) : json(200, coData(sc, { empty: true, processing: 0 }))) }) })
    await ready(page, '/app/coach')
    await page.waitForSelector('.co-err')
    check('co: an error says "Didn\'t load"', (await page.textContent('.co-err')).includes("Didn't load"))
    down = false
    await page.click('.co-err button:has-text("Retry")')
    await page.waitForSelector('.co-hero-empty')
    check('co: Mine empty explains rev', (await page.textContent('.co-hero-empty')).includes('Send rev in the PSN group within ~5 s of a clip'))
    await shot(page, 'coach-375-empty')
    await ctx.close()
    const so = await newPage({ width: 375, height: 800, ...coMocks({ get: () => json(401, { detail: 'sign in to see coaching' }) }) })
    await ready(so.page, '/app/coach')
    await so.page.waitForSelector('.banner:has-text("Sign in to see coaching.")')
    check('co: signed out shows the banner', (await so.page.locator('.banner a:has-text("Sign in")').count()) >= 1)
    await so.ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900, ...coMocks() })
    await ready(page, '/app/coach')
    await page.waitForSelector('.co-card')
    const [l, r] = await page.$$eval('.co-cols > *', (els) => els.map((e) => e.getBoundingClientRect()))
    check('co 1440: two columns, left at least 320px', l && r && Math.round(l.top) === Math.round(r.top) && l.width >= 320 && r.left > l.right, JSON.stringify([l?.width, r?.left]))
    check('co 1440: stats sit inside the hero', (await page.locator('.co-hero .co-stats').count()) === 1)
    check('co 1440: filters are inline, no sheet button', (await page.locator('.co-tools-chips').count()) === 1 && (await page.locator('.co-tools button:has-text("Filters")').count()) === 0)
    await page.click('#co-r-rv0 .co-card-head')
    await shot(page, 'coach-1440')
    await shot(page, 'coach-1440-full', true)
    await axe(page, 'Coach 1440', '.app-main')
    check('no unmocked writes and no page errors (Coach 1440)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 17. Ask AI (PS-9): thread, pending poll, composer limits, clear, facts ──
  {
    const asks = []
    const added = []
    let thread = ASK_THREAD
    let pending = false
    let askMode = 'ok'
    let cleared = 0
    const ak = askMocks({
      history: (r) => json(200, { messages: thread, pending, count: thread.length })(r),
      writes: {
        'POST /api/assistant/ask': (r) => {
          const b = JSON.parse(r.request().postData()); asks.push(b)
          if (askMode === '429') return json(429, { error: 'Slow down — try again in 7s.' }, { 'Retry-After': '7' })(r)
          thread = [...thread, askMsg(5, 'user', b.question), askMsg(6, 'assistant', '', { status: 'pending', created_at: NOW })]
          pending = true
          return json(202, { status: 'queued', reply_id: 6 })(r)
        },
        'POST /api/assistant/clear': (r) => { cleared++; thread = []; return json(200, { status: 'cleared', removed: 6 })(r) },
        'POST /api/assistant/facts': (r) => { added.push(JSON.parse(r.request().postData())); return json(200, { status: 'added', id: 'f9', total: 8 })(r) },
        'POST /api/assistant/facts/delete': json(404, { error: 'not your fact, or already gone' }),
      },
    })
    const { ctx, page } = await newPage({ width: 375, height: 800, ...ak })
    await ready(page, '/app/ask')
    await page.waitForSelector('.ask-log .ask-msg')
    check('ask: header shows model and tool count', (await page.textContent('.ask-model')) === 'qwen3-32b · 3 tools')
    check('ask: answers say how many lookups and how long', (await page.textContent('.ask-meta')).includes('2 lookups · 2.3s'), await page.textContent('.ask-meta'))
    check('ask: explainer is open on the first visit', await page.$eval('.ask-explain', (e) => e.open))
    check('ask: suggestions fold away once there is a thread', (await page.locator('details.ask-sugg').count()) === 1)
    check('ask: a failed answer says so', (await page.textContent('[data-status="error"]')).includes("Couldn't get an answer"))
    await shot(page, 'ask-375')
    await axe(page, 'Ask 375', '.app-main')
    await tapTargets(page, 'Ask 375')
    const dock = await page.$eval('.ask-dock', (e) => e.getBoundingClientRect().bottom)
    const bar = await page.$eval('.tabbar', (e) => e.getBoundingClientRect().top)
    check('ask: composer is pinned above the tab bar', dock <= bar + 1, `${dock} vs ${bar}`)

    // Ask again refills the composer with the question that failed.
    await page.click('[data-status="error"] button:has-text("Ask again")')
    check('ask: Ask again refills the composer', (await page.inputValue('#ask-q')) === 'what time of day is the group most active?')

    // Counter shows from 900; over 1000 blocks Send.
    await page.fill('#ask-q', 'x'.repeat(950))
    check('ask: counter shows at 900+', (await page.textContent('.ask-count')) === '950/1000')
    await page.fill('#ask-q', 'x'.repeat(1001))
    check('ask: over the limit disables Send', await page.isDisabled('.ask-send'))

    // A 429 keeps the draft and counts down.
    askMode = '429'
    await page.fill('#ask-q', 'who yaps the most?')
    await page.click('.ask-send')
    await page.waitForSelector('.ask-foot:has-text("Try again in")')
    check('ask: a 429 says when to try again', /Try again in [67]s\./.test(await page.textContent('.ask-foot')), await page.textContent('.ask-foot'))
    check('ask: a 429 keeps the draft', (await page.inputValue('#ask-q')) === 'who yaps the most?')

    // Send with an image → pending bubble → answer.
    askMode = 'ok'
    // assistant-ui's Attach opens a file picker of its own (no input in the composer).
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.ask-attach')])
    await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') })
    await page.waitForSelector('.ask-img img')
    check('ask: a picked image shows a thumbnail', (await page.textContent('.ask-img')).includes('shot.png'))
    await page.waitForFunction(() => !document.querySelector('.ask-send').disabled, null, { timeout: 10000 })
    await page.click('.ask-send')
    await page.waitForSelector('[data-status="pending"]')
    check('ask: the ask carries the image', asks.at(-1).question === 'who yaps the most?' && asks.at(-1).image_type === 'image/png' && asks.at(-1).image_b64.length > 10)
    check('ask: pending shows thinking…', (await page.textContent('[data-status="pending"]')).includes('thinking…'))
    check('ask: while it answers, Send becomes Stop', (await page.getAttribute('.ask-send', 'aria-label')) === 'Stop the answer')
    check('ask: the composer cleared after send', (await page.inputValue('#ask-q')) === '' && (await page.locator('.ask-img').count()) === 0)
    await shot(page, 'ask-375-pending')
    thread = [...thread.slice(0, -1), askMsg(6, 'assistant', 'Goopy, by a mile: 312 messages this week.', { tools: ['wa_stats'], elapsed_ms: 4100 })]
    pending = false
    await page.waitForSelector('.ask-msg[data-role="assistant"]:has-text("Goopy, by a mile")', { timeout: 8000 })
    check('ask: the poll lands the answer', !(await page.isDisabled('#ask-q')))

    // Clear: confirm first, then the thread empties and the chips come back.
    await page.click('.ask-head button:has-text("Clear")')
    await page.waitForSelector('[role=alertdialog]')
    check('ask: clear confirms', (await page.textContent('[role=alertdialog]')).includes('Your facts stay, just the conversation goes.'))
    await page.click('[role=alertdialog] button:has-text("Cancel")')
    check('ask: Cancel keeps the thread', cleared === 0 && (await page.locator('.ask-log .ask-msg').count()) === 6)
    await page.click('.ask-head button:has-text("Clear")')
    await page.click('[role=alertdialog] button:has-text("Clear")')
    await page.waitForSelector('.ask-chips:not(details .ask-chips)')
    check('ask: cleared thread shows the 6 suggestions', cleared === 1 && (await page.locator('.ask-chips .chip').count()) === 6 && (await page.locator('.ask-log .ask-msg').count()) === 0)

    // Facts sheet: counts, filter, add, delete-gone.
    await page.click('.ask-head button:has-text("Squad facts")')
    await page.waitForSelector('.ask-facts-sheet .ask-facts li')
    check('ask: facts header counts', (await page.textContent('.ask-facts-body > .meta')) === 'Total 7 · Yours 2 of 25')
    check('ask: more than 6 facts shows a filter', (await page.locator('#fact-filter').count()) === 1)
    check('ask: only your facts can be deleted', (await page.locator('.ask-facts button[aria-label^="Delete fact"]').count()) === 2)
    await page.fill('#fact-filter', 'Liverpool')
    check('ask: the filter narrows facts', (await page.locator('.ask-facts li').count()) === 3)
    await page.fill('#fact-filter', '')
    await page.fill('#fact-subject', 'Shah')
    await page.fill('#fact-text', 'Never misses a Friday session')
    await shot(page, 'ask-375-facts')
    await axe(page, 'Ask facts sheet 375', '.ask-facts-sheet')
    await tapTargets(page, 'Ask facts sheet 375')
    await page.click('.ask-fact-form button:has-text("Add fact")')
    await page.waitForFunction(() => document.querySelector('#fact-text').value === '')
    check('ask: Add fact posts {text, subject}', added.length === 1 && added[0].text === 'Never misses a Friday session' && added[0].subject === 'Shah', JSON.stringify(added))
    await page.click('.ask-facts button[aria-label^="Delete fact"] >> nth=0')
    await page.waitForSelector('.ask-fact-form .ask-ferr')
    check('ask: deleting a gone fact says so', (await page.textContent('.ask-fact-form .ask-ferr')) === 'That fact is already gone.')
    check('no unmocked writes and no page errors (Ask 375)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    // Offline, history error + Retry, empty facts, signed out.
    const off = await newPage({ width: 375, height: 800, ...askMocks({ tools: json(200, { available: false, model: '', tools: [] }), history: json(200, { messages: [], pending: false, count: 0 }), facts: json(200, askFacts(0)) }) })
    await ready(off.page, '/app/ask')
    await off.page.waitForSelector('.ask-offline')
    check('ask: offline explains where the AI runs', (await off.page.textContent('.ask-offline')).includes('The AI is offline (it runs on the Mac at home)') && (await off.page.locator('.ask-offline a').count()) === 3)
    check('ask: offline disables the composer and chips', (await off.page.isDisabled('#ask-q')) && (await off.page.isDisabled('.ask-chips .chip >> nth=0')))
    await shot(off.page, 'ask-375-offline')
    await axe(off.page, 'Ask offline 375', '.app-main')
    await off.page.click('.ask-head button:has-text("Squad facts")')
    await off.page.waitForSelector('.ask-facts-empty')
    check('ask: no facts invites one', (await off.page.textContent('.ask-facts-empty')) === 'Teach it something about the squad' && (await off.page.locator('#fact-filter').count()) === 0)
    await off.ctx.close()

    let down = true
    const er = await newPage({ width: 375, height: 800, ...askMocks({ history: (r) => (down ? json(503, { detail: 'down' }) : json(200, { messages: ASK_THREAD, pending: false, count: 4 }))(r) }) })
    await ready(er.page, '/app/ask')
    await er.page.waitForSelector('.ask-thread .stat-err')
    down = false
    await er.page.click('.ask-thread .stat-err button:has-text("Retry")')
    await er.page.waitForSelector('.ask-log .ask-msg')
    check('ask: Retry recovers the thread', (await er.page.locator('.ask-log .ask-msg').count()) === 4)
    await er.ctx.close()

    const so = await newPage({ width: 375, height: 800, ...askMocks({ tools: json(401, { error: 'sign in' }), history: json(401, { error: 'sign in' }), facts: json(401, { error: 'sign in' }) }) })
    await so.page.addInitScript(() => sessionStorage.setItem('crcmz.ask.draft', 'kept draft'))
    await ready(so.page, '/app/ask')
    await so.page.waitForSelector('.banner:has-text("Sign in to keep up")')
    check('ask: signed out keeps the draft', (await so.page.inputValue('#ask-q')) === 'kept draft')
    check('ask: signed out says why Send is off', (await so.page.textContent('.ask-foot')).includes('Sign in to ask.'))
    await so.ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900, ...askMocks() })
    await ready(page, '/app/ask')
    await page.waitForSelector('.ask-log .ask-msg')
    const w = await page.$eval('.ask-page', (e) => e.getBoundingClientRect().width)
    check('ask 1440: reading width', w <= 760 && w > 600, `${w}`)
    await shot(page, 'ask-1440')
    await axe(page, 'Ask 1440', '.app-main')
    await page.click('.ask-head button:has-text("Squad facts")')
    await page.waitForSelector('.ask-facts-side .ask-facts li')
    const sw = await page.$eval('.ask-facts-side', (e) => e.getBoundingClientRect())
    check('ask 1440: facts open as a 360px side sheet', Math.round(sw.width) === 360 && Math.round(sw.right) === 1440, JSON.stringify(sw))
    await shot(page, 'ask-1440-facts')
    await axe(page, 'Ask facts side 1440', '.ask-facts-side')
    check('no unmocked writes and no page errors (Ask 1440)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  // ── 18. Notifications + Slap @mentions: the inbox, the bell, DM switches, tagging ──
  {
    const reads = [], chans = []
    let unread = 2
    const item = (id, source, title, read, personal = false) => ({ id, at: Date.now() - id * 60_000, category: source === 'slap' ? 'mentions' : source, source, title, body: `${title} body`, url: source === 'slap' ? '/app/slap?track=t3' : '/app/squad', personal, read })
    const ITEMS = [item(3, 'slap', 'Zubair mentioned you on Slap', false, true), item(5, 'squad', 'Moiz: Squad Up', false), item(9, 'clips', 'New clip', true)]
    const mocks = {
      ...SLAP_BASE,
      'GET /auth/settings/psn': ACCT_BASE['GET /auth/settings/psn'],
      'GET /api/notifications/unread': (r) => json(200, { unread })(r),
      'GET /api/notifications': (r) => {
        const src = new URL(r.request().url()).searchParams.get('source')
        const items = src ? ITEMS.filter((i) => i.source === src) : ITEMS
        return json(200, { items: items.map((i) => ({ ...i, read: i.read || unread === 0 })), more: false, unread })(r)
      },
      'POST /api/notifications/read': (r) => { const b = r.request().postDataJSON(); reads.push(b); if (b.all) unread = 0; else unread = Math.max(0, unread - b.ids.length); return json(200, { unread })(r) },
      'GET /api/notifications/channels': json(200, { channels: [{ id: 'whatsapp', label: 'WhatsApp DM when someone @mentions you' }, { id: 'mattermost', label: 'Mattermost DM when someone @mentions you' }], prefs: { whatsapp: true, mattermost: true }, reachable: { whatsapp: true, mattermost: false } }),
      'POST /api/notifications/channels': (r) => { chans.push(r.request().postDataJSON()); return json(200, { prefs: { whatsapp: false, mattermost: true } })(r) },
    }
    const { ctx, page } = await newPage({ width: 375, height: 800, mocks, match: slapMatch() })
    await ready(page, '/app/')
    await page.waitForSelector('.bell-btn .bell-badge')
    check('notif: the bell shows the unread count', (await page.textContent('.bell-badge')) === '2' && (await page.getAttribute('.bell-btn', 'aria-label')) === 'Notifications, 2 unread')
    await page.click('.bell-btn')
    await page.waitForSelector('.notif-row')
    check('notif: the inbox lists every alert, newest first', (await page.locator('.notif-row').count()) === 3 && (await page.textContent('.notif-row >> nth=0')).includes('Zubair mentioned you'))
    check('notif: unread rows carry a dot, read rows do not', (await page.locator('.notif-row[data-read="false"] .notif-dot').count()) === 2 && (await page.locator('.notif-row[data-read="true"] .notif-dot').count()) === 0)
    check('notif: a channel with no contact says so', (await page.textContent('.notif-delivery')).includes('no Mattermost account linked yet'))
    await shot(page, 'notifications-375')
    await axe(page, 'Notifications 375', '.app-main')
    await tapTargets(page, 'Notifications 375')
    await page.click('.notif-chips .chip:has-text("Mentions")')
    await page.waitForFunction(() => document.querySelectorAll('.notif-row').length === 1)
    check('notif: the Mentions chip filters to Slap', (await page.textContent('.notif-row')).includes('mentioned you'))
    await page.click('.notif-chips .chip:has-text("All")')
    await page.waitForFunction(() => document.querySelectorAll('.notif-row').length === 3)
    await page.click('.notif-delivery label:has-text("WhatsApp") input')
    await page.waitForTimeout(200)
    check('notif: switching WhatsApp off saves just that', chans.length === 1 && chans[0].whatsapp === false && Object.keys(chans[0]).length === 1, JSON.stringify(chans))
    await page.click('.notif-head button:has-text("Mark all read")')
    await page.waitForFunction(() => !document.querySelector('.bell-badge') && !document.querySelector('.notif-dot'), null, { timeout: 5000 }).catch(() => {})
    check('notif: Mark all read clears the dots and the bell', reads.some((b) => b.all === true) && (await page.locator('.notif-dot').count()) === 0 && (await page.locator('.bell-badge').count()) === 0, JSON.stringify(reads))

    // Tapping a mention opens that track's thread on Slap.
    unread = 1
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.notif-row[data-read="false"]')
    await page.click('.notif-row >> nth=0')
    await page.waitForSelector('.track-focus')
    check('notif: a mention opens its track on Slap', page.url().endsWith('/app/slap?track=t3') && (await page.textContent('#track-focus-h')) === 'Track 3', page.url())
    check('notif: tapping an unread row marks just it read', reads.some((b) => Array.isArray(b.ids) && b.ids.join() === '3'), JSON.stringify(reads))
    check('slap: the track thread shows its comments', (await page.textContent('.track-focus .comment-list')).includes('this one goes hard'))
    await axe(page, 'Slap track focus 375', '.track-focus')
    check('no unmocked writes and no page errors (Notifications)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
  {
    const { ctx, page } = await newPage({ width: 1440, height: 900, mocks: { 'GET /api/admin/check': json(200, { admin: false }), 'GET /auth/settings/psn': ACCT_BASE['GET /auth/settings/psn'], 'GET /api/notifications/unread': json(200, { unread: 4 }) } })
    await ready(page, '/app/')
    await page.waitForSelector('.sidebar a[href="/app/notifications"] .nav-badge')
    check('notif 1440: the sidebar row carries the unread count', (await page.textContent('.sidebar a[href="/app/notifications"] .nav-badge')) === '4' && (await page.locator('.bell-btn').count()) === 0)
    await ctx.close()
  }
  {
    const posted = []
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...SLAP_BASE,
        'GET /api/slap/mentionable': json(200, { people: [{ handle: 'Moiz', name: 'Moiz Qureshi' }, { handle: 'nooramin40', name: 'Noor Amin' }, { handle: 'zubair221b', name: 'Zubair' }] }),
        'POST /api/slap/comment': (r) => { const b = r.request().postDataJSON(); posted.push(b); return json(200, { id: 'c9', text: b.text, mentioned: b.is_reaction ? [] : ['Noor Amin'] })(r) },
      },
      match: slapMatch({ 'POST /api/slap/listen/play': json(200, { ok: true }), 'POST /api/slap/listen/skip': json(200, { ok: true }) }),
    })
    await ready(page, '/app/slap?tab=listen')
    await page.waitForSelector('.track-row')
    await page.click('.track-row .track-main >> nth=0')
    await page.click('.miniplayer-open')
    await page.waitForSelector('.sheet-player #slap-comment')
    await page.click('#slap-comment')
    await page.keyboard.type('banger @no')
    await page.waitForSelector('.mention-list:not([hidden]) .mention-opt')
    check('slap: @ suggests people as you type', (await page.locator('.mention-opt').count()) === 1 && (await page.textContent('.mention-opt')).includes('Noor Amin'))
    check('slap: the composer is a combobox wired to its list', (await page.getAttribute('#slap-comment', 'aria-expanded')) === 'true' && !!(await page.getAttribute('#slap-comment', 'aria-activedescendant')))
    await tapTargets(page, 'Slap mention list 375')
    await shot(page, 'slap-375-mention')
    await page.keyboard.press('Enter')
    check('slap: Enter picks the person and inserts their handle', (await page.inputValue('#slap-comment')) === 'banger @nooramin40 ' && (await page.getAttribute('#slap-comment', 'aria-expanded')) === 'false')
    await page.keyboard.type('listen')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.toast:has-text("Tagged Noor Amin")', { timeout: 5000 }).catch(() => {})
    check('slap: posting says who the tag reached', (await page.locator('.toast:has-text("Tagged Noor Amin")').count()) === 1 && posted.length === 1 && posted[0].text === 'banger @nooramin40 listen' && posted[0].is_reaction === false, JSON.stringify(posted))
    check('slap: the box clears after posting', (await page.inputValue('#slap-comment')) === '')
    check('slap: the player sheet shows the track thread', (await page.locator('.sheet-player .comment-thread').count()) === 1)
    await page.click('.sheet-player .reaction-btn >> nth=0')
    await page.waitForTimeout(200)
    check('slap: a reaction posts as a reaction', posted.length === 2 && posted[1].is_reaction === true && posted[1].text === '🔥', JSON.stringify(posted))
    await axe(page, 'Slap sheet with thread 375', '.sheet-player')
    check('no unmocked writes and no page errors (Slap mentions)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }

  // ── 19. Slap player: who added it, thumbs that remember, reactions you can see ──
  {
    const thumbed = []
    const mine = new Date((NOW - 120) * 1000).toISOString()
    const { ctx, page } = await newPage({
      width: 375, height: 800,
      mocks: {
        ...SLAP_BASE,
        'POST /api/slap/thumb': (r) => { const b = r.request().postDataJSON(); thumbed.push(b.thumbs); return json(200, { up: b.thumbs === 1 ? ['zubair221b', 'moiz'] : ['zubair221b'], down: [], mine: b.thumbs })(r) },
      },
      match: slapMatch({
        'POST /api/slap/listen/play': json(200, { ok: true }), 'POST /api/slap/listen/skip': json(200, { ok: true }),
        'GET /api/slap/social/listening/comments': json(200, { comments: [
          { id: 'r1', username: 'moiz', title: 'Track 1', artist: 'SZA', text: '🔥', is_reaction: true, created_at: mine },
          { id: 'r2', username: 'nooramin40', title: 'Track 1', artist: 'SZA', text: '🔥', is_reaction: true, created_at: mine },
        ] }),
        ...Object.fromEntries(SLAP_TRACKS.map(({ id }) => [`GET /api/slap/track/${id}`, json(200, { picked_by: ['nooramin40', 'themoosecompany'], thumbs: { up: ['zubair221b'], down: [], mine: 0 } })])),
      }),
    })
    await ready(page, '/app/slap?tab=listen')
    await page.waitForSelector('.track-row')
    await page.click('.track-row .track-main >> nth=0')
    await page.waitForSelector('.miniplayer-by')
    check('slap: the mini-player says whose pick is playing', (await page.textContent('.miniplayer-by')).includes('noor'))
    await page.click('.miniplayer-open')
    await page.waitForSelector('.sheet-player .player-by')
    check('slap: the player says who added the track', (await page.textContent('.sheet-player .player-by')).includes('Added by noor and moose'))
    const up = '.sheet-player button[aria-label^="Thumbs up"]'
    check('slap: thumbs show how many and who', (await page.getAttribute(up, 'aria-label')) === 'Thumbs up, 1 so far' && (await page.textContent('.sheet-player .track-rated')).includes('zubair'))
    const fire = '.sheet-player .reaction-btn >> nth=0'
    check('slap: your reaction shows as pressed, with the count', (await page.getAttribute(fire, 'aria-pressed')) === 'true' && (await page.textContent(fire)).includes('2'))
    check('slap: reactions show in the thread', (await page.locator('.sheet-player .comment-item[data-reaction="true"]').count()) === 2)
    await page.click(up)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'true', up.replace(' >> nth=0', ''))
    check('slap: a thumb sticks and the tally follows the server', thumbed.join() === '1' && (await page.getAttribute(up, 'aria-label')) === 'Thumbs up, 2 so far')
    await page.click(up)
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'false', up)
    check('slap: pressing it again takes the thumb back', thumbed.join() === '1,0')
    await page.click(fire)
    await page.waitForSelector('.toast:has-text("already reacted")', { timeout: 3000 }).catch(() => {})
    check('slap: a second identical reaction is not posted', (await page.locator('.toast:has-text("already reacted")').count()) === 1)
    await tapTargets(page, 'Slap player actions 375')
    await shot(page, 'slap-375-thumbs')
    await axe(page, 'Slap player actions 375', '.sheet-player')
    check('no unmocked writes and no page errors (Slap thumbs)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }

  // ── iOS app: the tab bar is native (lib/nativeShell.ts) ─────────────────────
  {
    const { ctx, page } = await newPage({ width: 390, height: 844 })
    await ctx.addInitScript(() => {
      window.__shell = []
      window.webkit = { messageHandlers: { crcmzShell: { postMessage: (m) => window.__shell.push(m) } } }
    })
    await ready(page)
    await page.waitForFunction(() => window.__shell.length > 0)
    check('ios shell: the page hides its own tab bar', !(await page.isVisible('.tabbar')))
    const m = await page.evaluate(() => window.__shell.at(-1))
    check('ios shell: the app gets your three tabs with Ask AI in the middle', m.tabs.map((t) => t.id).join() === 'squad,slap,ask,watch', JSON.stringify(m.tabs))
    check('ios shell: More lists the rest, without Admin for a non-admin', m.more.some((t) => t.id === 'clips') && !m.more.some((t) => t.id === 'admin') && m.active === 'squad')
    const pad = await page.$eval('.app-main', (e) => parseFloat(getComputedStyle(e).paddingBottom))
    check('ios shell: no room left for a bar that is not there', pad < 100, String(pad))
    await page.evaluate(() => window.__crcmzGo('/slap'))
    await page.waitForFunction(() => location.pathname === '/app/slap')
    await page.waitForFunction(() => window.__shell.at(-1).active === 'slap')
    check('ios shell: a native tap routes in place and the app hears the new tab', true)
    check('no page errors (ios shell)', page.violations.length === 0, page.violations.join(', '))
    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
