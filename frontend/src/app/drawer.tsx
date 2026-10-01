// Section drawers (phone): going to another section raises it from the bottom like a
// sheet while the last one sinks back and dims. The grip at the top drags it back down
// to where you were; it is also a plain "Back to …" button, so the drag is never the
// only way. Desktop and reduced motion get a short crossfade instead.
//
// One click listener catches every in-app link that changes section (tab bar, More,
// links inside pages), so no page has to opt in. Ask AI keeps its own orb flight.
import { useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { DESTS, destForPath } from './nav'

type Kind = 'rise' | 'return' | 'fade'
type VT = { finished: Promise<void> }
type StartVT = (cb: () => Promise<void>) => VT

const BASE = '/app'
const PREV_KEY = 'crcmz.drawer.prev'
const DISMISS_PX = 120
const DISMISS_SPEED = 0.6 // px per ms: a flick closes even when short

// history entry key -> the path it rose from. Session-scoped, so a reload keeps the grip.
function prevMap(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(PREV_KEY) || '{}') } catch { return {} }
}
function remember(key: string, from: string) {
  const m = prevMap()
  m[key] = from
  const keys = Object.keys(m)
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete m[k]
  try { sessionStorage.setItem(PREV_KEY, JSON.stringify(m)) } catch { /* private mode: no grip after reload */ }
}
const entryKey = () => (window.history.state as { key?: string } | null)?.key ?? ''

// The DOM for the new section is in when the Shell's layout effect sees the new location.
let arrived: (() => void) | null = null
function waitForArrival(): Promise<void> {
  return new Promise((res) => {
    const t = window.setTimeout(() => { arrived = null; res() }, 1000)
    arrived = () => { window.clearTimeout(t); arrived = null; res() }
  })
}

function startVT(): StartVT | null {
  const d = document as Document & { startViewTransition?: StartVT }
  return typeof d.startViewTransition === 'function' ? d.startViewTransition.bind(d) : null
}

const main = () => document.getElementById('main')

/** Run a navigation inside a drawer transition. */
function transition(kind: Kind, go: () => void, after?: () => void) {
  const html = document.documentElement
  const vt = startVT()
  if (!vt) {
    go()
    after?.()
    if (kind !== 'fade') main()?.animate(
      kind === 'rise'
        ? [{ transform: 'translateY(56px)', opacity: 0 }, { transform: 'none', opacity: 1 }]
        : [{ transform: 'scale(.96)', opacity: 0.4 }, { transform: 'none', opacity: 1 }],
      { duration: 300, easing: 'cubic-bezier(.16, 1, .3, 1)' })
    return
  }
  html.dataset.vt = kind
  const t = vt(async () => {
    const landed = waitForArrival()
    go()
    await landed
    after?.()
  })
  t.finished.finally(() => { if (html.dataset.vt === kind) delete html.dataset.vt })
}

/** Installs the link listener and tells waiting transitions when a section has rendered. */
export function useDrawerNav(desktop: boolean, reduced: boolean) {
  const navigate = useNavigate()
  const location = useLocation()
  const here = useRef(location)
  here.current = location

  useLayoutEffect(() => { arrived?.() }, [location.key])

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
      const url = new URL(a.href, window.location.href)
      if (url.origin !== window.location.origin || !(url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) return
      const path = url.pathname.slice(BASE.length) || '/'
      const to = destForPath(path)
      const from = destForPath(here.current.pathname)
      if (!to || to === from || to === 'ask') return
      e.preventDefault()
      const back = here.current.pathname + here.current.search
      const target = path + url.search + url.hash
      // navigate() pushes the history entry at once and renders after, so the grip
      // already knows where this section rose from when it first draws.
      transition(desktop || reduced ? 'fade' : 'rise', () => { navigate(target); remember(entryKey(), back) }, () => {
        if (!url.hash) window.scrollTo(0, 0)
      })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [desktop, reduced, navigate])
}

/** The grip at the top of a raised section: drag it down (or tap it) to go back. */
export function DrawerGrip() {
  const location = useLocation()
  const navigate = useNavigate()
  const from = prevMap()[location.key]
  const drag = useRef<{ id: number; y0: number; y: number; t: number; v: number } | null>(null)
  const dragged = useRef(false) // a drag ends in pointerup, then a click: that click isn't a tap
  const dest = from !== undefined ? destForPath(from.split(/[?#]/)[0] || '/') : null
  if (!dest) return null
  const label = DESTS[dest].label

  function close(fromY = 0) {
    const el = main()
    const off = el?.animate(
      [{ transform: `translateY(${fromY}px)` }, { transform: `translateY(${window.innerHeight}px)`, opacity: 0.6 }],
      { duration: 220, easing: 'cubic-bezier(.7, 0, .84, 0)', fill: 'forwards' })
    const finish = () => transition('return', () => navigate(-1), () => {
      off?.cancel()
      if (el) el.style.transform = ''
    })
    if (off) off.finished.then(finish, finish)
    else finish()
  }

  function onDown(e: PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, y0: e.clientY, y: 0, t: e.timeStamp, v: 0 }
  }
  function onMove(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const y = Math.max(0, e.clientY - d.y0)
    const dt = Math.max(1, e.timeStamp - d.t)
    d.v = (y - d.y) / dt
    d.y = y
    d.t = e.timeStamp
    const el = main()
    if (el) el.style.transform = y ? `translateY(${y}px)` : ''
  }
  function onUp(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current
    drag.current = null
    if (!d || d.id !== e.pointerId) return
    const el = main()
    dragged.current = d.y > 4
    if (d.y > DISMISS_PX || (d.y > 24 && d.v > DISMISS_SPEED)) {
      close(d.y)
    } else if (d.y > 4 && el) {
      el.style.transform = ''
      el.animate([{ transform: `translateY(${d.y}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' })
    }
  }
  function onCancel() {
    drag.current = null
    const el = main()
    if (el) el.style.transform = ''
  }

  return (
    <div className="drawer-grip-row">
      <button
        type="button" className="drawer-grip" aria-label={`Back to ${label}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
        onClick={() => { if (dragged.current) dragged.current = false; else close() }}
      >
        <span className="sheet-knob" aria-hidden="true" />
        <span className="drawer-grip-label" aria-hidden="true"><Icon name="down" />{label}</span>
      </button>
    </div>
  )
}
