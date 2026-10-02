// The phone apps. Android (android/): app.crcmz.me in Chrome, full screen; its launcher
// appends ?crcmz_app=android&crcmz_fcm=<token> to the first URL so this page can register
// the phone for Huddle / Watch Party rings (fcm.py). iOS (ios/): a web view that opens
// ?crcmz_app=ios and hands over its push tokens through window.__crcmzNative (APNs alerts
// as "ios", VoIP rings as "ios-voip"; apns.py). The params are taken off the URL before
// the router reads it.
import { request } from './http'
import { currentSubscription } from './pwa'

const KEY = 'crcmz.native'



/** Once, from main.tsx, before the router mounts. */
export function takeNativeLaunch() {
  const url = new URL(location.href)
  const app = url.searchParams.get('crcmz_app')
  const token = url.searchParams.get('crcmz_fcm')
  if (!app) return
  url.searchParams.delete('crcmz_app')
  url.searchParams.delete('crcmz_fcm')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  if (app === 'ios') { localStorage.setItem(KEY, 'ios'); return }
  if (app !== 'android') return
  localStorage.setItem(KEY, 'android')
  if (!token) return
  void registerToken(token)
  // First launch: Web Push subscribes a moment later (lib/pwa.ts); send the pairing again.
  window.addEventListener('crcmz:push-on', () => void registerToken(token), { once: true })
}

async function registerToken(token: string) {
  try {
    // The phone's Web Push endpoint rides along so a ring isn't also a second buzz.
    const sub = await currentSubscription().catch(() => null)
    await request('/api/push/native', { body: { token, platform: 'android', endpoint: sub?.endpoint ?? '' }, quiet401: true })
  } catch { /* signed out or offline: the next launch sends it again */ }
}

declare global {
  interface Window { __crcmzNative?: (token: string, platform: string) => Promise<boolean> }
}

/** The iOS app calls this with each push token; true once the server has it (signed in). */
window.__crcmzNative = async (token: string, platform: string) => {
  if (platform !== 'ios' && platform !== 'ios-voip') return false
  try {
    await request('/api/push/native', { body: { token, platform }, quiet401: true })
    return true
  } catch {
    return false   // signed out: the app tries again after the next page load
  }
}
