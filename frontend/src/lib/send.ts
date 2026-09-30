// F-0 · the send outcome model (JOURNEY.md §Flows).
//
// PSN group messages cannot be deduplicated by the server, so a retry can double-post.
// Everything that posts to the group goes through `sendOnce`, which:
//   - makes exactly one request and never retries;
//   - classifies the result into Sent / Not sent / Slow down / Unknown;
//   - treats network errors, timeouts and 5xx other than 503 as Unknown, because the
//     message may already have left (for /v2/send and /v2/squad a 500 covers both
//     "PSN said no" and "an exception after the request left").
//
// The `psn_send` limiter is shared by every tile, Rally, Squad Up and the composer,
// so its countdown lives in one store and every control on it reads the same value.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, NetworkError, request, DEFAULT_TIMEOUT_MS } from './http'

export type SendOutcome =
  | { kind: 'sent'; data: Record<string, unknown> }
  | { kind: 'notsent'; status: number; reason: string }
  | { kind: 'slow'; seconds: number }
  | { kind: 'unknown'; reason: string }

export type SendState = 'idle' | 'sending' | 'sent' | 'notsent' | 'unknown' | 'countdown'

export async function sendOnce(url: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SendOutcome> {
  try {
    const data = await request<Record<string, unknown>>(url, { body: body ?? {}, timeoutMs })
    return { kind: 'sent', data }
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 429) return { kind: 'slow', seconds: Math.max(1, e.retryAfter ?? 10) }
      if (e.status >= 500 && e.status !== 503) return { kind: 'unknown', reason: `HTTP ${e.status}` }
      return { kind: 'notsent', status: e.status, reason: e.detail }
    }
    if (e instanceof NetworkError) return { kind: 'unknown', reason: e.timedOut ? 'timed out' : 'network' }
    return { kind: 'unknown', reason: 'network' }
  }
}

// ── Copy (MC-F0) ──────────────────────────────────────────────────────────────
export const SEND_LABEL: Record<Exclude<SendState, 'idle' | 'countdown'>, string> = {
  sending: 'Sending…',
  sent: 'Sent ✓',
  notsent: 'Not sent',
  unknown: 'Unknown',
}
export const slowLabel = (n: number) => `Slow down · ${n}s`
export const slowToast = (n: number) => `Slow down a sec — try again in ${n}s.`
export const UNKNOWN_TOAST = 'The send may or may not have landed. Keep the draft so nothing is lost.'
export const UNKNOWN_INLINE = 'This may or may not have sent. Check the group before sending again.'

export function notSentToast(status: number, reason: string): string {
  if (status === 503) return "The PSN group isn't reachable right now."
  if (status === 401) return "Didn't go. You're signed out."
  return reason ? `Didn't go. ${reason}` : "Didn't go."
}

// ── A cooldown store, one per rate-limit bucket ──────────────────────────────
export class Cooldown {
  private until = 0
  private snap = 0
  private listeners = new Set<() => void>()
  private timer: number | null = null

  start(seconds: number) {
    this.until = Math.max(this.until, Date.now() + seconds * 1000)
    this.emit()
    this.schedule()
  }
  remaining(): number {
    return Math.max(0, Math.ceil((this.until - Date.now()) / 1000))
  }
  /** Stable between ticks, for useSyncExternalStore. */
  snapshot = () => this.snap
  subscribe = (cb: () => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
  private schedule() {
    if (this.timer !== null) return
    this.timer = window.setInterval(() => {
      this.emit()
      if (this.remaining() === 0 && this.timer !== null) {
        window.clearInterval(this.timer)
        this.timer = null
      }
    }, 250)
  }
  private emit() {
    const next = this.remaining()
    if (next === this.snap) return
    this.snap = next
    this.listeners.forEach((l) => l())
  }
}

export function useCooldown(c: Cooldown): number {
  return useSyncExternalStore(c.subscribe, c.snapshot)
}

/** The `psn_send` bucket: every tile, Rally ▶, Squad Up and the composer Send. */
export const psnCooldown = new Cooldown()

// ── One PSN send in flight at a time ─────────────────────────────────────────
// A tap burst across several tiles is still one request: while a PSN send is in
// flight every PSN control ignores taps.
let inFlight: string | null = null
const flightListeners = new Set<() => void>()
function setInFlight(v: string | null) { inFlight = v; flightListeners.forEach((l) => l()) }
export function usePsnInFlight(): string | null {
  return useSyncExternalStore((cb) => { flightListeners.add(cb); return () => { flightListeners.delete(cb) } }, () => inFlight)
}

/**
 * Run one PSN send for control `id`. Returns null (and sends nothing) if another
 * PSN send is in flight or the shared cooldown is running.
 */
export async function psnSend(id: string, url: string, body: unknown): Promise<SendOutcome | null> {
  if (inFlight !== null || psnCooldown.remaining() > 0) return null
  setInFlight(id)
  try {
    const out = await sendOnce(url, body)
    if (out.kind === 'slow') psnCooldown.start(out.seconds)
    return out
  } finally {
    setInFlight(null)
  }
}

/** A transient state that falls back to idle after `ms`. */
export function useTransient<T>(idle: T, ms: number): [T, (v: T, hold?: number) => void] {
  const [state, setState] = useState<{ v: T; hold: number; seq: number }>({ v: idle, hold: ms, seq: 0 })
  useEffect(() => {
    if (state.v === idle || state.hold <= 0) return
    const t = window.setTimeout(() => setState((s) => (s.seq === state.seq ? { ...s, v: idle } : s)), state.hold)
    return () => window.clearTimeout(t)
  }, [state, idle])
  return [state.v, (v: T, hold = ms) => setState((s) => ({ v, hold, seq: s.seq + 1 }))]
}
