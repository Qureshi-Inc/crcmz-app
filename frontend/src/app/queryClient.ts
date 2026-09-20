import { QueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError } from '@/lib/api/http'

/**
 * Query defaults, chosen rather than inherited.
 *
 * TanStack Query out of the box treats everything as stale immediately, refetches on
 * window focus and on mount, and retries three times with backoff. For this app that
 * is wrong in three specific ways:
 *
 *   - Refetching on every focus means tabbing back to the browser re-runs the
 *     WhatsApp analytics — nine queries over ~10k messages. Presence is worth
 *     refetching on focus; a 400-day analytics aggregate is not.
 *   - Retrying a 401 three times turns one expired session into four failed requests
 *     and a slow, confusing sign-in prompt. A 403 will never succeed on retry either.
 *   - Retrying a *mutation* is actively dangerous here: /v2/send posts to a real PSN
 *     group and the giveaway draw endpoints are not idempotent.
 *
 * So staleness is declared per feature (see CACHE below) and retries only cover the
 * case retries are for: a read that failed in transit.
 */

/** How long each kind of data stays fresh, and how often it re-reads itself. */
export const CACHE = {
  /** Who is online. The legacy dashboard polled this every 30s; keep that. */
  presence: { staleTime: 20_000, refetchInterval: 30_000 },
  /** Today's hype. Legacy cadence was 60s. */
  hype: { staleTime: 45_000, refetchInterval: 60_000 },
  /** Clip catalogue and montage state: changes when a clip arrives, not on a clock. */
  clips: { staleTime: 60_000, refetchInterval: false as const },
  /** Operational diagnostics. Only mounted on the admin screen. */
  diagnostics: { staleTime: 15_000, refetchInterval: 30_000 },
  /** Expensive aggregates. Re-read when the user asks, not on focus. */
  analytics: { staleTime: 10 * 60_000, refetchInterval: false as const },
  /** Stored conversation and facts — server-owned, cheap, but not clock-driven. */
  conversation: { staleTime: 15_000, refetchInterval: false as const },
  /** Things that essentially never change within a session. */
  static: { staleTime: 30 * 60_000, refetchInterval: false as const },
} as const

function shouldRetry(failureCount: number, error: unknown): boolean {
  // Nothing about the request will be different next time.
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403 || error.status === 404) return false
    // 429: backing off is the server's instruction, but hammering is not. One retry,
    // and the UI shows Retry-After so the user knows when.
    if (error.status === 429) return failureCount < 1
    // 5xx is worth one more go; a 4xx is our fault and will repeat.
    if (error.status >= 500) return failureCount < 2
    return false
  }
  if (error instanceof NetworkError) return failureCount < 2
  return false
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // No blanket staleTime: a query that has not declared one should be obviously
        // wrong in review rather than quietly using a default that suits nothing.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: attempt => Math.min(1_000 * 2 ** attempt, 8_000),
        // Off deliberately — see the note above. Features that want it opt in.
        refetchOnWindowFocus: false,
        // On reconnect, yes: data on screen is known to be stale after an outage.
        refetchOnReconnect: true,
        refetchOnMount: true,
        // Keep the previous page's data on screen while the next loads, so changing a
        // filter does not blank the screen. Staleness is labelled instead.
        placeholderData: (prev: unknown) => prev,
      },
      mutations: {
        // Never. A send, a draw, or a reveal that we are unsure about is the user's
        // call, with an explicit button — not something to replay behind their back.
        retry: false,
      },
    },
  })
}
