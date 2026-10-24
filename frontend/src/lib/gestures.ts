// Swipe-down-to-close for bottom sheets. An accelerator only: every sheet also has a
// visible Close button and closes on Escape and on a scrim tap.
import { useCallback, useRef } from 'react'
import type { PointerEvent } from 'react'

export function useSwipeDown(onClose: () => void, threshold = 64) {
  const start = useRef<{ y: number; id: number } | null>(null)
  return {
    onPointerDown: (e: PointerEvent) => { start.current = { y: e.clientY, id: e.pointerId } },
    onPointerUp: (e: PointerEvent) => {
      const s = start.current
      start.current = null
      if (s && s.id === e.pointerId && e.clientY - s.y > threshold) onClose()
    },
    onPointerCancel: () => { start.current = null },
  }
}

/** A sheet that drags down like a native one: it follows the finger from anywhere once
 *  whatever is under the finger is scrolled to the top, closes when pulled far or
 *  flicked, and springs back otherwise. Put the returned ref on the sheet itself. */
export function useSheetDrag(onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  const off = useRef<(() => void) | null>(null)
  return useCallback((el: HTMLElement | null) => {
    off.current?.()
    off.current = null
    if (!el) return
    let mode: 'idle' | 'maybe' | 'drag' = 'idle'
    let x0 = 0, y0 = 0, dy = 0, lastY = 0, lastT = 0, speed = 0

    const scrolled = (from: EventTarget | null) => {
      for (let n = from as HTMLElement | null; n && n !== el.parentElement; n = n.parentElement) {
        if (n.scrollTop > 0) return true
      }
      return false
    }
    const start = (e: TouchEvent) => {
      const t = e.touches[0]
      const target = e.target as HTMLElement
      mode = 'idle'
      if (e.touches.length !== 1 || !t || target.closest('input, textarea, select, [role="slider"], [data-no-drag]')) return
      if (scrolled(target)) return
      mode = 'maybe'
      x0 = t.clientX; y0 = lastY = t.clientY; lastT = e.timeStamp; dy = 0; speed = 0
    }
    const move = (e: TouchEvent) => {
      const t = e.touches[0]
      if (mode === 'idle' || !t) return
      const d = t.clientY - y0
      if (mode === 'maybe') {
        if (d < 0 || Math.abs(t.clientX - x0) > Math.abs(d) + 4) { mode = 'idle'; return }   // a scroll or a sideways swipe
        e.preventDefault()   // from the first move, or the browser takes the gesture
        if (d < 6) return
        mode = 'drag'
        el.style.transition = 'none'
        el.style.animation = 'none'
      }
      e.preventDefault()
      dy = Math.max(0, d)
      speed = (t.clientY - lastY) / Math.max(1, e.timeStamp - lastT)
      lastY = t.clientY; lastT = e.timeStamp
      el.style.transform = `translateY(${dy}px)`
    }
    const end = () => {
      if (mode !== 'drag') { mode = 'idle'; return }
      mode = 'idle'
      const gone = dy > Math.min(160, el.offsetHeight * 0.3) || (speed > 0.5 && dy > 24)
      el.style.transition = 'transform 220ms cubic-bezier(.2, .8, .2, 1)'
      el.style.transform = gone ? `translateY(${el.offsetHeight}px)` : ''
      const reset = () => { el.style.transition = ''; el.style.transform = '' }
      // Closing unmounts the sheet; reset late so it never flashes back first.
      window.setTimeout(() => { if (gone) { close.current(); window.setTimeout(reset, 400) } else reset() }, 200)
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    off.current = () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [])
}
