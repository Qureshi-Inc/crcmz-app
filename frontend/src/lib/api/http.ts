/**
 * The one way this app talks to the backend.
 *
 * Every rule the execution plan asks for lives here rather than in each feature, so
 * there is exactly one place that decides what a 401 means, what a non-JSON body
 * means, and whether a failed write might still have landed.
 */

/** A request that failed in a way the server described. */
export class ApiError extends Error {
  readonly status: number
  /** Seconds until a retry is allowed, from Retry-After. Only set for 429/503. */
  readonly retryAfter: number | null
  /** The raw body, when it was not JSON — an edge 413 is an HTML page. */
  readonly rawBody: string | null

  constructor(status: number, message: string, opts: { retryAfter?: number | null; rawBody?: string | null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryAfter = opts.retryAfter ?? null
    this.rawBody = opts.rawBody ?? null
  }

  /** The session is gone. The shell turns this into a sign-in prompt, once. */
  get isAuthExpired() {
    return this.status === 401
  }

  /** Signed in, but this account may not do this. Not a network problem. */
  get isForbidden() {
    return this.status === 403
  }

  get isRateLimited() {
    return this.status === 429
  }
}

/**
 * The request never reached a server that answered, or the answer never arrived.
 *
 * `uncertain` is the important part. For a GET, a transport failure means we have no
 * data — harmless. For a POST it means we genuinely do not know whether the server
 * acted: the request may have been fully processed and the response lost. The UI has
 * to say so rather than claim failure, and must not resend on the user's behalf.
 */
export class NetworkError extends Error {
  readonly uncertain: boolean
  constructor(message: string, uncertain: boolean) {
    super(message)
    this.name = 'NetworkError'
    this.uncertain = uncertain
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface RequestOptions {
  method?: string
  /** Sent as JSON. Use `form` for multipart. */
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  /** Milliseconds. 0 disables the timeout (for a deliberately long poll). */
  timeoutMs?: number
  headers?: Record<string, string>
  /**
   * Validate and narrow the parsed body. A TypeScript annotation is an assertion
   * about code, not a check on bytes that arrived over a network, so every call site
   * that cares passes one of these.
   */
  parse?: (data: unknown) => unknown
}

const DEFAULT_TIMEOUT = 15_000

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After')
  if (!raw) return null
  const asInt = Number.parseInt(raw, 10)
  if (Number.isFinite(asInt)) return Math.max(0, asInt)
  // The header also permits an HTTP date.
  const asDate = Date.parse(raw)
  if (Number.isFinite(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000))
  return null
}

/** The backend reports errors as {"detail": ...}; FastAPI validation nests a list. */
function messageFromBody(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim()) return body.trim()
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
    if (Array.isArray(detail)) {
      const first = detail[0] as { msg?: unknown } | undefined
      if (first && typeof first.msg === 'string') return first.msg
    }
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string' && error.trim()) return error.trim()
  }
  return `Request failed (${status})`
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT

  // Two reasons a request can stop: the caller navigated away (options.signal) or we
  // ran out of patience. Both have to abort the fetch, so they are combined.
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    : null

  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
  let payload: BodyInit | undefined
  if (options.form) {
    payload = options.form // let the browser set the multipart boundary
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }

  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
      // The session is a cookie; this is same-origin, but be explicit.
      credentials: 'same-origin',
      // The entry document may be cached; API reads must not be.
      cache: 'no-store',
    })
  } catch (err) {
    if (options.signal?.aborted) throw err // the caller cancelled; not our failure
    const uncertain = !SAFE_METHODS.has(method)
    const what = timedOut ? 'timed out' : 'could not reach the app'
    throw new NetworkError(
      uncertain
        ? `The request ${what}. It may or may not have gone through.`
        : `The request ${what}.`,
      uncertain,
    )
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  // 204, and any other response with nothing in it.
  const noContent = res.status === 204 || res.headers.get('Content-Length') === '0'
  const contentType = res.headers.get('Content-Type') ?? ''
  const looksJson = contentType.includes('json')

  let body: unknown = null
  let raw: string | null = null
  if (!noContent) {
    raw = await res.text().catch(() => null)
    if (raw && looksJson) {
      try {
        body = JSON.parse(raw)
      } catch {
        // Claimed JSON and was not. Treat as an unusable response rather than
        // crashing a screen on a syntax error.
        body = null
      }
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, messageFromBody(body ?? raw, res.status), {
      retryAfter: retryAfterSeconds(res),
      // Keep the raw body only when it was not JSON — that is the case worth showing
      // a human ("Cloudflare rejected this before it reached the app").
      rawBody: looksJson ? null : raw,
    })
  }

  if (noContent) return undefined as T
  if (raw !== null && !looksJson) {
    // A 200 that is not JSON where JSON was expected. This is what an SPA fallback
    // serving index.html looks like, and it must not be mistaken for data.
    throw new ApiError(res.status, 'The app returned an unexpected response.', { rawBody: raw })
  }
  if (options.parse) return options.parse(body) as T
  return body as T
}

export const api = {
  get: <T>(path: string, o: Omit<RequestOptions, 'method' | 'body' | 'form'> = {}) =>
    request<T>(path, { ...o, method: 'GET' }),
  post: <T>(path: string, body?: unknown, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...o, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...o, method: 'PUT', body }),
  del: <T>(path: string, o: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...o, method: 'DELETE' }),
}

/** Human-readable text for anything this module can throw. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.isAuthExpired) return 'Your session expired. Sign in again to continue.'
    if (err.isForbidden) return 'This account cannot do that.'
    if (err.isRateLimited) {
      return err.retryAfter
        ? `Too many requests — try again in ${err.retryAfter}s.`
        : 'Too many requests — give it a moment.'
    }
    return err.message
  }
  if (err instanceof NetworkError) return err.message
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong.'
}
