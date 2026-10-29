// Smoke test for Trips (/app/trips): the list, a new trip, the Split with balances,
// several receipts read two at a time and saved, a moment posted, and the share-sheet
// landing page. Same harness as smoke.mjs; every /api/trips route is mocked here (the
// whole suite stops at the Watch call's camera step on a headless box, so these live
// in their own file and run on their own).
//
//   CRCMZ_BACKEND=http://127.0.0.1:3021 npx vite --port 5199
//   node tests/smoke-trips.mjs [--base http://127.0.0.1:5199]
import { createRequire } from 'node:module'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []))
const BASE = (args.base || 'http://127.0.0.1:5199').replace(/\/$/, '')
const SHOTS = args.shots || ''
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null)
const require = createRequire(process.env.PLAYWRIGHT_CORE || '/home/opti3/gstack/node_modules/')
const { chromium } = require('playwright-core')
const CHROME = process.env.CHROME || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`

let failed = 0
function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const img = (name) => ({ name, mimeType: 'image/png', buffer: PNG })

const ME = 'z-moiz'
const PEOPLE = [{ sub: ME, name: 'Moiz' }, { sub: 'z-noor', name: 'Noor' }, { sub: 'z-samad', name: 'Samad' }, { sub: 'z-zubi', name: 'Zubi' }]
const TRIPS = [
  { id: 'cal', name: 'Calgary', place: 'Calgary, AB', start: '2026-10-29', end: '2026-11-01', currency: 'CAD', linked: true, site_url: 'https://trip.crcmz.me', created_by: ME, can_manage: true, members: PEOPLE.slice(0, 3) },
  { id: 'lis', name: 'Lisbon', place: 'Lisbon', start: '2027-06-10', end: '2027-06-15', currency: 'EUR', linked: false, site_url: null, created_by: 'z-noor', can_manage: false, members: PEOPLE },
]
const SPLIT = {
  currency: 'CAD', currencies: ['CAD', 'USD'], fx: { CAD: 1, USD: 1.39 },
  people: [{ key: 'Moiz', name: 'Moiz' }, { key: 'Noor', name: 'Noor' }, { key: 'Samad', name: 'Samad' }], me: 'Moiz',
  expenses: [
    { id: 'e1', payer: 'Moiz', desc: 'Groceries', cents: 9000, currency: 'CAD', orig_cents: 9000, shares: { Moiz: 3000, Noor: 3000, Samad: 3000 }, receipt_url: null, added_by_name: 'Moiz', added_at: '2026-10-29T20:00:00Z', can_delete: true },
    { id: 'e2', payer: 'Noor', desc: 'Dinner', cents: 4170, currency: 'USD', orig_cents: 3000, shares: { Moiz: 1390, Noor: 1390, Samad: 1390 }, receipt_url: null, added_by_name: 'Noor', added_at: '2026-10-30T02:00:00Z', can_delete: false },
  ],
  settlements: [], balances: { Moiz: 4610, Noor: 1390, Samad: -6000 },
  settle: [{ from: 'Samad', to: 'Moiz', cents: 4610 }, { from: 'Samad', to: 'Noor', cents: 1390 }], total_cents: 13170,
}
const MOMENTS = { moments: [
  { id: 'm1', by: 'Noor', text: 'Pool table rematch.', at: new Date(Date.now() - 3600_000).toISOString(), photos: [], likes: 2, liked: false, mine: false },
], reel: { status: 'none' } }

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
async function newPage(mocks, match) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true })
  const page = await ctx.newPage()
  page.violations = []
  page.writes = []
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const key = `${req.method()} ${url.pathname}`
    const h = mocks[key] || match?.(key, url, req)
    if (h) { if (req.method() !== 'GET') page.writes.push(key); return h(route, req) }
    if (req.method() !== 'GET' && req.method() !== 'HEAD') { page.violations.push(key); return route.abort() }
    return route.continue()
  })
  page.on('pageerror', (e) => page.violations.push(`pageerror: ${e.message}`))
  return { ctx, page }
}

let live = 0
let maxLive = 0
const scanned = []
const READS = [[7268, 'CAD', 'CALGARY CO-OP', 'groceries'], [6050, 'USD', 'THE HALAL GUYS', 'dinner'], [2199, 'CAD', 'SHELL', 'gas']]
const posted = { expenses: [], receipts: 0, settlements: [], trips: [], moments: 0 }
const mocks = {
  'GET /api/trips': json(200, { trips: TRIPS, can_link: false }),
  'GET /api/trips/people': json(200, { people: PEOPLE }),
  'GET /api/trips/cal/split': json(200, SPLIT),
  'GET /api/trips/lis/split': json(200, { ...SPLIT, currency: 'EUR', currencies: ['EUR'] }),
  'GET /api/trips/cal/moments': json(200, MOMENTS),
  'POST /api/trips': async (route, req) => { posted.trips.push(JSON.parse(req.postData() || '{}')); return json(201, { ...TRIPS[1], id: 'new', name: 'Banff', created_by: ME, can_manage: true })(route) },
  'GET /api/trips/new/split': json(200, { ...SPLIT, expenses: [], balances: {}, settle: [], total_cents: 0 }),
  'POST /api/trips/receipts/scan': async (route) => {
    live++; maxLive = Math.max(maxLive, live)
    const r = READS[scanned.length % READS.length]
    scanned.push(1)
    await new Promise((s) => setTimeout(s, 600))
    live--
    return json(200, { ok: true, cents: r[0], currency: r[1], other_currency: null, merchant: r[2], summary: r[3], date: '', confidence: 0.95 })(route)
  },
  'POST /api/trips/cal/receipts': async (route) => { posted.receipts++; return json(201, { receipt: `r${posted.receipts}.jpg` })(route) },
  'POST /api/trips/cal/expenses': async (route, req) => { posted.expenses.push(JSON.parse(req.postData() || '{}')); return json(201, { ok: true, expense: {} })(route) },
  'POST /api/trips/cal/settlements': async (route, req) => { posted.settlements.push(JSON.parse(req.postData() || '{}')); return json(200, { ok: true })(route) },
  'POST /api/trips/cal/moments': async (route) => { posted.moments++; return json(201, { ok: true, moment: {} })(route) },
  'GET /api/trips/inbox/ib1': json(200, { files: [{ n: 0, url: '/api/trips/inbox/ib1/0', type: 'image/png' }, { n: 1, url: '/api/trips/inbox/ib1/1', type: 'image/png' }] }),
  'GET /api/trips/inbox/ib1/0': (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  'GET /api/trips/inbox/ib1/1': (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
}

try {
  // ── The list ──
  const { page } = await newPage(mocks)
  await page.goto(`${BASE}/app/trips`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tr-card-link', { timeout: 15000 })
  check('trips: the list shows your trips', (await page.locator('.tr-card-link').count()) === 2)
  await shot(page, 'trips-list')
  check('trips: Calgary is marked as the trip.crcmz.me trip', (await page.textContent('.tr-card-link >> nth=0')).includes('trip.crcmz.me'))

  // ── New trip ──
  await page.click('button:has-text("New trip")')
  await page.fill('#tr-name', 'Banff')
  await page.fill('#tr-place', 'Banff, AB')
  await page.click('.tr-chips-wrap .chip:has-text("Noor")')
  await page.click('button:has-text("Make the trip")')
  await page.waitForURL(/\/app\/trips\/new$/, { timeout: 10000 })
  check('trips: New trip posts the name, place and who\'s invited', posted.trips.length === 1 && posted.trips[0].name === 'Banff' && posted.trips[0].members.includes('z-noor'), JSON.stringify(posted.trips[0]))

  // ── Split ──
  await page.goto(`${BASE}/app/trips/cal`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tr-sum', { timeout: 15000 })
  check('split: the trip total', (await page.textContent('.tr-sum')).includes('131.70'))
  await shot(page, 'trips-split')
  check('split: your balance says you\'re owed', (await page.textContent('.tr-sum')).includes("you're owed") && (await page.textContent('.tr-sum')).includes('46.10'))
  check('split: settle up lists who pays whom', (await page.locator('#tr-settle-h + ul .tr-row').count()) === 2)
  check('split: a USD expense shows both amounts', (await page.textContent('#tr-exp-h + ul')).includes('US$30.00'))
  await page.click('#tr-settle-h + ul .tr-row >> nth=0 >> button:has-text("Mark paid")')
  await page.waitForFunction(() => true)
  await page.waitForTimeout(400)
  check('split: Mark paid posts the settlement', posted.settlements.length === 1 && posted.settlements[0].from === 'Samad' && posted.settlements[0].cents === 4610)

  // ── Several receipts ──
  await page.setInputFiles('input[aria-label="Receipt photos"]', [img('a.png'), img('b.png'), img('c.png')])
  await page.waitForSelector('.tr-batch', { timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('.tr-batch-sub')?.textContent?.startsWith('All read'), null, { timeout: 20000 })
  check('scan: three receipts read, never more than two at once', scanned.length === 3 && maxLive === 2, `${scanned.length} read, ${maxLive} at once`)
  const amts = await page.$$eval('.tr-batch-row .tr-amt-in', (els) => els.map((e) => e.value))
  check('scan: each row filled from its reading', amts.length === 3 && amts.every((a) => /^\d+\.\d\d$/.test(a)), amts.join(', '))
  check('scan: the US one is in USD', (await page.locator('.tr-batch-row .tr-cur:has-text("USD")').count()) === 1)
  await shot(page, 'trips-batch')
  await page.click('button:has-text("Add 3 expenses")')
  await page.waitForFunction(() => !document.querySelector('.tr-batch'), null, { timeout: 15000 })
  check('scan: three expenses saved, each with its receipt', posted.expenses.length === 3 && posted.receipts === 3 && posted.expenses.every((e) => e.receipt), JSON.stringify(posted.expenses.map((e) => e.receipt)))
  check('scan: paid by you, split between everyone', posted.expenses.every((e) => e.payer === 'Moiz' && e.parts.length === 3))
  check('scan: the US one is saved in USD', posted.expenses.some((e) => e.currency === 'USD' && e.orig_cents === 6050))

  // ── Moments ──
  await page.click('[role=tab]:has-text("Moments")')
  await page.waitForSelector('.tr-card', { timeout: 10000 })
  check('moments: the feed shows', (await page.textContent('.tr-feed')).includes('Pool table rematch.'))
  await page.fill('#tr-moment-text', 'Landed.')
  await page.setInputFiles('input[aria-label="Photos for the moment"]', [img('p.png')])
  check('moments: a photo preview before posting', (await page.locator('.tr-previews img').count()) === 1)
  await shot(page, 'trips-moments')
  await page.click('.tr-compose button[type=submit]')
  await page.waitForTimeout(600)
  check('moments: Post sends the moment', posted.moments === 1)
  check('trips: no unmocked writes and no page errors', page.violations.length === 0, page.violations.join(' | '))

  // ── The share sheet's landing page ──
  const one = await newPage({ ...mocks, 'GET /api/trips': json(200, { trips: [TRIPS[0]], can_link: false }) })
  posted.expenses = []
  await one.page.goto(`${BASE}/app/trips/receipts?inbox=ib1`, { waitUntil: 'domcontentloaded' })
  await one.page.waitForSelector('.tr-batch', { timeout: 15000 })
  check('shared: on one trip, no picker: straight to the receipts', (await one.page.locator('#tr-which').count()) === 0)
  await one.page.waitForFunction(() => document.querySelector('.tr-batch-sub')?.textContent?.startsWith('All read'), null, { timeout: 20000 })
  check('shared: both shared photos read', (await one.page.locator('.tr-batch-row').count()) === 2)
  await one.page.click('button:has-text("Add 2 expenses")')
  await one.page.waitForURL(/\/app\/trips\/cal$/, { timeout: 15000 })
  check('shared: added, then on to that trip', posted.expenses.length === 2)
  check('shared: no unmocked writes and no page errors', one.page.violations.length === 0, one.page.violations.join(' | '))
} catch (e) {
  check('run', false, e.message)
} finally {
  await browser.close()
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
