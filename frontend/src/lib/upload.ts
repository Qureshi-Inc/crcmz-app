// CL-26 · Send a video: a resumable, chunked upload to /api/video-uploads.
//
// Sent in 8 MB chunks because Cloudflare refuses a request body over 100 MB. The
// upload lives in a module store, not a component, so it keeps going while the
// member moves around /app and the Clips summary bar can show its pill.
//
// A failure is a pause, not the end: wait, ask the server what it has, carry on.
// After 8 failed chunks in a row it pauses for a tap. The server keeps a session
// for 24 h keyed by `file_key`, so after a reload picking the same file resumes.
import { useSyncExternalStore } from 'react'
import { markSignedOut } from './session'
import type { Upload } from './clips'

export type UploadLimits = { max_bytes: number; max_seconds: number; min_seconds: number; max_caption: number; formats: string[] }
export type OpenSession = { upload_id: string; filename: string; size: number; received: number; created_at: number; expires_at: number }

export type UploadState =
  | { kind: 'idle' }
  | { kind: 'starting'; filename: string }
  | { kind: 'sending'; filename: string; sent: number; size: number; resumed: boolean; trouble: boolean; offline: boolean }
  | { kind: 'checking'; filename: string }
  | { kind: 'queued'; upload: Upload | null }
  | { kind: 'paused'; filename: string; sent: number; size: number }
  | { kind: 'failed'; filename: string; code: string; text: string }

const MAX_FAILS = 8

class Rejection extends Error {
  constructor(readonly status: number, readonly code: string, text: string) { super(text) }
}

let state: UploadState = { kind: 'idle' }
let current: { file: File; caption: string } | null = null
let busy = false
const listeners = new Set<() => void>()
const done = new Set<() => void>()

function set(s: UploadState) {
  state = s
  listeners.forEach((l) => l())
}

export function useUpload(): UploadState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}
export const uploadState = () => state
/** Called after the video is queued, so the uploads list can refetch. */
export function onUploadQueued(cb: () => void) { done.add(cb); return () => { done.delete(cb) } }
/** The file of the paused / failed upload still in memory, if any. */
export const heldFile = () => current?.file ?? null

export function resetUpload() {
  if (busy) return
  current = null
  set({ kind: 'idle' })
}

export const pct = (n: number, of: number) => (of > 0 ? Math.min(100, Math.floor((100 * n) / of)) : 0)

/** The summary-bar pill: "Uploading 42 %", "Queued ✓", "Paused — tap to resume". */
export function pillText(s: UploadState): string | null {
  switch (s.kind) {
    case 'starting': return 'Uploading 0 %'
    case 'sending': return `Uploading ${pct(s.sent, s.size)} %`
    case 'checking': return 'Checking the video…'
    case 'queued': return 'Queued ✓'
    case 'paused': return 'Paused — tap to resume'
    case 'failed': return 'Upload failed — tap for details'
    default: return null
  }
}

/** Words for a rejection (MC-PS-2); the server's detail otherwise. */
export function rejectionText(code: string, detail: string): string {
  switch (code) {
    case 'already_queued': return 'You already have one in the queue.'
    case 'duplicate': return 'This exact video was already sent.'
    case 'storage': return "Storage isn't reachable right now."
    case 'posting': case 'posted': return 'That video is already being posted.'
    case 'no_session': return 'The upload expired. Start it again.'
    case 'chunk': return 'The upload was cut into pieces that are too big. Reload and try again.'
    case 'signed_out': return "You're signed out. Sign in, then pick the same file to resume."
    default: return detail || "The upload didn't go through."
  }
}

// ── File checks ──────────────────────────────────────────────────────────────
export function formatOk(f: File, limits: UploadLimits): boolean {
  const ext = (f.name.split('.').pop() || '').toLowerCase()
  return limits.formats.includes(ext) || f.type === 'video/mp4' || f.type === 'video/quicktime'
}

/** Seconds from the file's metadata, or null when the browser can't read it (some MOVs). */
export function readDuration(f: File, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f)
    const v = document.createElement('video')
    let settled = false
    const finish = (d: number | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      v.removeAttribute('src')
      resolve(d)
    }
    const t = window.setTimeout(() => finish(null), timeoutMs)
    v.preload = 'metadata'
    v.muted = true
    v.onloadedmetadata = () => { window.clearTimeout(t); finish(Number.isFinite(v.duration) ? v.duration : null) }
    v.onerror = () => { window.clearTimeout(t); finish(null) }
    v.src = url
  })
}

/**
 * Identity of a file for resuming: the same pick after a reload or a dropped
 * connection must match, a different file must not. Size plus hashes of the first
 * and last MB, not the name or modified time, which iOS rewrites on every pick.
 * The same scheme as the classic page, so a resume works across the two.
 */
export async function fileKey(f: File): Promise<string> {
  const hex = async (b: Blob) => {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer()))
    return Array.from(h.slice(0, 12), (x) => x.toString(16).padStart(2, '0')).join('')
  }
  try {
    if (window.crypto?.subtle) {
      const M = 1048576
      return [f.size, await hex(f.slice(0, M)), await hex(f.slice(Math.max(0, f.size - M)))].join('|')
    }
  } catch { /* fall through */ }
  return [f.size, f.name, f.lastModified || 0].join('|')
}

// ── Transport ────────────────────────────────────────────────────────────────
type Reply = { ok: boolean; status: number; body: Record<string, unknown> }

async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Reply | null> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal })
    let body: Record<string, unknown> = {}
    try { body = (await res.json()) as Record<string, unknown> } catch { /* empty */ }
    if (res.status === 401) markSignedOut()
    return { ok: res.ok, status: res.status, body }
  } catch {
    return null // network error or timeout: the caller treats it as a pause
  } finally {
    window.clearTimeout(timer)
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

function reject(r: Reply): never {
  const code = r.status === 401 ? 'signed_out' : String(r.body.code || '')
  throw new Rejection(r.status, code, String(r.body.detail || `HTTP ${r.status}`))
}

const sleep = (ms: number) => new Promise((res) => window.setTimeout(res, ms))
function waitOnline(): Promise<void> {
  if (navigator.onLine !== false) return Promise.resolve()
  return new Promise((res) => window.addEventListener('online', () => res(), { once: true }))
}

type Session = { upload_id: string; chunk_bytes: number; size: number; received: number; resumed: boolean }

/** Start (or resume) sending `file`. A second call while one runs does nothing. */
export async function startUpload(file: File, caption: string): Promise<void> {
  if (busy) return
  busy = true
  current = { file, caption }
  const name = file.name
  let off = 0
  set({ kind: 'starting', filename: name })
  try {
    const key = await fileKey(file)
    const begin = async (): Promise<Session | null> => {
      const r = await call('/api/video-uploads/start', json({ filename: name, size: file.size, caption, file_key: key }), 30_000)
      if (!r) return null
      if (!r.ok) reject(r)
      return r.body as unknown as Session
    }
    let s = await begin()
    if (!s) throw Object.assign(new Error('paused'), { paused: true })
    off = s.received || 0
    const resumed = Boolean(s.resumed && off)
    const show = (trouble = false, offline = false) =>
      set({ kind: 'sending', filename: name, sent: off, size: file.size, resumed, trouble, offline })
    show()
    let fails = 0
    while (off < file.size) {
      const r = await call(
        `/api/video-uploads/chunk?id=${encodeURIComponent(s.upload_id)}&offset=${off}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(off, off + s.chunk_bytes) },
        120_000,
      )
      if (r?.ok) { off = Number(r.body.received) || off; fails = 0; show(); continue }
      // The server has a different amount than we think: carry on from its count.
      if (r && r.status === 409 && r.body.code === 'offset') { off = Number(r.body.received) || 0; show(); continue }
      if (r && r.status < 500 && r.status !== 404) reject(r)
      if (++fails > MAX_FAILS) throw Object.assign(new Error('paused'), { paused: true })
      show(true, navigator.onLine === false)
      await waitOnline()
      await sleep(Math.min(30_000, 1000 * 2 ** fails))
      try {
        const again = await begin()
        if (again) { s = again; off = again.received || 0; show(true) }
      } catch (e) {
        if (e instanceof Rejection && e.code !== 'storage') throw e
      }
    }
    set({ kind: 'checking', filename: name })
    const fin = await call('/api/video-uploads/finish', json({ upload_id: s.upload_id }), 180_000)
    // No reply to finish: the server may still be checking, so this is not a pause
    // (resuming would start over). The uploads list tells what happened.
    if (!fin) {
      current = null
      set({ kind: 'failed', filename: name, code: 'unconfirmed', text: "We couldn't confirm the upload. Check Your uploads before sending it again." })
      done.forEach((cb) => cb())
      return
    }
    if (!fin.ok) reject(fin)
    current = null
    set({ kind: 'queued', upload: (fin.body.upload as Upload) ?? null })
    done.forEach((cb) => cb())
  } catch (e) {
    if ((e as { paused?: boolean }).paused) {
      set({ kind: 'paused', filename: name, sent: off, size: file.size })
    } else if (e instanceof Rejection) {
      set({ kind: 'failed', filename: name, code: e.code, text: rejectionText(e.code, e.message) })
    } else {
      set({ kind: 'failed', filename: name, code: '', text: "The upload didn't go through." })
    }
  } finally {
    busy = false
  }
}

/** Resume the paused upload with the file still in memory. */
export function resumeUpload(): boolean {
  if (!current || busy) return false
  void startUpload(current.file, current.caption)
  return true
}
