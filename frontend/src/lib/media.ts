import { useSyncExternalStore } from 'react'

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(query).matches,
  )
}

/** ≥ 1024 px: sidebar + Chat Board panel instead of tab bar + sheet (DESIGN.md §Responsive). */
export const useDesktop = () => useMediaQuery('(min-width: 1024px)')
export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)')

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
export function writeLocal(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode: not fatal */ }
}
