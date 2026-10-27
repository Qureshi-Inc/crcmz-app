// The Android TV app: the same web view as the phone app, opened with
// ?crcmz_app=android-tv (android/, LauncherActivity.isTV). A TV gets only the Watch
// Party, built for a remote: features/tv. ?crcmz_app=web in a browser turns it off again.
// Kept for the web view's session only, so a browser that tried it isn't stuck on it.
import { useEffect, useRef } from 'react'

const KEY = 'crcmz.tv'

export const isTV = () => {
  try { return sessionStorage.getItem(KEY) === '1' } catch { return false }
}
export function setTV(on: boolean) {
  try { if (on) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY) } catch { /* private mode */ }
}

// ── Remote control: D-pad focus moves like Apple TV ──────────────────────────
// The arrows move focus to the nearest focusable thing in that direction. Within a
// row ([data-tv-row]) coming back down/up lands on the poster you left, not the nearest
// one. An open panel ([data-tv-trap]) keeps focus inside it. Anything that wants an
// arrow for itself (a slider row, the player) handles the key first and calls
// preventDefault.
type Dir = 'up' | 'down' | 'left' | 'right'
const DIRS: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]'
const lastInRow = new WeakMap<Element, HTMLElement>()

function visible(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'
}

function scope(): ParentNode {
  const traps = [...document.querySelectorAll<HTMLElement>('[data-tv-trap]')].filter(visible)
  return traps[traps.length - 1] ?? document
}

export function candidates(): HTMLElement[] {
  return [...scope().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible)
}

/** The best next element from `from` in `dir`, or null at the edge. */
function next(from: HTMLElement, dir: Dir, list: HTMLElement[]): HTMLElement | null {
  const a = from.getBoundingClientRect()
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2
  const horiz = dir === 'left' || dir === 'right'
  const ahead = list.flatMap((el) => {
    if (el === from) return []
    const b = el.getBoundingClientRect()
    const bx = b.left + b.width / 2, by = b.top + b.height / 2
    // Must lie in that direction (edges, with a little slack for overlapping cards).
    const ok = dir === 'right' ? b.left >= a.right - 8 || bx > a.right
      : dir === 'left' ? b.right <= a.left + 8 || bx < a.left
      : dir === 'down' ? b.top >= a.bottom - 8 || by > a.bottom
      : b.bottom <= a.top + 8 || by < a.top
    if (!ok) return []
    // How far away it is along the move (edge to edge), and how far off to the side.
    const gap = Math.max(0, dir === 'right' ? b.left - a.right : dir === 'left' ? a.left - b.right : dir === 'down' ? b.top - a.bottom : a.top - b.bottom)
    const side = horiz ? Math.abs(by - ay) : Math.abs(bx - ax)
    const overlap = horiz ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left)
    return [{ el, gap, side, overlap, h: b.height }]
  })
  if (!ahead.length) return null
  let best: HTMLElement | null
  if (horiz) {
    // Left/right: only along this line (things level with it); at its end, stay put.
    const level = ahead.filter((c) => c.overlap > 0)
    level.sort((p, q) => (p.gap + p.side * 3) - (q.gap + q.side * 3))
    return level[0]?.el ?? null
  }
  // Up/down: the nearest line of things first, then the one closest sideways in it.
  const near = Math.min(...ahead.map((c) => c.gap))
  const line = ahead.filter((c) => c.gap <= near + Math.max(12, c.h * 0.5))
  line.sort((p, q) => p.side - q.side)
  best = line[0]!.el
  // Up/down into another row: back to where you were in it.
  const row = best.closest('[data-tv-row]')
  if (row && row !== from.closest('[data-tv-row]')) {
    const mem = lastInRow.get(row)
    if (mem?.isConnected && visible(mem)) return mem
  }
  return best
}

export function focusEl(el: HTMLElement | null | undefined) {
  if (!el) return
  el.focus({ preventScroll: true })
  // Rows scroll sideways to the poster, the page scrolls to the row.
  el.scrollIntoView({ block: el.closest('[data-tv-noscroll]') ? 'nearest' : 'center', inline: 'center', behavior: 'smooth' })
}

/** Focus the element marked [data-tv-autofocus] in `root` (or the first focusable). */
export function focusFirst(root: ParentNode = document) {
  const el = root.querySelector<HTMLElement>('[data-tv-autofocus]') ?? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible)
  focusEl(el)
}

/** Once, at the TV app's root. */
export function useSpatialNav() {
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement
      const row = t?.closest?.('[data-tv-row]')
      if (row) lastInRow.set(row, t)
    }
    const onKey = (e: KeyboardEvent) => {
      const dir = DIRS[e.key]
      if (!dir || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const cur = document.activeElement as HTMLElement | null
      // A text field keeps left/right for its cursor (until the cursor is at the end).
      if (cur instanceof HTMLInputElement && cur.type !== 'range' && (dir === 'left' || dir === 'right')) {
        const at = cur.selectionStart ?? 0
        if ((dir === 'left' && at > 0) || (dir === 'right' && at < cur.value.length)) return
      }
      const list = candidates()
      e.preventDefault()
      if (!cur || cur === document.body || !list.includes(cur)) { focusFirst(scope()); return }
      const to = next(cur, dir, list)
      if (to) focusEl(to)
    }
    document.addEventListener('focusin', onFocus)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('focusin', onFocus); document.removeEventListener('keydown', onKey) }
  }, [])
}

// ── Back ──────────────────────────────────────────────────────────────────────
// The Android app (2.0.16+) asks the page first: window.__crcmzBack() → true when the
// page handled Back. Screens that want Back (a dialog, the player) put a handler on this
// stack; the newest one gets it. TvApp answers the rest (a movie's page → home).
const backStack: { fn: () => void }[] = []
export function useBackHandler(enabled: boolean, onBack: () => void) {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    if (!enabled) return
    const h = { fn: () => ref.current() }
    backStack.push(h)
    return () => { const i = backStack.indexOf(h); if (i >= 0) backStack.splice(i, 1) }
  }, [enabled])
}
/** The newest Back handler, if any: true when one took it. */
export function runBack(): boolean {
  const h = backStack[backStack.length - 1]
  if (!h) return false
  h.fn()
  return true
}
declare global { interface Window { __crcmzBack?: () => boolean } }

// Older apps (2.0.15) only go back in the web view's history, so the player also keeps
// a history guard entry (below) and handles Back when it's popped.
// The remote's Back is the web view going back (LauncherActivity: web.goBack()). The
// player wants Back for itself (close a panel, hide the controls, ask before leaving),
// so while it's open it keeps one guard entry on top of its own history entry and gets a
// call when Back pops it. Leaving on purpose goes through exitGuarded, which pops both.
let exiting = false

export function useBackGuard(enabled: boolean, onBack: () => void) {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    if (!enabled) return
    history.pushState({ ...history.state, tvGuard: 1 }, '')
    const pop = () => {
      if (exiting) return
      history.pushState({ ...history.state, tvGuard: 1 }, '')   // re-arm, then handle it
      if (!runBack()) ref.current()
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [enabled])
}

/** Leave a guarded screen: pop the guard and the screen's own entry, back to where it was opened from. */
export function exitGuarded(fallback: () => void) {
  exiting = true
  const at = location.pathname
  history.go(-2)
  window.setTimeout(() => {
    exiting = false
    if (location.pathname === at) fallback()   // opened directly: nowhere to go back to
  }, 400)
}
