// Swipe-down-to-close for bottom sheets. An accelerator only: every sheet also has a
// visible Close button and closes on Escape and on a scrim tap.
import { useRef } from 'react'
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
