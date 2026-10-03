// In the iOS app the tab bar is native (ios/CRCMZ/Shell.swift): the page tells it which
// tabs to show (the user's own three, Ask AI, More), which one is current, and when to
// get out of the way (a fullscreen party); the app tells the page where to go. The
// page's own tab bar is hidden there. Outside the iOS app none of this is used.
type Handler = { postMessage(m: unknown): void }
const handler = (): Handler | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { crcmzShell?: Handler } } }).webkit?.messageHandlers?.crcmzShell

export const nativeShell = () => !!handler()

export type ShellItem = { id: string; label: string; path: string; group?: 'squad' | 'account' }
export type ShellState = { tabs: ShellItem[]; more: ShellItem[]; active: string | null; badge: number; hidden: boolean }

let last = ''
export function toShell(m: ShellState) {
  const s = JSON.stringify(m)
  if (s === last) return
  last = s
  handler()?.postMessage({ type: 'tabs', ...m })
}

declare global {
  interface Window { __crcmzGo?: (path: string) => void }
}
/** The app's tab bar was tapped: route there inside the page (calls and music keep going). */
export function onShellGo(fn: (path: string) => void) {
  window.__crcmzGo = fn
  return () => { if (window.__crcmzGo === fn) delete window.__crcmzGo }
}

// Hide the page's bar before the first paint, so it never flashes under the native one.
if (nativeShell()) document.documentElement.dataset.nativeShell = ''
