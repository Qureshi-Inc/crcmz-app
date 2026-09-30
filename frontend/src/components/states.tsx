// The shared state vocabulary (JOURNEY.md §Page specs): loading, error and stale.
import { useEffect, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'

/** Re-render on an interval, for "Updated N min ago" and the 2× cadence check. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

/**
 * Stale = we have good data, but the last poll failed or no success landed within
 * twice the cadence. The data stays on screen; only a marker is added.
 */
export function useStale(q: UseQueryResult<unknown>, cadenceMs: number): { stale: boolean; minutes: number } {
  const now = useNow(15_000)
  if (q.data === undefined || !q.dataUpdatedAt) return { stale: false, minutes: 0 }
  const age = now - q.dataUpdatedAt
  const stale = q.isError || age > cadenceMs * 2
  return { stale, minutes: Math.max(1, Math.round(age / 60_000)) }
}

export function StaleMarker({ minutes, onRetry }: { minutes: number; onRetry: () => void }) {
  return (
    <span className="stale">
      Updated {minutes} min ago
      <button type="button" className="btn btn-ghost" onClick={onRetry}>Retry</button>
    </span>
  )
}

export function ErrorStrip({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="error-strip" role="alert">
      <span>{text}</span>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button>
    </div>
  )
}

/** After 10 s of first load: "Still loading…" + Retry. */
export function SlowLoad({ onRetry }: { onRetry: () => void }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 10_000)
    return () => window.clearTimeout(t)
  }, [])
  if (!slow) return null
  return (
    <div className="stale" role="status" style={{ padding: 'var(--space-2) var(--space-4)' }}>
      Still loading…
      <button type="button" className="btn btn-ghost" onClick={onRetry}>Retry</button>
    </div>
  )
}

export function SkeletonRows({ n, height = 56 }: { n: number; height?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="presence-row" style={{ minHeight: height }}>
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} />
          <div style={{ flex: 1, display: 'grid', gap: 8 }}>
            <div className="skeleton" style={{ height: 12, width: `${55 - (i % 3) * 10}%` }} />
            <div className="skeleton" style={{ height: 10, width: `${35 + (i % 2) * 10}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}
