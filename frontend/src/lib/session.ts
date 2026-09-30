// Session state shared by the shell and every panel.
//
// The document at /app is already behind `_auth_gate`: without a session cookie the
// server 302s a browser to /auth/login before any of this code runs. What remains is
// the session expiring while the app is open. The boot probe (/api/admin/check)
// catches that on load and sends the user to sign in; after that, a 401 from any
// request shows the non-blocking banner instead (PS-0), so drafts are never lost.
import { useSyncExternalStore } from 'react'

let signedOut = false
const listeners = new Set<() => void>()

export function markSignedOut() {
  if (signedOut) return
  signedOut = true
  listeners.forEach((l) => l())
}

export function useSignedOut(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => signedOut,
  )
}

/** The current in-app location, e.g. "/app/clips?upload". */
export function currentAppPath(): string {
  return window.location.pathname + window.location.search
}

/** /auth/login only honours a `next` that starts with "/", which this always does. */
export function loginUrl(next: string = currentAppPath()): string {
  return `/auth/login?next=${encodeURIComponent(next)}`
}

export function redirectToLogin() {
  window.location.assign(loginUrl())
}
