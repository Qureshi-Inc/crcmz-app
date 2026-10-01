// The installed app: service worker, the install prompt and push notifications.
// The worker itself is frontend/public/sw.js; the server half is webpush.py.
import { useSyncExternalStore } from 'react'
import { getJSON, request } from './http'

// ── Platform ─────────────────────────────────────────────────────────────────
export const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

/** iOS only delivers web push to an app added to the Home Screen (16.4+). */
export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// ── Install prompt ───────────────────────────────────────────────────────────
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export type InstallState = 'installed' | 'prompt' | 'ios' | 'unavailable'
const installState = (): InstallState =>
  installed || isStandalone() ? 'installed' : deferred ? 'prompt' : isIOS() ? 'ios' : 'unavailable'

export const useInstall = () => useSyncExternalStore(subscribe, installState)

/** Android/desktop Chrome: the browser's own install sheet. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred
  if (!e) return false
  deferred = null
  emit()
  await e.prompt()
  return (await e.userChoice).outcome === 'accepted'
}

// ── Boot ─────────────────────────────────────────────────────────────────────
/** Once, from main.tsx: catch the install event early and register the worker. */
export function startPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // we show our own button instead of the mini-infobar
    deferred = e as InstallEvent
    emit()
  })
  window.addEventListener('appinstalled', () => { installed = true; deferred = null; emit() })
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' })
      .then(() => syncPush())
      .catch(() => { /* the app works without it */ })
  })
}

/** A notification tap while the app is open: route in place (the Shell listens). */
export function onWorkerNavigate(go: (path: string) => void) {
  if (!('serviceWorker' in navigator)) return () => {}
  const fn = (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null
    if (d?.type !== 'crcmz:navigate' || !d.url) return
    const u = new URL(d.url, location.origin)
    if (u.origin === location.origin && u.pathname.startsWith('/app')) go((u.pathname.slice(4) || '/') + u.search)
  }
  navigator.serviceWorker.addEventListener('message', fn)
  return () => navigator.serviceWorker.removeEventListener('message', fn)
}

// ── Push ─────────────────────────────────────────────────────────────────────
export type PushCategory = { id: string; label: string }
export type PushConfig = { publicKey: string; categories: PushCategory[]; prefs: Record<string, boolean>; devices: number }

export const fetchPushConfig = (signal?: AbortSignal) => getJSON<PushConfig>('/api/push/config', signal)

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const sameKey = (sub: PushSubscription, key: string) => {
  const k = sub.options.applicationServerKey
  if (!k) return false
  const want = keyBytes(key)
  const have = new Uint8Array(k)
  return have.length === want.length && have.every((b, i) => b === want[i])
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/app/')
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** From a tap: ask permission, subscribe this device, tell the server. */
export async function enablePush(): Promise<'on' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'denied'
  const reg = await navigator.serviceWorker.ready
  const { publicKey } = await fetchPushConfig()
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub, publicKey)) { await sub.unsubscribe(); sub = null }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await request('/api/push/subscribe', { body: { subscription: sub.toJSON() } })
  return 'on'
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  const endpoint = sub.endpoint
  await sub.unsubscribe().catch(() => false)
  await request('/api/push/unsubscribe', { body: { endpoint } })
}

/** Each launch: re-send a live subscription so the server never forgets a device. */
async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return
    const sub = await currentSubscription()
    if (!sub) return
    // quiet401: a signed-out launch is the Shell's call to make, not this one's.
    const { publicKey } = await request<PushConfig>('/api/push/config', { quiet401: true })
    if (!sameKey(sub, publicKey)) { await enablePush(); return }
    await request('/api/push/subscribe', { body: { subscription: sub.toJSON() }, quiet401: true })
  } catch { /* offline or signed out: next launch */ }
}

export const savePushPrefs = (changes: Record<string, boolean>) =>
  request<{ prefs: Record<string, boolean> }>('/api/push/prefs', { body: changes })

export const sendTestPush = () =>
  request<{ recipients: number; delivered: number }>('/api/push/test', { body: {} })
