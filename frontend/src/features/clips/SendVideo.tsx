// CL-26 / CL-28 · Send a video to @crcmzclan. A bottom sheet on a phone (`?upload`),
// an inline card at the top of the uploads column on desktop, the same as legacy.
// The transfer itself lives in lib/upload so it survives leaving the page.
import { useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/http'
import { fmtBytes, useUploads, type UploadsResponse } from '../../lib/clips'
import {
  formatOk, heldFile, onUploadQueued, pct, readDuration, resetUpload, resumeUpload, startUpload, useUpload,
  type UploadState,
} from '../../lib/upload'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { ClipSheet } from './ClipSheet'

const PORTAL_HREF = '/portal'

/** Refetch the uploads list whenever a video lands in the queue, wherever it was sent from. */
export function useUploadRefresh() {
  const qc = useQueryClient()
  useEffect(() => onUploadQueued(() => { void qc.invalidateQueries({ queryKey: ['uploads'] }) }), [qc])
}

export function UploadSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <ClipSheet open={open} onOpenChange={onOpenChange} title="📤 Send a video">
      <SendVideo />
    </ClipSheet>
  )
}

export function SendVideoCard({ focus, onFocused }: { focus: boolean; onFocused: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!focus || !ref.current) return
    ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' })
    ref.current.querySelector<HTMLElement>('.file-pick, .btn')?.focus({ preventScroll: true })
    onFocused()
  }, [focus, onFocused])
  return (
    <section ref={ref} className="glass send-card" aria-labelledby="send-h">
      <h2 id="send-h" className="section-h2">📤 Send a video</h2>
      <SendVideo />
    </section>
  )
}

function SendVideo() {
  const q = useUploads()
  const up = useUpload()
  if (q.isPending) return <SkeletonRows n={2} />
  if (q.error instanceof ApiError && q.error.status === 403) {
    return (
      <div className="send-body">
        <p style={{ margin: 0 }}>Link your PlayStation account — uploads are credited to your PSN ID.</p>
        <a className="btn btn-secondary" href={PORTAL_HREF}>Link PSN</a>
      </div>
    )
  }
  if (q.error instanceof ApiError && q.error.status === 401) {
    return <div className="send-body"><p style={{ margin: 0 }}>Sign in to upload videos.</p></div>
  }
  if (!q.data) return <div className="send-body"><ErrorStrip text="Uploads didn't load" onRetry={() => q.refetch()} /></div>
  return <SendForm d={q.data} up={up} />
}

const running = (s: UploadState) => s.kind === 'starting' || s.kind === 'sending' || s.kind === 'checking'

function SendForm({ d, up }: { d: UploadsResponse; up: UploadState }) {
  const L = d.limits
  const [file, setFile] = useState<File | null>(() => heldFile())
  const [caption, setCaption] = useState('')
  const [problem, setProblem] = useState('')
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const ids = { file: useId(), cap: useId(), msg: useId() }
  const busy = running(up)
  const minutes = Math.round(L.max_seconds / 60)
  const open = d.open_session && d.open_session.received > 0 ? d.open_session : null

  // A queued / running upload owns the form: show its state, not a fresh pick.
  const blocked = !d.can_upload && !busy && up.kind !== 'queued'

  async function pick(f: File | null) {
    setProblem('')
    setFile(null)
    if (!f) return
    if (up.kind === 'failed' || up.kind === 'paused' || up.kind === 'queued') resetUpload()
    if (!formatOk(f, L)) { setProblem('Pick an MP4 or MOV video.'); return }
    if (f.size > L.max_bytes) { setProblem(`That video is ${fmtBytes(f.size)}. The limit is ${fmtBytes(L.max_bytes)}.`); return }
    setChecking(true)
    const secs = await readDuration(f)
    setChecking(false)
    if (secs !== null && secs > L.max_seconds + 0.5) { setProblem(`That video is over ${minutes} minutes. Trim it and try again.`); return }
    if (secs !== null && secs < L.min_seconds) { setProblem(`That video is shorter than ${L.min_seconds} seconds.`); return }
    setFile(f)
  }

  function send() {
    if (busy) return
    if (!file) { setProblem('Pick a video first.'); inputRef.current?.focus(); return }
    setProblem('')
    void startUpload(file, caption.trim())
  }

  function again() {
    resetUpload()
    setFile(null)
    setCaption('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const canResume = (up.kind === 'paused' || (up.kind === 'failed' && up.code === 'storage')) && heldFile() !== null

  return (
    <div className="send-body">
      <p className="meta" style={{ margin: 0 }}>
        Muse posts it to Instagram, TikTok and YouTube, credited to <b>{d.psn_id}</b>. MP4 or MOV, up to {minutes} minutes
        and {fmtBytes(L.max_bytes)}. One video in the queue at a time.
      </p>

      {blocked ? (
        <p className="send-msg" role="status">Your previous video hasn't been posted yet. You can send another once it's posted or skipped.</p>
      ) : up.kind === 'queued' ? (
        <div className="send-done" role="status">
          <p className="send-msg" data-tone="ok">Queued ✓ — Muse will post it soon.</p>
        </div>
      ) : (
        <>
          {open && !busy && up.kind === 'idle' && (
            <p className="send-msg" data-tone="info">
              Unfinished upload: <b>{open.filename}</b> ({pct(open.received, open.size)} %). Pick the same file and tap Send to carry on where it stopped.
            </p>
          )}
          <div>
            <span className="field-label" id={ids.file}>Video</span>
            <label className="btn btn-secondary file-pick" aria-disabled={busy || undefined} tabIndex={busy ? -1 : 0}
              onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); inputRef.current?.click() } }}>
              {file ? 'Choose a different video' : 'Choose a video'}
              <input
                ref={inputRef} type="file" accept="video/mp4,video/quicktime,.mp4,.mov" className="sr-only" tabIndex={-1}
                aria-labelledby={ids.file} disabled={busy}
                onChange={(e) => void pick(e.currentTarget.files?.[0] ?? null)}
              />
            </label>
            {checking ? <p className="meta send-file">Reading the video…</p>
              : file && <p className="meta send-file">{file.name} · {fmtBytes(file.size)}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor={ids.cap}>Caption <span className="meta">(optional)</span></label>
            <textarea
              id={ids.cap} className="input send-cap" maxLength={L.max_caption} value={caption} disabled={busy}
              onChange={(e) => setCaption(e.target.value)} placeholder="What's happening in this one?" rows={3}
            />
            <p className="meta send-count num" aria-live="off">{caption.length}/{L.max_caption}</p>
          </div>
          <Progress up={up} />
          <p className="send-msg" id={ids.msg} role="status" data-tone={problem || up.kind === 'failed' || up.kind === 'paused' ? 'error' : undefined}>
            {problem || statusText(up)}
          </p>
          <div className="send-actions">
            {canResume ? (
              <button type="button" className="btn btn-primary" onClick={() => resumeUpload()}>Resume upload</button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={send} aria-disabled={busy || checking || undefined} aria-busy={busy || undefined} aria-describedby={ids.msg}>
                {busy ? (up.kind === 'checking' ? 'Checking…' : 'Sending…') : '📤 Send'}
              </button>
            )}
            {(up.kind === 'failed' || up.kind === 'paused') && (
              <button type="button" className="btn btn-ghost" onClick={again}>Start over</button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Progress({ up }: { up: UploadState }) {
  if (up.kind !== 'sending' && up.kind !== 'starting' && up.kind !== 'checking' && up.kind !== 'paused') return null
  const n = up.kind === 'sending' || up.kind === 'paused' ? pct(up.sent, up.size) : up.kind === 'checking' ? 100 : 0
  return (
    <div className="send-bar" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={n}>
      <i style={{ width: `${n}%` }} data-paused={up.kind === 'paused' || undefined} />
    </div>
  )
}

function statusText(s: UploadState): string {
  switch (s.kind) {
    case 'starting': return 'Starting…'
    case 'sending': {
      const p = pct(s.sent, s.size)
      if (s.offline) return 'Connection lost — waiting to reconnect…'
      if (s.trouble) return `Connection trouble at ${p} % — retrying…`
      return s.resumed && p < 100 ? `Resumed · uploading ${p} %` : `Uploading ${p} %`
    }
    case 'checking': return 'Checking the video…'
    case 'paused':
      return `Upload paused at ${pct(s.sent, s.size)} % — the connection keeps dropping. Tap Resume upload when you're back online. `
        + 'If you reload, pick the same file. Kept for 24 hours.'
    case 'failed': return s.text
    default: return ''
  }
}
