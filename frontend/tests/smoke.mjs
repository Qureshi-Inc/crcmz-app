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
async function newPage({ width, height, mocks = {}, reducedMotion = 'no-preference' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion, hasTouch: width < 1024 })
  const page = await ctx.newPage()
  page.violations = []
  page.writes = []
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const key = `${req.method()} ${url.pathname}`
    if (mocks[key]) { page.writes.push(key); return mocks[key](route) }
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
const CLIP_READS = {
  'GET /api/pipeline-status': json(200, {
    clips_this_month: 142, last_clip_at: NOW - 600, last_clip_sender: 'Goopy', next_build_ts: NOW + 3 * 86400 + 4 * 3600,
    next_build_label: 'Oct 1, 2026 · 6 AM PT', next_build_month: '2026-09',
    last_montage: { version: 8, year: 2026, month: 8, clips: 19, duration: 834.3, sent: false },
    clips: [{ uid: 'm0', sender: 'Goopy', duration: 31, at: NOW - 600, included: true, reason: null },
      { uid: 'm1', sender: 'Bizzle', duration: 4, at: NOW - 900, included: false, reason: 'too short' }],
  }),
  'GET /api/reels': json(200, { me: { psn_id: 'Goopy', display_name: 'Goopy', admin: true }, scope: 'mine', clips: REELS, source: 'reel-review', roster: null, needs_psn_link: false }),
  'GET /api/video-uploads/mine': json(200, { psn_id: 'Goopy', uploads: [{ video_post_id: 'v1', status: 'posted', caption: 'Montage cut', filename: 'a.mp4', uploaded_at: NOW - 86400, posted_at: NOW - 80000, skip_reason: null, duration_seconds: 42, platforms: { youtube: { url: 'https://example.com/v' } } }], can_upload: true, open_session: null }),
  'GET /clips': json(200, { clips: CLIP_ROWS, count: 50 }),
  'GET /clips/m0': json(200, CLIP_ROWS[0]),
  'GET /clips/m1': json(200, CLIP_ROWS[1]),
  'GET /clips/m2': json(200, CLIP_ROWS[2]),
  'GET /api/clips/media': delayed(20_000, (r) => r.fulfill({ status: 404, body: '' })),
  // Held open so the player stays mounted while the test looks at it.
  'GET /api/reels/clips/r0/source': delayed(20_000, (r) => r.fulfill({ status: 404, body: '' })),
}

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
    const map = { squad: '/app', pipeline: '/app/clips', upload: '/?p=upload', slap: '/app/slap', wa: '/app/whatsapp', giveaway: '/app/giveaway', watch: '/app/watch', huddle: '/app/huddle', coach: '/app/coach', ai: '/app/ask', nope: '/app', '../../etc': '/app' }
    for (const [k, want] of Object.entries(map)) {
      await page.goto(`${BASE}${process.env.LEGACY_PREFIX || "/app/"}?p=${encodeURIComponent(k)}`)
      await page.waitForSelector('h1')
      const u = new URL(page.url())
      check(`legacy ?p=${k} → ${want}`, u.pathname + u.search === want || (want === '/app' && u.pathname === '/app'), u.pathname + u.search)
    }
    const classic = { 'clips/x/edit': '/?p=pipeline', slap: '/?p=slap', whatsapp: '/?p=wa', giveaway: '/?p=giveaway', watch: '/?p=watch', huddle: '/?p=huddle', coach: '/?p=coach', ask: '/?p=ai', portal: '/portal', settings: '/' }
    for (const [route, href] of Object.entries(classic)) {
      await page.goto(`${BASE}/app/${route}`)
      await page.waitForSelector('.handoff a.btn')
      const got = await page.getAttribute('.handoff a.btn', 'href')
      check(`/app/${route} hands off to ${href}`, got === href, got)
    }
    await page.goto(`${BASE}/app/clips?upload`).catch(() => {}) // superseded by location.replace
    await page.waitForFunction(() => location.pathname === '/' && location.search === '?p=upload', null, { timeout: 10_000 }).catch(() => {})
    check('/app/clips?upload goes straight to the classic upload', page.url() === `${BASE}/?p=upload`, page.url())
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
    const { ctx, page } = await newPage({ width: 1440, height: 900, mocks: { 'GET /api/admin/check': json(200, { admin: true }) } })
    await ready(page, '/app/admin')
    await page.waitForSelector('.handoff a.btn')
    check('admin sees Admin in the sidebar', (await page.locator('nav[aria-label="Primary"] a:has-text("Admin")').count()) === 1)
    check('/app/admin for an admin hands off to the classic app', (await page.getAttribute('.handoff a.btn', 'href')) === '/')
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
    check('reel sheet has the source video and a Studio link', (await page.getAttribute('.sheet-clip video', 'src')).endsWith('/api/reels/clips/r0/source') && (await page.getAttribute('.sheet-clip a:has-text("Studio")', 'href')) === '/?p=pipeline')
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
} finally {
  await browser.close()
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
