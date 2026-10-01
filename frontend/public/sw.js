// CRCMZ service worker. Scope /app/ (it is served from /app/sw.js).
//
// It does three things and nothing else:
//   1. Keeps the fingerprinted bundle (/app/assets/*) so the installed app opens fast.
//   2. Remembers the last good app document so the app still opens with no signal
//      (it then shows its own "can't reach" states); a tiny offline page otherwise.
//   3. Shows push notifications and opens the right screen when one is tapped.
// API calls, sign-in and media are never touched: they always go to the network.
const ASSETS = 'crcmz-assets-v1'
const SHELL = 'crcmz-shell-v1'
const SHELL_KEY = '/app'
const MAX_ASSETS = 150

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([ASSETS, SHELL])
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/app/assets/')) event.respondWith(asset(req))
  else if (req.mode === 'navigate' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) event.respondWith(page(req))
})

async function asset(req) {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) {
    await cache.put(req, res.clone())
    const keys = await cache.keys()
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k)
  }
  return res
}

async function page(req) {
  try {
    const res = await fetch(req)
    // Only a real app document: never a sign-in redirect or an error page.
    if (res.ok && !res.redirected && (res.headers.get('content-type') || '').includes('text/html')) {
      const cache = await caches.open(SHELL)
      await cache.put(SHELL_KEY, res.clone())
    }
    return res
  } catch {
    const cached = await (await caches.open(SHELL)).match(SHELL_KEY)
    return cached || new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
}

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#05030f"><title>CRCMZ</title>
<style>html,body{margin:0;height:100%;background:#05030f;color:#F4F5F7;font:16px/1.5 system-ui,sans-serif}
main{min-height:100%;display:grid;place-content:center;gap:12px;padding:24px;text-align:center}
img{width:96px;height:96px;margin:0 auto;border-radius:22px}
button{font:inherit;font-weight:600;color:#fff;background:#A855F7;border:0;border-radius:12px;padding:12px 20px}</style>
</head><body><main><img src="/app/pwa/icon-192.png" alt=""><h1 style="margin:0;font-size:20px">You're offline</h1>
<p style="margin:0;color:#A7A4B2">CRCMZ needs a connection. It will open as soon as you're back.</p>
<button onclick="location.reload()">Try again</button></main>
<script>addEventListener('online',()=>location.reload())</script></body></html>`

// ── Push ─────────────────────────────────────────────────────────────────────
// Payload (see webpush.py): {title, body, url, tag, category}.
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { body: event.data ? event.data.text() : '' } }
  const title = d.title || 'CRCMZ'
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: d.body || '',
      icon: '/app/pwa/icon-192.png',
      badge: '/app/pwa/badge-96.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: safeUrl(d.url) },
    }),
    // An open app refreshes its bell straight away instead of on the next poll.
    self.clients.matchAll({ type: 'window' }).then((wins) => wins.forEach((w) => w.postMessage({ type: 'crcmz:push' }))),
  ]))
})

// Only ever open a screen of this app, whatever the payload says.
function safeUrl(u) {
  try {
    const url = new URL(u || '/app', self.location.origin)
    return url.origin === self.location.origin && url.pathname.startsWith('/app') ? url.pathname + url.search : '/app'
  } catch { return '/app' }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || '/app', self.location.origin).href
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((w) => new URL(w.url).pathname.startsWith('/app'))
    if (win) {
      await win.focus()
      // The app routes it client-side, so a call or a song in progress survives.
      win.postMessage({ type: 'crcmz:navigate', url: target })
      return
    }
    await self.clients.openWindow(target)
  })())
})

// The browser rotated the subscription: hand the new one to the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey
    const sub = event.newSubscription || (key && await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
    if (!sub) return
    await fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), replaces: event.oldSubscription ? event.oldSubscription.endpoint : '' }),
    })
  })())
})
