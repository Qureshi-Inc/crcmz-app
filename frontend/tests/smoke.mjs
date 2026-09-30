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
    const { ctx, page } = await newPage({ width: 375, height: 800 })
    const map = { squad: '/app', pipeline: '/app/clips', upload: '/app/clips?upload', slap: '/app/slap', wa: '/app/whatsapp', giveaway: '/app/giveaway', watch: '/app/watch', huddle: '/app/huddle', coach: '/app/coach', ai: '/app/ask', nope: '/app', '../../etc': '/app' }
    for (const [k, want] of Object.entries(map)) {
      await page.goto(`${BASE}${process.env.LEGACY_PREFIX || "/app/"}?p=${encodeURIComponent(k)}`)
      await page.waitForSelector('h1')
      const u = new URL(page.url())
      check(`legacy ?p=${k} → ${want}`, u.pathname + u.search === want || (want === '/app' && u.pathname === '/app'), u.pathname + u.search)
    }
    const classic = { clips: '/?p=pipeline', slap: '/?p=slap', whatsapp: '/?p=wa', giveaway: '/?p=giveaway', watch: '/?p=watch', huddle: '/?p=huddle', coach: '/?p=coach', ask: '/?p=ai', portal: '/portal', settings: '/' }
    for (const [route, href] of Object.entries(classic)) {
      await page.goto(`${BASE}/app/${route}`)
      await page.waitForSelector('.handoff a.btn')
      const got = await page.getAttribute('.handoff a.btn', 'href')
      check(`/app/${route} hands off to ${href}`, got === href, got)
    }
    await page.goto(`${BASE}/app/clips?upload`)
    await page.waitForSelector('.handoff a.btn')
    check('/app/clips?upload hands off to /?p=upload', (await page.getAttribute('.handoff a.btn', 'href')) === '/?p=upload')
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
} finally {
  await browser.close()
}

console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
