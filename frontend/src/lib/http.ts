// Every request the app makes goes through here, so a 401 anywhere can flip the
// shared signed-out flag (PS-0 "signed-out" state) without each caller knowing.
import { markSignedOut } from './session'

export class ApiError extends Error {
  readonly status: number
  readonly detail: string
  readonly retryAfter: number | null
  constructor(status: number, detail: string, retryAfter: number | null) {
    super(detail || `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.retryAfter = retryAfter
  }
}

/** A transport failure: the request may never have reached the server, or the reply never came back. */
export class NetworkError extends Error {
  readonly timedOut: boolean
  constructor(message: string, timedOut: boolean) {
    super(message)
    this.name = 'NetworkError'
    this.timedOut = timedOut
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000

/** Retry-After is whole seconds from `_rate_limit`; fall back to the "try again in Ns" detail. */
export function parseRetryAfter(res: Response, detail: string): number | null {
  const header = res.headers.get('retry-after')
  if (header) {
    const n = Number.parseInt(header, 10)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const m = /in\s+(\d+(?:\.\d+)?)s/i.exec(detail)
  if (m?.[1]) return Math.ceil(Number(m[1]))
  return null
}

async function readDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return ''
    try {
      const body = JSON.parse(text) as { detail?: unknown; error?: unknown }
      const d = body.detail ?? body.error
      return typeof d === 'string' ? d : ''
    } catch {
      return ''
    }
  } catch {
    return ''
  }
}

type RequestOpts = {
  timeoutMs?: number
  signal?: AbortSignal
  body?: unknown
  method?: 'GET' | 'POST' | 'DELETE'
  /** A 401 here is an answer, not an expired session (the account probe). */
  quiet401?: boolean
}

/**
 * fetch with a hard client timeout. Resolves with the parsed JSON body for a 2xx,
 * rejects with ApiError for any other status and NetworkError for transport failure.
 */
export async function request<T>(url: string, opts: RequestOpts = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, body, method = body === undefined ? 'GET' : 'POST', quiet401 = false } = opts
  const ctrl = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort)
  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: 'no-store',
    })
  } catch (e) {
    throw new NetworkError(timedOut ? 'timed out' : (e as Error)?.message || 'network error', timedOut)
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!res.ok) {
    const detail = await readDetail(res)
    if (res.status === 401 && !quiet401) markSignedOut()
    throw new ApiError(res.status, detail, res.status === 429 ? parseRetryAfter(res, detail) : null)
  }
  try {
    return (await res.json()) as T
  } catch {
    // A 2xx whose body did not parse. For a GET that is a broken response; the caller
    // decides what it means for a send.
    return {} as T
  }
}

export const getJSON = <T,>(url: string, signal?: AbortSignal) => request<T>(url, { signal })
