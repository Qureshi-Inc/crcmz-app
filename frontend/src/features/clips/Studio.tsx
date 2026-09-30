// PS-2 · The Studio (CL-12–20): a full-viewport editor for one reel at
// /app/clips/{id}/edit. The Live view rebuilds the reel from the source video
// with CSS transforms (crop, zoom, label, subtitles), so every edit shows at once;
// Render produces the exact file Muse would post.
//
// The edit lives in a reducer (lib/studio). Anything that moves with playback
// (the crop transform, subtitle line, zoom spot, playhead, clock) is painted from
// a requestAnimationFrame loop straight onto the DOM, not through React state.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from '../../components/toast'
import { useTitle } from '../../app/title'
import { ApiError, getJSON, request } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { fmtAgo, fmtDuration, whenTs } from '../../lib/clips'
import {
  CAPTION_MAX, LABEL_MAX, NH, NW, SUB_MAX, aiSubs, boxPx, clamp, clipPath, cropAt, editBody, editReducer, f1, fmtScale,
  hasTraj, igLink, initEdit, pipeMessage, placeBox, r2, renderPath, resizeBox, rulerMarks, subAt, validate, zoomAt, zoomOffset,
  type ClipDetail, type Edit, type EditAction, type RenderStatus, type Trajectory,
} from '../../lib/studio'
import { ConfirmDialog } from './ClipSheet'

type View = 'live' | 'reel' | 'frame'
type Tool = 'trim' | 'crop' | 'zoom' | 'text' | 'subs'
type Confirm = 'save' | 'force' | 'veto' | 'leave'
type RenderRun = { kind: 'idle' } | { kind: 'running'; secs: number | null } | { kind: 'failed'; text: string }

const TOOLS: [Tool, string, string][] = [['trim', '✂️', 'Trim'], ['crop', '🔲', 'Crop'], ['zoom', '🔍', 'Zoom'], ['text', '🔤', 'Text'], ['subs', '💬', 'Subs']]
const TOOL_TITLE: Record<Tool, string> = { trim: 'Trim', crop: 'Crop', zoom: 'Zoom', text: 'Text', subs: 'Subtitles' }
const POLL_MS = 2000

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.detail || `HTTP ${e.status}`
  return 'no answer from the server'
}

function loadError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return "This clip wasn't found, or it isn't one of yours."
  if (e instanceof ApiError && (e.status === 502 || e.status === 503)) return 'Reel review is unreachable right now.'
  if (e instanceof ApiError && e.status === 403) return 'Link your PlayStation account to edit your reels.'
  return "This clip didn't load."
}

function useClose() {
  const navigate = useNavigate()
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/clips', { replace: true })
  }, [navigate])
}

export function StudioPage() {
  const { id = '' } = useParams()
  useTitle('Studio')
  const close = useClose()
  const q = useQuery({
    queryKey: ['reel', id],
    queryFn: ({ signal }) => getJSON<ClipDetail>(clipPath(id), signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    const el = document.documentElement
    const prev = el.style.overflow
    el.style.overflow = 'hidden'
    return () => { el.style.overflow = prev }
  }, [])

  return (
    <div className="studio" role="dialog" aria-modal="true" aria-label="Reel editor">
      {q.isPending ? (
        <div className="st-loading" role="status"><div className="st-spin" aria-hidden="true" />Loading clip…</div>
      ) : !q.data ? (
        <div className="st-loading" role="alert">
          <p style={{ margin: 0 }}>{loadError(q.error)}</p>
          <div className="st-row">
            <button type="button" className="btn btn-secondary" onClick={() => q.refetch()}>Try again</button>
            <button type="button" className="btn btn-ghost" onClick={close}>✕ Close</button>
          </div>
        </div>
      ) : (
        <Editor key={id} id={id} d={q.data} onClose={close} />
      )}
    </div>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────
function Editor({ id, d, onClose }: { id: string; d: ClipDetail; onClose: () => void }) {
  const desktop = useDesktop()
  const qc = useQueryClient()
  const [ed, dispatch] = useReducer(editReducer, d, initEdit)
  const [view, setViewState] = useState<View>('live')
  const [tool, setToolState] = useState<Tool | null>(() => (window.matchMedia('(min-width: 1024px)').matches ? 'trim' : null))
  const [vetoed, setVetoed] = useState(Boolean(d.vetoed))
  const [approved, setApproved] = useState(Boolean(d.override))
  const [forced, setForced] = useState(Boolean(d.override?.force_post))
  const [rid, setRid] = useState<string | null>(d.latest_render?.id ?? null)
  const [traj, setTraj] = useState<Trajectory | null>(null)
  const [run, setRun] = useState<RenderRun>({ kind: 'idle' })
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState<'save' | 'force' | 'veto' | null>(null)
  const [srcPlaying, setSrcPlaying] = useState(false)
  const [reelPlaying, setReelPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [size, setSize] = useState({ W: 0, H: 0 })
  const [focusSub, setFocusSub] = useState(0)

  const srcRef = useRef<HTMLVideoElement>(null)
  const reelRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const spotRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const phRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const tlRef = useRef<HTMLDivElement>(null)
  const note = useRef({ text: '', until: 0 })
  const drag = useRef<{ kind: string } | null>(null)
  const poll = useRef<number | undefined>(undefined)
  const alive = useRef(true)

  const clip = d.clip ?? {}
  const pipe = d.pipeline ?? null
  const twin = pipe?.state === 'twin_of_posted'
  const posted = pipe?.state === 'posted'
  const canForce = approved && !twin
  const title = `${clip.sender || '?'} · ${fmtDuration(clip.duration ?? ed.dur)}`

  // Stage geometry: a 9:16 viewport for Live / Render, 16:9 for Full frame. Room is
  // left for the view buttons docked on either side.
  const { W, H } = size
  const room = Math.max(120, W - 124)
  const vh = Math.max(120, Math.min(H, (room * 16) / 9))
  const vw = (vh * 9) / 16
  const fw = Math.max(120, Math.min(room, (H * 16) / 9))
  const fh = (fw * 9) / 16

  const live = useRef({ ed, view, traj, tool, vw, vh, confirm })
  live.current = { ed, view, traj, tool, vw, vh, confirm }

  // ── Time ────────────────────────────────────────────────────────────────
  const reelT0 = () => live.current.traj?.t0 ?? live.current.ed.ws
  const nowTs = useCallback((): number => {
    const L = live.current
    if (L.view === 'reel') return reelT0() + (reelRef.current?.currentTime || 0)
    return srcRef.current?.currentTime || 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const seek = useCallback((t: number) => {
    const L = live.current
    const ts = clamp(t, 0, L.ed.dur)
    if (L.view === 'reel') { if (reelRef.current) reelRef.current.currentTime = Math.max(0, ts - reelT0()) }
    else if (srcRef.current) srcRef.current.currentTime = ts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const activeVideo = () => (live.current.view === 'reel' ? reelRef.current : srcRef.current)
  const pause = () => activeVideo()?.pause()
  const flash = (text: string, ms = 2600) => { note.current = { text, until: Date.now() + ms } }

  function togglePlay() {
    const v = activeVideo()
    if (!v) return
    if (v.paused) {
      if (live.current.view !== 'reel') {
        const ts = nowTs()
        if (ts < ed.ws || ts >= ed.we - 0.05) seek(ed.ws)
      }
      v.play().catch(() => {})
    } else v.pause()
  }

  function setView(v: View, hasRender = Boolean(rid)) {
    if (v === 'reel' && !hasRender) return
    const ts = nowTs()
    srcRef.current?.pause()
    reelRef.current?.pause()
    live.current.view = v
    setViewState(v)
    seek(ts)
  }

  function setTool(t: Tool | null) {
    const next = t === tool && !desktop ? null : t
    setToolState(next)
    if (next && next !== 'crop' && view === 'reel') setView('live')
  }

  // ── Layout ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ W: el.clientWidth, H: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Paint loop ──────────────────────────────────────────────────────────
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const v = srcRef.current
      if (!v) return
      const L = live.current
      const e = L.ed
      const ts = nowTs()
      if (L.view !== 'reel' && !v.paused && (ts >= e.we || ts < e.ws - 0.3)) v.currentTime = e.ws
      if (L.view === 'live') {
        const [cx, cy, , ch] = cropAt(ts, e.mode, e.box, L.traj)
        const s = L.vh / ch
        const zs = zoomAt(ts, e.zooms)
        const [ox, oy] = zoomOffset(zs, L.vw, L.vh)
        v.style.transform = `translate(${-(cx * s + ox) * zs.z}px,${-(cy * s + oy) * zs.z}px) scale(${s * zs.z})`
        const sub = subAt(ts, e.subs)
        const txt = sub ? sub.text : ''
        if (subRef.current && subRef.current.textContent !== txt) subRef.current.textContent = txt
        const z = L.tool === 'zoom' ? e.zooms[e.selZoom] : undefined
        const spot = spotRef.current
        if (spot) {
          if (z) {
            const px = (z.x * L.vw - ox) * zs.z
            const py = (z.y * L.vh - oy) * zs.z
            spot.hidden = px < 0 || py < 0 || px > L.vw || py > L.vh
            spot.style.left = `${px}px`
            spot.style.top = `${py}px`
          } else spot.hidden = true
        }
        const n = noteRef.current
        if (n) {
          const msg = Date.now() < note.current.until ? note.current.text
            : z ? '🎯 Tap to aim the zoom'
            : e.mode === 'ai' && !hasTraj(L.traj) ? 'AI tracking shows after your first render' : ''
          n.hidden = !msg
          if (n.textContent !== msg) n.textContent = msg
        }
      } else {
        v.style.transform = ''
        if (L.view === 'frame' && boxRef.current) {
          const [cx, cy, cw, ch] = cropAt(ts, e.mode, e.box, L.traj)
          const b = boxRef.current.style
          b.left = `${(cx / NW) * 100}%`
          b.top = `${(cy / NH) * 100}%`
          b.width = `${(cw / NW) * 100}%`
          b.height = `${(ch / NH) * 100}%`
        }
      }
      if (phRef.current) phRef.current.style.left = `${clamp(ts / e.dur, 0, 1) * 100}%`
      const tt = `${f1(ts)}s / ${f1(e.dur)}s`
      if (timeRef.current && timeRef.current.textContent !== tt) timeRef.current.textContent = tt
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [nowTs])

  // ── Lifetime: trajectory, poll, leave guard, video teardown ─────────────
  const loadTrajectory = useCallback((r: string) => {
    request<Trajectory>(`${renderPath(r)}/trajectory`).then((t) => {
      if (alive.current) setTraj(hasTraj(t) ? { t0: Number(t.t0) || 0, traj: t.traj } : null)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    alive.current = true
    if (d.latest_render?.id) loadTrajectory(d.latest_render.id)
    const src = srcRef.current
    const reel = reelRef.current
    return () => {
      alive.current = false
      window.clearInterval(poll.current)
      src?.pause()
      reel?.pause()
    }
  }, [d.latest_render?.id, loadTrajectory])

  useEffect(() => {
    if (!ed.dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [ed.dirty])

  function requestClose() {
    if (live.current.ed.dirty) setConfirm('leave')
    else onClose()
  }

  // ── Keys (Space · ← → · Shift · I · O · A · Esc) ────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = live.current
      if (L.confirm) return
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[role="dialog"] [role="dialog"]')) return
      if (e.key === ' ') { e.preventDefault(); togglePlayRef.current() }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        activeVideo()?.pause()
        seek(nowTs() + (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1))
      } else if (e.key === 'Escape') { e.preventDefault(); requestCloseRef.current() }
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[ioa]$/i.test(e.key)) {
        const k = e.key.toLowerCase()
        if (k === 'i') dispatch({ type: 'trimStart', t: nowTs() })
        else if (k === 'o') dispatch({ type: 'trimEnd', t: nowTs() })
        else dispatch({ type: 'window', ws: 0, we: L.ed.dur })
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const togglePlayRef = useRef(togglePlay)
  togglePlayRef.current = togglePlay
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  // ── Timeline input ──────────────────────────────────────────────────────
  function tlTime(clientX: number): number {
    const r = tlRef.current!.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1) * live.current.ed.dur
  }
  function applyDrag(kind: string, t: number) {
    const e = live.current.ed
    const z = e.zooms[e.selZoom]
    const s = e.subs[e.selSub]
    switch (kind) {
      case 'play': return seek(t)
      case 'ws': { const v = r2(clamp(t, 0, e.we - 0.5)); dispatch({ type: 'trimStart', t: v }); return seek(v) }
      case 'we': { const v = r2(clamp(t, e.ws + 0.5, e.dur)); dispatch({ type: 'trimEnd', t: v }); return seek(v - 0.04) }
      case 'zs': if (z) { const v = r2(clamp(t, 0, z.end - 0.2)); dispatch({ type: 'zoomStart', t: v }); seek(v) } return
      case 'ze': if (z) { const v = r2(clamp(t, z.start + 0.2, e.dur)); dispatch({ type: 'zoomEnd', t: v }); seek(v - 0.04) } return
      case 'ss': if (s) { const v = r2(clamp(t, 0, s.end - 0.2)); dispatch({ type: 'subStart', t: v }); seek(v + 0.02) } return
      case 'se': if (s) { const v = r2(clamp(t, s.start + 0.2, e.dur)); dispatch({ type: 'subEnd', t: v }); seek(v - 0.04) } return
    }
  }
  function onTlDown(e: RPointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    e.preventDefault()
    const h = target.closest<HTMLElement>('[data-drag]')
    const zb = target.closest<HTMLElement>('[data-zi]')
    const sb = target.closest<HTMLElement>('[data-si]')
    let kind = 'play'
    let at = tlTime(e.clientX)
    if (h) kind = h.dataset.drag!
    else if (zb) {
      const i = Number(zb.dataset.zi)
      dispatch({ type: 'zoomSel', i })
      setTool('zoom')
      at = ed.zooms[i]?.start ?? at
    } else if (sb) {
      const i = Number(sb.dataset.si)
      dispatch({ type: 'subSel', i })
      setTool('subs')
      at = (ed.subs[i]?.start ?? at) + 0.02
    }
    if (kind !== 'play' && live.current.view === 'reel') setView('live')
    drag.current = { kind }
    e.currentTarget.setPointerCapture(e.pointerId)
    pause()
    applyDrag(kind, at)
  }
  function onTlMove(e: RPointerEvent<HTMLDivElement>) {
    const k = drag.current?.kind
    if (!k || k === 'box') return
    if (k !== 'play' || e.buttons || e.pointerType !== 'mouse') applyDrag(k, tlTime(e.clientX))
  }
  const onUp = () => { drag.current = null }

  // ── Stage input: aim a zoom, place a manual box, or play / pause ────────
  function onStageClick(e: React.MouseEvent<HTMLDivElement>) {
    if (view === 'frame') { if (ed.mode !== 'manual') togglePlay(); return }
    const z = ed.zooms[ed.selZoom]
    if (view === 'live' && tool === 'zoom' && z && canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect()
      const zs = zoomAt(nowTs(), ed.zooms)
      const [ox, oy] = zoomOffset(zs, vw, vh)
      const round = (n: number) => Math.round(clamp(n, 0, 1) * 1000) / 1000
      dispatch({ type: 'zoomAim', x: round((ox + (e.clientX - r.left) / zs.z) / vw), y: round((oy + (e.clientY - r.top) / zs.z) / vh) })
      flash('🎯 Zoom aimed')
      return
    }
    togglePlay()
  }
  function moveBox(clientX: number, clientY: number) {
    const r = canvasRef.current!.getBoundingClientRect()
    dispatch({ type: 'box', box: placeBox(live.current.ed.box, (clientX - r.left) / r.width, (clientY - r.top) / r.height) })
  }
  function onStageDown(e: RPointerEvent<HTMLDivElement>) {
    if (view !== 'frame' || ed.mode !== 'manual') return
    e.preventDefault()
    drag.current = { kind: 'box' }
    e.currentTarget.setPointerCapture(e.pointerId)
    moveBox(e.clientX, e.clientY)
  }
  function onStageMove(e: RPointerEvent<HTMLDivElement>) {
    if (drag.current?.kind === 'box') moveBox(e.clientX, e.clientY)
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  const refreshReels = () => { void qc.invalidateQueries({ queryKey: ['reels'] }) }

  async function startRender() {
    if (run.kind === 'running') return
    const bad = validate(ed)
    if (bad) { toast(bad, 'warning'); return }
    const t0 = Date.now()
    setRun({ kind: 'running', secs: null })
    let r: string
    try {
      r = (await request<{ render_id: string }>(`${clipPath(id)}/render`, { body: editBody(ed), timeoutMs: 30_000 })).render_id
    } catch (e) {
      if (alive.current) setRun({ kind: 'idle' })
      toast(`Couldn't start the render: ${errText(e)}`, 'error')
      return
    }
    if (!alive.current) return
    let inflight = false
    window.clearInterval(poll.current)
    poll.current = window.setInterval(async () => {
      if (!alive.current || inflight) return
      setRun({ kind: 'running', secs: Math.round((Date.now() - t0) / 1000) })
      inflight = true
      let s: RenderStatus
      try { s = await request<RenderStatus>(renderPath(r)) } catch { return } finally { inflight = false }
      if (!alive.current || !['done', 'failed', 'error'].includes(s.status)) return
      window.clearInterval(poll.current)
      if (s.status === 'done') {
        setRun({ kind: 'idle' })
        setRid(r)
        setTraj(null)
        loadTrajectory(r)
        setView('reel', true)
        refreshReels()
        toast('✓ Rendered — this is the exact reel. Save & approve when it looks right.', 'success')
      } else setRun({ kind: 'failed', text: s.error || 'unknown error' })
    }, POLL_MS)
  }

  function askSave() {
    if (twin) { toast('A clip from the same post is already included.', 'warning'); return }
    const bad = validate(ed)
    if (bad) { toast(bad, 'warning'); return }
    setConfirm('save')
  }
  async function save() {
    if (busy) return
    const body = editBody(ed)
    setBusy('save')
    try {
      await request(`${clipPath(id)}/override`, { body })
      // Only clear the dirty flag if nothing changed while the save was in flight.
      if (JSON.stringify(editBody(live.current.ed)) === JSON.stringify(body)) dispatch({ type: 'saved' })
      setApproved(true)
      setForced(false)
      refreshReels()
      toast(posted ? '✓ Saved. It won’t repost — Force post does that.' : '✓ Saved & approved — Muse posts it on its next run.', 'success')
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? 'A clip from the same post is already included.' : `Couldn't save: ${errText(e)}`, 'error')
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  function askForce() {
    if (forced) { void setForce(false); return }
    if (ed.dirty) { toast('Save your edits first — Force post uses the saved version.', 'warning'); return }
    setConfirm('force')
  }
  async function setForce(on: boolean) {
    if (busy) return
    setBusy('force')
    try {
      await request(`${clipPath(id)}/force-post`, { body: { force: on } })
      setForced(on)
      refreshReels()
      toast(on ? '🚀 Force post on — Muse posts it on its next run.' : 'Force post cancelled.', 'success')
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? 'A clip from the same post is already included.' : `Couldn't update force post: ${errText(e)}`, 'error')
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  function askVeto() {
    if (vetoed) void setVeto(false)
    else setConfirm('veto')
  }
  async function setVeto(on: boolean) {
    if (busy) return
    setBusy('veto')
    try {
      await request(`${clipPath(id)}/veto`, on ? { body: { reason: '' } } : { method: 'DELETE' })
      setVetoed(on)
      refreshReels()
      toast(on ? '🛑 Vetoed — this clip stays out of highlights.' : 'Veto lifted.', 'success')
    } catch (e) {
      toast(`Couldn't update the veto: ${errText(e)}`, 'error')
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  const ts = whenTs(clip.when_ts ?? clip.when)
  const sub = [ts ? fmtAgo(ts) : '', clip.game || 'unknown game', clip.message || ''].filter(Boolean).join(' · ')
  const pipeMsg = pipeMessage(pipe)
  const ig = igLink(pipe)
  const rendering = run.kind === 'running'
  const saveLabel = posted ? '💾 Save edit (won’t repost)' : '✅ Save & approve'
  const reelSrc = rid ? `${renderPath(rid)}/video` : undefined
  const playing = view === 'reel' ? reelPlaying : srcPlaying
  const aiming = view === 'live' && tool === 'zoom' && ed.selZoom >= 0

  const tools = {
    ed, dispatch, now: nowTs, seek, setView, view, traj, analysis: d.analysis, flash,
    focusSub, requestSubFocus: () => setFocusSub((n) => n + 1),
  }

  const actions = (
    <>
      <button type="button" className="btn btn-secondary" onClick={startRender} aria-disabled={rendering || undefined} aria-busy={rendering || undefined}>
        {rendering ? 'Rendering…' : '⚙ Render'}
      </button>
      <button type="button" className="btn btn-primary" onClick={askSave} aria-disabled={twin || busy === 'save' || undefined} aria-busy={busy === 'save' || undefined}>
        {busy === 'save' ? 'Saving…' : saveLabel}
      </button>
      {canForce && (
        <button type="button" className="btn btn-secondary st-force" data-on={forced || undefined} onClick={askForce} aria-busy={busy === 'force' || undefined}
          title={forced ? 'Force post is on — tap to cancel' : 'Force post — post again past the once-per-clip rule'}>
          {forced ? '🚀 Forced · undo' : '🚀 Force post'}
        </button>
      )}
    </>
  )

  return (
    <>
      <header className="st-top">
        <button type="button" className="st-ic" onClick={requestClose} aria-label="Close the Studio">✕</button>
        <div className="st-title">
          <b>{title}</b>
          <span>{sub}</span>
        </div>
        <button type="button" className="st-ic st-veto" data-on={vetoed || undefined} onClick={askVeto} aria-busy={busy === 'veto' || undefined}
          aria-label={vetoed ? 'Vetoed — tap to lift the veto' : 'Veto — keep out of highlights'}>
          {vetoed ? '🛑 Vetoed' : '🛑'}
        </button>
        {!desktop && (
          <>
            <button type="button" className="st-ic" onClick={startRender} aria-disabled={rendering || undefined} aria-label="Render">⚙<span className="st-ic-l">Render</span></button>
            {canForce && (
              <button type="button" className="st-ic st-force" data-on={forced || undefined} onClick={askForce}
                aria-label={forced ? 'Force post is on — tap to cancel' : 'Force post'}>🚀</button>
            )}
            <button type="button" className="st-ic st-go" onClick={askSave} aria-disabled={twin || busy === 'save' || undefined}
              aria-label={posted ? 'Save edit (won’t repost)' : 'Save and approve'}>✅<span className="st-ic-l">Save</span></button>
          </>
        )}
      </header>
      {pipeMsg && (
        <p className="st-pipe" data-state={pipe?.state}>
          {pipeMsg}{ig && <> <a href={ig} target="_blank" rel="noreferrer">View on Instagram ↗</a></>}
        </p>
      )}
      <div className="st-body">
        <div className="st-main">
          <div className="st-stagewrap" ref={wrapRef}>
            <div className="st-views" role="group" aria-label="Preview">
              <button type="button" className="st-view" aria-pressed={view === 'live'} onClick={() => setView('live')}>✨<span>Live</span></button>
              <button type="button" className="st-view" aria-pressed={view === 'reel'} disabled={!rid} onClick={() => setView('reel')}
                title={rid ? 'The rendered reel' : 'Render first to see the exact reel'}>🎬<span>Render</span></button>
              <button type="button" className="st-view" aria-pressed={view === 'frame'} onClick={() => setView('frame')}>🖼<span>Frame</span></button>
            </div>
            <div className="st-side-tools">
              <button type="button" className="st-view" aria-pressed={muted} onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? '🔇' : '🔊'}</button>
              {reelSrc && <a className="st-view" href={reelSrc} download aria-label="Download the reel" title="Download the reel">⬇</a>}
            </div>

            <div
              ref={canvasRef}
              className="st-canvas"
              data-view={view}
              data-aim={aiming || undefined}
              data-manual={(view === 'frame' && ed.mode === 'manual') || undefined}
              hidden={view === 'reel'}
              style={view === 'frame' ? { width: fw, height: fh } : { width: vw, height: vh }}
              onClick={onStageClick}
              onPointerDown={onStageDown}
              onPointerMove={onStageMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <video
                ref={srcRef}
                className="st-src"
                src={`${clipPath(id)}/source`}
                playsInline
                preload="auto"
                muted={muted}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  if (Number.isFinite(v.duration) && v.duration > 0) dispatch({ type: 'duration', dur: v.duration })
                  v.currentTime = live.current.ed.ws
                }}
                onPlay={() => setSrcPlaying(true)}
                onPause={() => setSrcPlaying(false)}
              />
              {view === 'live' && (
                <>
                  <div className="st-label" style={{ fontSize: (vw * 54) / 1080, left: (vw * 40) / 1080, top: (vw * 30) / 1080 }}>{ed.label.slice(0, LABEL_MAX)}</div>
                  <div className="st-sub" ref={subRef} style={{ fontSize: vh * 0.058, bottom: vh * 0.31 }} />
                  <div className="st-spot" ref={spotRef} hidden />
                  <div className="st-note" ref={noteRef} hidden />
                </>
              )}
              {view === 'frame' && <div className="st-cbox" ref={boxRef} data-manual={ed.mode === 'manual' || undefined} />}
            </div>
            <video
              ref={reelRef}
              className="st-reel"
              src={reelSrc}
              playsInline
              preload="auto"
              muted={muted}
              hidden={view !== 'reel'}
              style={{ width: vw, height: vh }}
              onClick={togglePlay}
              onPlay={() => setReelPlaying(true)}
              onPause={() => setReelPlaying(false)}
            />
            {run.kind === 'running' && (
              <div className="st-busy" role="status"><div className="st-spin" aria-hidden="true" />
                <span>{run.secs === null ? 'Queued…' : `Rendering your reel… ${run.secs}s`}</span>
              </div>
            )}
            {run.kind === 'failed' && (
              <div className="st-busy" role="alert">
                <p style={{ margin: 0 }}>Render failed: {run.text}</p>
                <div className="st-row">
                  <button type="button" className="btn btn-primary" onClick={startRender}>Render again</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setRun({ kind: 'idle' })}>Dismiss</button>
                </div>
              </div>
            )}
          </div>

          <div className="st-transport">
            <button type="button" className="st-ic" onClick={() => { pause(); seek(nowTs() - 1) }} aria-label="Back 1 second">−1s</button>
            <button type="button" className="st-ic" onClick={() => { pause(); seek(nowTs() - 0.1) }} aria-label="Back 0.1 seconds">−0.1</button>
            <button type="button" className="st-play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
            <button type="button" className="st-ic" onClick={() => { pause(); seek(nowTs() + 0.1) }} aria-label="Forward 0.1 seconds">+0.1</button>
            <button type="button" className="st-ic" onClick={() => { pause(); seek(nowTs() + 1) }} aria-label="Forward 1 second">+1s</button>
            <span className="st-time num" ref={timeRef} aria-hidden="true" />
          </div>

          <Timeline
            id={id} ed={ed} traj={traj} desktop={desktop} width={W}
            tlRef={tlRef} phRef={phRef}
            onDown={onTlDown} onMove={onTlMove} onUp={onUp}
          />
        </div>

        <aside className={desktop ? 'st-side glass' : 'st-side'}>
          <nav className="st-tabs" aria-label="Tools">
            {TOOLS.map(([k, icon, label]) => (
              <button key={k} type="button" className="st-tab" aria-pressed={tool === k} onClick={() => setTool(k)}>
                <i aria-hidden="true">{icon}</i>{label}
              </button>
            ))}
          </nav>
          {tool && (
            <section className="st-panel" aria-label={TOOL_TITLE[tool]}>
              {desktop && <p className="st-ptitle">{TOOL_TITLE[tool]}</p>}
              {tool === 'trim' && <TrimPanel {...tools} desktop={desktop} />}
              {tool === 'crop' && <CropPanel {...tools} />}
              {tool === 'zoom' && <ZoomPanel {...tools} />}
              {tool === 'text' && <TextPanel {...tools} />}
              {tool === 'subs' && <SubsPanel {...tools} />}
            </section>
          )}
          {desktop && <div className="st-actions">{actions}</div>}
        </aside>
      </div>

      <ConfirmDialog
        open={confirm === 'save'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title={posted ? 'Save this edit?' : 'Save & approve?'}
        body={<p style={{ margin: 0 }}>{posted
          ? 'This clip is already posted, so saving won’t repost it — use Force post for that.'
          : 'Save these edits and approve this clip for Instagram? Muse will post it with exactly these settings.'}</p>}
        action={posted ? 'Save' : 'Save & approve'}
        onConfirm={() => void save()}
      />
      <ConfirmDialog
        open={confirm === 'force'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Force post?"
        body={<p style={{ margin: 0 }}>Post '{title}' on Muse’s next run? This skips the normal pipeline — it posts the saved edit even if this clip was already posted. A veto still stops it.</p>}
        action="Force post"
        onConfirm={() => void setForce(true)}
      />
      <ConfirmDialog
        open={confirm === 'veto'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Veto this reel?"
        body={<p style={{ margin: 0 }}>Veto '{title}'? It won’t be used in the fire, fail or daily highlight reels.</p>}
        action="Veto"
        onConfirm={() => void setVeto(true)}
      />
      <ConfirmDialog
        open={confirm === 'leave'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Leave the Studio?"
        body={<p style={{ margin: 0 }}>Leave without saving your edits?</p>}
        action="Leave"
        onConfirm={onClose}
      />
    </>
  )
}

// ── Timeline ─────────────────────────────────────────────────────────────────
function Timeline({ id, ed, traj, desktop, width, tlRef, phRef, onDown, onMove, onUp }: {
  id: string; ed: Edit; traj: Trajectory | null; desktop: boolean; width: number
  tlRef: React.RefObject<HTMLDivElement | null>; phRef: React.RefObject<HTMLDivElement | null>
  onDown: (e: RPointerEvent<HTMLDivElement>) => void; onMove: (e: RPointerEvent<HTMLDivElement>) => void; onUp: () => void
}) {
  const dur = ed.dur
  const pct = (t: number) => `${(clamp(t, 0, dur) / dur) * 100}%`
  const cvRef = useRef<HTMLCanvasElement>(null)
  const n = desktop ? 14 : 7
  const frames = useMemo(() => Array.from({ length: n }, (_, i) => `${clipPath(id)}/frame?t=${f1(((i + 0.5) * dur) / n)}`), [id, dur, n])
  const marks = useMemo(() => rulerMarks(dur), [dur])

  // The AI crop path, drawn across the trim lane once a render has a trajectory.
  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return
    const rc = cv.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.max(1, rc.width * dpr)
    cv.height = Math.max(1, rc.height * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    if (!hasTraj(traj)) return
    ctx.strokeStyle = 'rgba(157,92,255,.9)'
    ctx.lineWidth = 1.5 * dpr
    ctx.beginPath()
    traj.traj.forEach(([t, x], i) => {
      const px = ((traj.t0 + t) / dur) * cv.width
      const py = cv.height - 5 * dpr - (x / (NW - 608)) * (cv.height - 10 * dpr)
      if (i) ctx.lineTo(px, py)
      else ctx.moveTo(px, py)
    })
    ctx.stroke()
  }, [traj, dur, width])

  const block = (k: 'z' | 's', i: number, a: number, b: number, text: string, sel: boolean) => (
    <div key={i} className="st-blk" data-kind={k} data-sel={sel || undefined} {...{ [`data-${k}i`]: i }}
      style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }}>
      <span>{text}</span>
      {sel && <>
        <div className="st-hdl" data-drag={`${k}s`} style={{ left: 0 }} />
        <div className="st-hdl" data-drag={`${k}e`} style={{ left: '100%' }} />
      </>}
    </div>
  )

  return (
    <div className="st-tl" ref={tlRef} aria-label="Timeline" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className="st-winwrap">
        <div className="st-strip" aria-hidden="true">{frames.map((src) => <img key={src} src={src} alt="" loading="lazy" />)}</div>
        <div className="st-lane st-lane-win">
          <canvas className="st-path" ref={cvRef} aria-hidden="true" />
          <div className="st-shade" style={{ left: 0, width: pct(ed.ws) }} />
          <div className="st-shade" style={{ left: pct(ed.we), right: 0 }} />
          <div className="st-win" style={{ left: pct(ed.ws), width: `calc(${pct(ed.we)} - ${pct(ed.ws)})` }} />
          <div className="st-hdl" data-drag="ws" style={{ left: pct(ed.ws) }} />
          <div className="st-hdl" data-drag="we" style={{ left: pct(ed.we) }} />
        </div>
      </div>
      <div className="st-lane">
        <span className="st-lanelbl">🔍 zoom</span>
        {ed.zooms.map((z, i) => block('z', i, z.start, z.end, fmtScale(z.scale), i === ed.selZoom))}
      </div>
      <div className="st-lane">
        <span className="st-lanelbl">💬 subs</span>
        {ed.subs.map((s, i) => block('s', i, s.start, s.end, s.text, i === ed.selSub))}
      </div>
      <div className="st-ruler num" aria-hidden="true">
        {marks.map((t, i) => <span key={i} style={{ left: pct(t) }}>{t === dur ? f1(t) : t}s</span>)}
      </div>
      <div className="st-ph" ref={phRef} />
    </div>
  )
}

// ── Tool panels ──────────────────────────────────────────────────────────────
type ToolProps = {
  ed: Edit
  dispatch: (a: EditAction) => void
  now: () => number
  seek: (t: number) => void
  setView: (v: View) => void
  view: View
  traj: Trajectory | null
  analysis: ClipDetail['analysis']
  flash: (text: string, ms?: number) => void
  focusSub: number
  requestSubFocus: () => void
}

function TrimPanel({ ed, dispatch, now, seek, analysis: a, desktop }: ToolProps & { desktop: boolean }) {
  return (
    <>
      <p className="st-kv">Reel <b className="num">{f1(ed.ws)}s → {f1(ed.we)}s</b> · <b className="num">{f1(ed.we - ed.ws)}s</b> long</p>
      <div className="st-row">
        <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'trimStart', t: now() })}>⇤ Start here</button>
        <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'trimEnd', t: now() })}>End here ⇥</button>
      </div>
      <div className="st-row">
        <button type="button" className="btn btn-ghost" onClick={() => { dispatch({ type: 'window', ws: 0, we: ed.dur }); seek(0) }}>↔ Whole clip</button>
        <button type="button" className="btn btn-ghost" aria-disabled={!a || undefined}
          onClick={() => { if (!a) return; dispatch({ type: 'window', ws: Number(a.primary_start), we: Number(a.primary_end) }); seek(Number(a.primary_start)) }}>
          ✨ Use AI pick{a ? ` (${f1(a.primary_start)}–${f1(a.primary_end)}s)` : ''}
        </button>
      </div>
      <p className="st-muted">Drag the cyan handles on the timeline, or play to a moment and tap Start / End here.</p>
      {a ? (
        <p className="st-muted">
          <b>AI:</b> featured {String(a.featured_label || a.featured_player || '?')} (confidence {String(a.identity_confidence ?? '?')}) · {(a.subtitle_segments ?? []).length} subtitle lines
        </p>
      ) : (
        <p className="st-muted">No AI analysis for this clip yet — renders use your trim, the sender as label, and no subtitles unless you add some.</p>
      )}
      {desktop && (
        <details className="st-keys">
          <summary>Keys</summary>
          <p><kbd>Space</kbd> play · <kbd>←</kbd> <kbd>→</kbd> step 0.1s (<kbd>Shift</kbd> 1s)<br />
            <kbd>I</kbd> start here · <kbd>O</kbd> end here · <kbd>A</kbd> whole clip · <kbd>Esc</kbd> close</p>
        </details>
      )}
    </>
  )
}

function CropPanel({ ed, dispatch, setView, view, traj }: ToolProps) {
  const [bx, , bw, bh] = boxPx(ed.box)
  const size = Math.round((bh / NH) * 100)
  const slack = NW - bw
  const across = slack > 0 ? Math.round((bx / slack) * 100) : 50
  const moveX = (share: number) => {
    const w = bw / NW
    dispatch({ type: 'box', box: { ...ed.box, w, h: bh / NH, x: clamp(share, 0, 1) * (1 - w) } })
  }
  const nudge = (dx: number) => {
    const w = bw / NW
    dispatch({ type: 'box', box: { ...ed.box, w, h: bh / NH, x: clamp(bx / NW + dx, 0, 1 - w) } })
  }
  const modes: [Edit['mode'], string][] = [['ai', 'AI tracking'], ['center', 'Center'], ['manual', 'Manual']]
  return (
    <>
      <div className="st-seg" role="radiogroup" aria-label="Crop">
        {modes.map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={ed.mode === m}
            onClick={() => { dispatch({ type: 'mode', mode: m }); if (m === 'manual') setView('frame') }}>{label}</button>
        ))}
      </div>
      {ed.mode === 'ai' && (
        <p className="st-muted">{hasTraj(traj)
          ? 'Following the action from your last render. Open Full frame to watch the crop window move.'
          : 'AI tracking is worked out when you render. Until then the Live preview shows it centered.'}</p>
      )}
      {ed.mode === 'center' && <p className="st-muted">A fixed crop from the middle of the frame.</p>}
      {ed.mode === 'manual' && (
        <>
          <label className="st-field">
            <span>Crop size <b className="num">{size}%</b></span>
            <input className="st-range" type="range" min={30} max={100} step={1} value={size}
              onChange={(e) => dispatch({ type: 'box', box: resizeBox(ed.box, Number(e.target.value) / 100) })} />
          </label>
          <div className="st-field">
            <label htmlFor="st-crop-x">Position <b className="num">{across}%</b> across</label>
            <div className="st-nudge">
              <button type="button" className="st-ic" onClick={() => nudge(-0.02)} aria-label="Move the crop left">◀</button>
              <input id="st-crop-x" className="st-range" type="range" min={0} max={100} step={1} value={across} disabled={slack <= 0}
                onChange={(e) => moveX(Number(e.target.value) / 100)} />
              <button type="button" className="st-ic" onClick={() => nudge(0.02)} aria-label="Move the crop right">▶</button>
            </div>
          </div>
          <p className="st-muted">In Full frame, drag to place the green box. Smaller boxes crop in tighter.</p>
        </>
      )}
      <div className="st-row">
        <button type="button" className="btn btn-ghost" aria-pressed={view === 'frame'} onClick={() => setView('frame')}>🖼 Full frame</button>
        <button type="button" className="btn btn-ghost" aria-pressed={view === 'live'} onClick={() => setView('live')}>✨ Live preview</button>
      </div>
    </>
  )
}

const zoomChip = (z: { start: number; end: number; scale: number }) => `🔍 ${f1(z.start)}–${f1(z.end)}s · ${fmtScale(z.scale)}`

function ZoomPanel({ ed, dispatch, now, seek, setView, view, flash }: ToolProps) {
  const z = ed.zooms[ed.selZoom]
  const toLive = () => { if (view !== 'live') setView('live') }
  return (
    <>
      <div className="st-chips">
        {ed.zooms.map((x, i) => (
          <button key={i} type="button" className="chip" aria-pressed={i === ed.selZoom}
            onClick={() => { dispatch({ type: 'zoomSel', i }); toLive(); seek(x.start) }}>{zoomChip(x)}</button>
        ))}
        <button type="button" className="chip st-chip-add"
          onClick={() => { toLive(); dispatch({ type: 'zoomAdd', t: now() }); flash('🎯 Now tap the preview where you want to zoom', 4000) }}>
          ＋ Add zoom here
        </button>
      </div>
      {z ? (
        <>
          <label className="st-field">
            <span>Strength <b className="num">{fmtScale(z.scale)}</b></span>
            <input className="st-range" type="range" min={1.1} max={3} step={0.05} value={z.scale}
              onChange={(e) => dispatch({ type: 'zoomScale', scale: Number(e.target.value) })} />
          </label>
          <div className="st-row">
            <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'zoomStart', t: now() })}>⇤ Start here</button>
            <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'zoomEnd', t: now() })}>End here ⇥</button>
          </div>
          <p className="st-muted">🎯 Tap the preview to aim · now {Math.round(z.x * 100)}% across, {Math.round(z.y * 100)}% down.
            Drag the pink block’s edges on the timeline to adjust timing.</p>
          <div className="st-row">
            <button type="button" className="btn btn-ghost" onClick={() => {
              toLive()
              seek(Math.max(ed.ws, z.start - 0.7))
              document.querySelector<HTMLVideoElement>('.st-src')?.play().catch(() => {})
            }}>▶ Preview zoom</button>
            <button type="button" className="btn btn-danger" onClick={() => dispatch({ type: 'zoomDel' })}>Delete</button>
          </div>
        </>
      ) : (
        <p className="st-muted">Play or scrub to the moment, tap <b>＋ Add zoom here</b>, then tap the preview where you want to punch in.</p>
      )}
    </>
  )
}

function TextPanel({ ed, dispatch }: ToolProps) {
  return (
    <>
      <label className="st-field">
        <span>Featured player <em>shown top-left on the reel</em></span>
        <input className="input" type="text" maxLength={LABEL_MAX} value={ed.label} onChange={(e) => dispatch({ type: 'label', text: e.target.value })} />
        <span className="meta st-count num">{ed.label.length}/{LABEL_MAX}</span>
      </label>
      <label className="st-field">
        <span>Caption <em>posted with the reel on Instagram</em></span>
        <textarea className="input st-caption" rows={4} maxLength={CAPTION_MAX} value={ed.caption} onChange={(e) => dispatch({ type: 'caption', text: e.target.value })} />
        <span className="meta st-count num">{ed.caption.length}/{CAPTION_MAX}</span>
      </label>
    </>
  )
}

function SubsPanel({ ed, dispatch, now, seek, setView, view, analysis, focusSub, requestSubFocus }: ToolProps) {
  const s = ed.subs[ed.selSub]
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (focusSub) inputRef.current?.focus() }, [focusSub])
  return (
    <>
      <p className="st-kv">{ed.subsEdited ? 'Your subtitles' : ed.subs.length ? 'AI subtitles' : 'No subtitles'}</p>
      {s && (
        <>
          <label className="st-field">
            <span>Line text</span>
            <input ref={inputRef} className="input" type="text" maxLength={SUB_MAX} value={s.text} onChange={(e) => dispatch({ type: 'subText', text: e.target.value })} />
          </label>
          <div className="st-row">
            <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'subStart', t: now() })}>⇤ Start here</button>
            <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'subEnd', t: now() })}>End here ⇥</button>
            <button type="button" className="btn btn-danger" onClick={() => dispatch({ type: 'subDel' })}>Delete</button>
          </div>
        </>
      )}
      <div className="st-row">
        <button type="button" className="btn btn-ghost" onClick={() => { if (view === 'reel') setView('live'); dispatch({ type: 'subAdd', t: now() }); requestSubFocus() }}>＋ Add line here</button>
        <button type="button" className="btn btn-ghost" aria-disabled={!ed.subsEdited || undefined}
          onClick={() => { if (ed.subsEdited) dispatch({ type: 'subReset', subs: aiSubs(analysis) }) }}>↺ Reset to AI</button>
      </div>
      {ed.subs.length ? (
        <ul className="st-sublist">
          {ed.subs.map((x, i) => (
            <li key={i}>
              <button type="button" className="st-subitem" aria-pressed={i === ed.selSub}
                onClick={() => { dispatch({ type: 'subSel', i }); if (view === 'reel') setView('live'); seek(x.start + 0.02) }}>
                <span className="num">{f1(x.start)}s</span>{x.text || <i>empty</i>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="st-muted">No lines yet. Play to a moment and tap Add line here.</p>
      )}
    </>
  )
}
