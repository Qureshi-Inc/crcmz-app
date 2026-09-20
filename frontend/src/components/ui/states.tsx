import type { ReactNode } from 'react'
import { ApiError, NetworkError, errorMessage } from '@/lib/api/http'
import { Button, Card, cx } from './index'

/**
 * The four states every server-backed section can be in, as components, so no screen
 * gets to invent its own answer to "what does a failure look like here".
 *
 * The rule the plan sets and these enforce: a failure is never a dead end. Something
 * either offers a retry, explains why retrying will not help (403), or says when it
 * is allowed (429).
 */

/* ── Loading ──────────────────────────────────────────────────────────────────
 * A skeleton shaped like the thing that is coming, not a spinner. Two reasons: the
 * space is reserved so the layout does not jump when data lands (CLS), and the shape
 * tells the user what to expect.
 */
export function SkeletonRows({
  rows = 3,
  /**
   * Match the real row's height. The point of a skeleton is to reserve the space the
   * content will take; a placeholder that is the wrong height is a layout shift with
   * extra steps.
   */
  height = 68,
  className,
}: {
  rows?: number
  height?: number
  className?: string
}) {
  return (
    <div className={cx('flex flex-col gap-2', className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: `${height}px` }} />
      ))}
    </div>
  )
}

export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <div
      className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]"
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton h-[84px]" />
      ))}
    </div>
  )
}

/**
 * Announces "loading" once, politely, for anyone not looking at the skeleton.
 * Deliberately not aria-live="assertive": a background refresh must not interrupt.
 */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/* ── Empty ────────────────────────────────────────────────────────────────────
 * An empty result is not a failure and must not look like one. It explains why it is
 * empty and offers the next thing to do.
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string
  body?: ReactNode
  action?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      {icon && <div className="mb-1 text-2xl opacity-70">{icon}</div>}
      <p className="text-base font-semibold">{title}</p>
      {body && (
        <p className="max-w-[46ch] text-sm text-[var(--color-fg-muted)]">{body}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/* ── Error ────────────────────────────────────────────────────────────────── */

/**
 * What went wrong and what to do about it.
 *
 * The status drives the wording, because these mean genuinely different things to the
 * person reading them:
 *   403 — it is not broken, this account may not do it. No Retry: it would fail again.
 *   429 — it will work, later. Say when.
 *   401 — sign in; handled by the shell, so this just points at it.
 *   network — we do not know if it arrived, when it was a write.
 */
export function ErrorState({
  error,
  onRetry,
  retrying = false,
  what,
}: {
  error: unknown
  onRetry?: () => void
  retrying?: boolean
  /** What failed, for the heading: "clips", "the giveaway". */
  what?: string
}) {
  const isForbidden = error instanceof ApiError && error.isForbidden
  const isRateLimited = error instanceof ApiError && error.isRateLimited
  const retryAfter = error instanceof ApiError ? error.retryAfter : null
  const uncertain = error instanceof NetworkError && error.uncertain

  const heading = isForbidden
    ? 'Not available for this account'
    : what
      ? `Could not load ${what}`
      : 'Something went wrong'

  // Retrying a 403 just fails again; offering the button implies it might not.
  const canRetry = Boolean(onRetry) && !isForbidden

  return (
    <div role="alert" className="flex flex-col items-center gap-2.5 px-5 py-9 text-center">
      <p className="text-base font-semibold">{heading}</p>
      <p className="max-w-[52ch] text-sm text-[var(--color-fg-muted)]">
        {errorMessage(error)}
      </p>
      {uncertain && (
        <p className="max-w-[52ch] text-sm text-[var(--color-warn-text)]">
          Check before trying again — it may already have gone through.
        </p>
      )}
      {isRateLimited && retryAfter !== null && (
        <p className="text-sm text-[var(--color-fg-subtle)]">
          You can try again in {retryAfter}s.
        </p>
      )}
      {canRetry && (
        <Button
          variant="secondary"
          onClick={onRetry}
          pending={retrying}
          pendingLabel="Retrying…"
          className="mt-1"
        >
          Retry
        </Button>
      )}
    </div>
  )
}

/**
 * A section whose data failed while the rest of the page is fine.
 *
 * Wrapped in a Card so it reads as "this box is broken" rather than "the page is
 * broken" — a secondary widget failing must not look like an outage.
 */
export function SectionError({
  error,
  onRetry,
  what,
}: {
  error: unknown
  onRetry?: () => void
  what?: string
}) {
  return (
    <Card>
      <ErrorState error={error} onRetry={onRetry} what={what} />
    </Card>
  )
}

/**
 * Shown when a refresh failed but the data already on screen is still usable.
 *
 * The plan is explicit about this: keep the previous data visible and *identify* it as
 * stale. Blanking a working screen because a background poll failed is worse than
 * being a minute out of date.
 */
export function StaleNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div
      role="status"
      className={cx(
        'flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)]',
        'border border-[var(--color-warn)]/35 bg-[var(--color-warn)]/10 px-3 py-2',
        'text-sm text-[var(--color-warn-text)]',
      )}
    >
      <span>Showing the last data we have — the refresh failed.</span>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Refresh
        </Button>
      )}
    </div>
  )
}

/** "Updated 2m ago", so nobody has to guess how live a number is. */
export function Freshness({ at, stale }: { at: number | null; stale?: boolean }) {
  if (at === null) return null
  return (
    <span
      className={cx(
        'text-xs',
        stale ? 'text-[var(--color-warn-text)]' : 'text-[var(--color-fg-subtle)]',
      )}
    >
      {stale ? 'Stale · last updated ' : 'Updated '}
      <RelativeTime at={at} />
    </span>
  )
}

export function RelativeTime({ at }: { at: number | string }) {
  const ms = typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(ms)) return null
  const iso = new Date(ms).toISOString()
  return <time dateTime={iso}>{relative(ms)}</time>
}

/**
 * "2m ago" / "in 3d".
 *
 * Both directions, because this is used for a scheduled montage build and a giveaway
 * reveal as well as for a timestamp in the past. Subtracting without checking the sign
 * made every future date land in the `< 10 seconds` branch and render as "just now",
 * which said the next montage was already happening.
 */
export function relative(ms: number): string {
  const deltaSecs = Math.round((Date.now() - ms) / 1000)
  const future = deltaSecs < 0
  const secs = Math.abs(deltaSecs)
  const said = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`)

  if (secs < 10) return future ? 'in a moment' : 'just now'
  if (secs < 60) return said(secs, 's')
  const mins = Math.round(secs / 60)
  if (mins < 60) return said(mins, 'm')
  const hours = Math.round(mins / 60)
  if (hours < 24) return said(hours, 'h')
  return said(Math.round(hours / 24), 'd')
}
