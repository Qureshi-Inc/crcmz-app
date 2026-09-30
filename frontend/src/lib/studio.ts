// CL-12–20 · The Studio's model: what the editor holds, the body it saves, and the
// geometry the Live view uses to rebuild the reel from the source video.
//
// The crop / zoom maths mirror reel-review's render.py, smart_crop.py and
// vendor/reel_zoom.py (the same as the classic Studio), so the Live preview and
// the rendered file line up.
import type { PipelineState } from './clips'

export const NW = 1920
export const NH = 1080
export const CW = 608
export const CENTER_X = (NW - CW) / 2
export const BOX_ASPECT = (16 / 9) * (NW / NH)
export const LABEL_MAX = 40
export const CAPTION_MAX = 2200
export const SUB_MAX = 200

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
export const f1 = (v: number | null | undefined) => (Number(v) || 0).toFixed(1)
export const r2 = (v: number) => Math.round(v * 100) / 100
export const fmtScale = (s: number) => `${Number(s).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}×`

// ── The API (GET /api/reels/clips/{id}) ──────────────────────────────────────
export type Box = { x: number; y: number; w: number; h: number }
export type Zoom = { start: number; end: number; scale: number; x: number; y: number }
export type Sub = { start: number; end: number; text: string }
export type CropMode = 'ai' | 'center' | 'manual'

export type Analysis = {
  primary_start: number
  primary_end: number
  featured_label?: string | null
  featured_player?: string | null
  identity_confidence?: string | number | null
  caption_draft?: string | null
  subtitle_segments?: { start: number; end: number; subtitle_text?: string; lines?: string[] }[]
}
export type Override = {
  window_start?: number | null
  window_end?: number | null
  crop_mode?: CropMode
  crop_box?: Box | null
  label?: string
  caption?: string | null
  zooms?: Zoom[]
  subtitles?: { start: number; end: number; text?: string; subtitle_text?: string }[] | null
  force_post?: boolean
}
export type StudioPipeline = PipelineState & { ig_url?: string }
export type ClipDetail = {
  clip: { clip_id?: string; sender?: string | null; game?: string | null; duration?: number | null; when_ts?: string | null; when?: string | null; message?: string | null }
  analysis: Analysis | null
  override: Override | null
  vetoed?: boolean
  pipeline?: StudioPipeline | null
  latest_render?: { id: string } | null
}
export type Trajectory = { t0: number; traj: [number, number][] }
export type RenderStatus = { status: string; error?: string | null }

export const clipPath = (id: string) => `/api/reels/clips/${encodeURIComponent(id)}`
export const renderPath = (rid: string) => `/api/reels/renders/${encodeURIComponent(rid)}`
export const studioHref = (id: string) => `/clips/${encodeURIComponent(id)}/edit`

// ── Editor state ─────────────────────────────────────────────────────────────
export type Edit = {
  dur: number
  ws: number
  we: number
  mode: CropMode
  box: Box
  label: string
  caption: string
  zooms: Zoom[]
  subs: Sub[]
  /** false = the AI's subtitles, sent as null so a re-analysis still applies. */
  subsEdited: boolean
  selZoom: number
  selSub: number
  dirty: boolean
}

export const aiSubs = (a: Analysis | null): Sub[] =>
  (a?.subtitle_segments ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: s.subtitle_text || (s.lines ?? []).join(' ') || '' }))

export const CENTER_BOX: Box = { x: CENTER_X / NW, y: 0, w: CW / NW, h: 1 }

export function initEdit(d: ClipDetail): Edit {
  const clip = d.clip ?? {}
  const a = d.analysis
  const ov = d.override ?? {}
  const clipDur = Number(clip.duration) || 0
  // A saved edit keeps its trim; otherwise the whole clip. The AI's pick stays one tap away.
  let ws = ov.window_start
  let we = ov.window_end
  if (ws == null && clipDur > 0) { ws = 0; we = clipDur }
  if (ws == null && a) { ws = a.primary_start; we = a.primary_end }
  if (ws == null) { ws = 0; we = 15 }
  const subsEdited = Array.isArray(ov.subtitles)
  return {
    dur: clipDur || Math.max(Number(we), 1),
    ws: Number(ws),
    we: Number(we),
    mode: ov.crop_mode || 'ai',
    box: ov.crop_box || CENTER_BOX,
    label: ov.label || a?.featured_label || clip.sender || '',
    caption: ov.caption ?? a?.caption_draft ?? '',
    zooms: Array.isArray(ov.zooms) ? ov.zooms.map((z) => ({ ...z })) : [],
    subsEdited,
    subs: subsEdited
      ? (ov.subtitles ?? []).map((s) => ({ start: Number(s.start), end: Number(s.end), text: s.text || s.subtitle_text || '' }))
      : aiSubs(a),
    selZoom: -1,
    selSub: -1,
    dirty: false,
  }
}

export type EditBody = {
  window_start: number; window_end: number; crop_mode: CropMode; crop_box: Box | null
  label: string; caption: string; zooms: Zoom[]; subtitles: Sub[] | null
}

export function editBody(e: Edit): EditBody {
  return {
    window_start: r2(e.ws), window_end: r2(e.we), crop_mode: e.mode,
    crop_box: e.mode === 'manual' ? e.box : null,
    label: e.label.trim(), caption: e.caption.trim(),
    zooms: e.zooms.map((z) => ({ start: r2(z.start), end: r2(z.end), scale: Number(z.scale), x: Number(z.x), y: Number(z.y) })),
    subtitles: e.subsEdited
      ? e.subs.filter((s) => s.text.trim()).map((s) => ({ start: r2(s.start), end: r2(s.end), text: s.text.trim() }))
      : null,
  }
}

export function validate(e: Edit): string | null {
  if (!(e.we > e.ws)) return 'Trim: the end has to be after the start.'
  if (e.zooms.some((z) => !(z.end > z.start))) return 'Each zoom needs an end after its start.'
  if (e.subs.some((s) => !(s.end > s.start))) return 'Each subtitle needs an end after its start.'
  return null
}

// ── Reducer ──────────────────────────────────────────────────────────────────
export type EditAction =
  | { type: 'reset'; edit: Edit }
  | { type: 'duration'; dur: number }
  | { type: 'trimStart'; t: number }
  | { type: 'trimEnd'; t: number }
  | { type: 'window'; ws: number; we: number }
  | { type: 'mode'; mode: CropMode }
  | { type: 'box'; box: Box }
  | { type: 'label'; text: string }
  | { type: 'caption'; text: string }
  | { type: 'zoomAdd'; t: number }
  | { type: 'zoomSel'; i: number }
  | { type: 'zoomStart'; t: number }
  | { type: 'zoomEnd'; t: number }
  | { type: 'zoomScale'; scale: number }
  | { type: 'zoomAim'; x: number; y: number }
  | { type: 'zoomDel' }
  | { type: 'subAdd'; t: number }
  | { type: 'subSel'; i: number }
  | { type: 'subStart'; t: number }
  | { type: 'subEnd'; t: number }
  | { type: 'subText'; text: string }
  | { type: 'subDel' }
  | { type: 'subReset'; subs: Sub[] }
  | { type: 'saved' }

const MIN_WIN = 0.5
const MIN_SEG = 0.2

function patchAt<T>(list: T[], i: number, fn: (x: T) => T): T[] {
  return list.map((x, j) => (j === i ? fn(x) : x))
}

export function editReducer(e: Edit, a: EditAction): Edit {
  const z = e.zooms[e.selZoom]
  const s = e.subs[e.selSub]
  const edited = (next: Partial<Edit>): Edit => ({ ...e, ...next, dirty: true })
  const subsEdited = (subs: Sub[], extra: Partial<Edit> = {}): Edit => edited({ subs, subsEdited: true, ...extra })
  switch (a.type) {
    case 'reset': return a.edit
    case 'duration': return { ...e, dur: a.dur, we: e.we > a.dur ? r2(a.dur) : e.we }
    case 'trimStart': return edited({ ws: r2(clamp(a.t, 0, e.we - MIN_WIN)) })
    case 'trimEnd': return edited({ we: r2(clamp(a.t, e.ws + MIN_WIN, e.dur)) })
    case 'window': return edited({ ws: r2(a.ws), we: r2(a.we) })
    case 'mode': return edited({ mode: a.mode })
    case 'box': return edited({ box: a.box })
    case 'label': return edited({ label: a.text.slice(0, LABEL_MAX) })
    case 'caption': return edited({ caption: a.text.slice(0, CAPTION_MAX) })
    case 'zoomAdd': {
      const st = r2(clamp(a.t, 0, Math.max(0, e.dur - 0.5)))
      const nz: Zoom = { start: st, end: r2(Math.min(e.dur, st + 1.5)), scale: 1.75, x: 0.5, y: 0.5 }
      const zooms = [...e.zooms, nz].sort((p, q) => p.start - q.start)
      return edited({ zooms, selZoom: zooms.indexOf(nz), selSub: -1 })
    }
    case 'zoomSel': return { ...e, selZoom: a.i, selSub: -1 }
    case 'zoomStart': return z ? edited({ zooms: patchAt(e.zooms, e.selZoom, (x) => ({ ...x, start: r2(clamp(a.t, 0, x.end - MIN_SEG)) })) }) : e
    case 'zoomEnd': return z ? edited({ zooms: patchAt(e.zooms, e.selZoom, (x) => ({ ...x, end: r2(clamp(a.t, x.start + MIN_SEG, e.dur)) })) }) : e
    case 'zoomScale': return z ? edited({ zooms: patchAt(e.zooms, e.selZoom, (x) => ({ ...x, scale: clamp(a.scale, 1.1, 3) })) }) : e
    case 'zoomAim': return z ? edited({ zooms: patchAt(e.zooms, e.selZoom, (x) => ({ ...x, x: a.x, y: a.y })) }) : e
    case 'zoomDel': return z ? edited({ zooms: e.zooms.filter((_, j) => j !== e.selZoom), selZoom: -1 }) : e
    case 'subAdd': {
      const st = r2(clamp(a.t, 0, Math.max(0, e.dur - 0.3)))
      const ns: Sub = { start: st, end: r2(Math.min(e.dur, st + 2)), text: '' }
      const subs = [...e.subs, ns].sort((p, q) => p.start - q.start)
      return subsEdited(subs, { selSub: subs.indexOf(ns), selZoom: -1 })
    }
    case 'subSel': return { ...e, selSub: a.i, selZoom: -1 }
    case 'subStart': return s ? subsEdited(patchAt(e.subs, e.selSub, (x) => ({ ...x, start: r2(clamp(a.t, 0, x.end - MIN_SEG)) }))) : e
    case 'subEnd': return s ? subsEdited(patchAt(e.subs, e.selSub, (x) => ({ ...x, end: r2(clamp(a.t, x.start + MIN_SEG, e.dur)) }))) : e
    case 'subText': return s ? subsEdited(patchAt(e.subs, e.selSub, (x) => ({ ...x, text: a.text.slice(0, SUB_MAX) }))) : e
    case 'subDel': return s ? subsEdited(e.subs.filter((_, j) => j !== e.selSub), { selSub: -1 }) : e
    case 'subReset': return edited({ subs: a.subs, subsEdited: false, selSub: -1 })
    case 'saved': return { ...e, dirty: false }
  }
}

// ── Geometry ─────────────────────────────────────────────────────────────────
/** A manual crop box in source pixels [x, y, w, h], kept at the 9:16 output aspect. */
export function boxPx(b: Box): [number, number, number, number] {
  let w = Number(b.w)
  let h = w * BOX_ASPECT
  if (h > 1) { h = 1; w = h / BOX_ASPECT }
  const x = clamp(Number(b.x), 0, 1 - w)
  const y = clamp(Number(b.y), 0, 1 - h)
  return [x * NW, y * NH, w * NW, h * NH]
}

/** Resize a manual box around its centre; `hf` is the height as a share of the frame. */
export function resizeBox(b: Box, hf: number): Box {
  const [cx, cy, cw, ch] = boxPx(b)
  const mx = (cx + cw / 2) / NW
  const my = (cy + ch / 2) / NH
  const h = clamp(hf, 0.3, 1)
  const w = h / BOX_ASPECT
  return { x: clamp(mx - w / 2, 0, 1 - w), y: clamp(my - h / 2, 0, 1 - h), w, h }
}

/** Move a manual box so its centre sits at (cx, cy), both 0–1 of the frame. */
export function placeBox(b: Box, cx: number, cy: number): Box {
  const [, , pw, ph] = boxPx(b)
  const w = pw / NW
  const h = ph / NH
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

export const hasTraj = (t: Trajectory | null): t is Trajectory => Boolean(t?.traj?.length)

export function trajX(t: number, pts: [number, number][]): number {
  const first = pts[0]!
  if (t <= first[0]) return first[1]
  for (let i = 1; i < pts.length; i++) {
    const [t1, x1] = pts[i]!
    if (t <= t1) {
      const [t0, x0] = pts[i - 1]!
      return x0 + (t1 > t0 ? (t - t0) / (t1 - t0) : 0) * (x1 - x0)
    }
  }
  return pts[pts.length - 1]![1]
}

/** The crop window at source time `ts`, in source pixels. */
export function cropAt(ts: number, mode: CropMode, box: Box, traj: Trajectory | null): [number, number, number, number] {
  if (mode === 'manual') return boxPx(box)
  return [mode === 'ai' && hasTraj(traj) ? trajX(ts - traj.t0, traj.traj) : CENTER_X, 0, CW, NH]
}

export type ZoomState = { z: number; fx: number; fy: number }

/** Mirrors vendor/reel_zoom.py: smoothstep ramps of up to 0.35 s at each end. */
export function zoomAt(ts: number, zooms: Zoom[]): ZoomState {
  let z = 1
  let fx = 0.5
  let fy = 0.5
  for (const k of zooms) {
    const a = Number(k.start)
    const b = Number(k.end)
    if (!(b > a)) continue
    const r = Math.min(0.35, (b - a) / 2)
    const e = Math.min(clamp((ts - a) / r, 0, 1), clamp((b - ts) / r, 0, 1))
    const s = e * e * (3 - 2 * e)
    z += (k.scale - 1) * s
    fx += (k.x - 0.5) * s
    fy += (k.y - 0.5) * s
  }
  return { z, fx, fy }
}

export function zoomOffset(zs: ZoomState, W: number, H: number): [number, number] {
  return [clamp(zs.fx * W - W / zs.z / 2, 0, W - W / zs.z), clamp(zs.fy * H - H / zs.z / 2, 0, H - H / zs.z)]
}

export const subAt = (ts: number, subs: Sub[]) => subs.find((s) => ts >= s.start && ts < s.end && s.text.trim())

// ── Copy ─────────────────────────────────────────────────────────────────────
/** The strip under the top bar: where this clip is headed (CL-19). */
export function pipeMessage(p: StudioPipeline | null | undefined): string | null {
  if (!p?.state) return null
  const gate = p.gate || 2
  switch (p.state) {
    case 'posted': return '✅ Already posted on @crcmzclan. Saving an edit won’t repost it — Force post does.'
    case 'twin_of_posted': return '👯 This is a duplicate of a clip that’s already posted, so it can’t be posted.'
    case 'vetoed': return `🛑 Vetoed — kept out of highlights${p.detail ? ` (${p.detail})` : ''}.`
    case 'fire': return '🔥 Headed for the Fire reel.'
    case 'fail': return `😂 Headed for the Fail reel · ${p.reactions || 0}/${gate} WhatsApp reactions${(p.reactions || 0) >= gate ? ' — ready' : ''}.`
    case 'daily_eligible': return '📅 Headed for the daily highlights reel.'
    case 'not_eligible': return `⏸ Not eligible for a reel${p.detail ? ` — ${p.detail}` : ''}.`
    default: return null
  }
}

export const igLink = (p: StudioPipeline | null | undefined) =>
  p?.ig_url && /^https:\/\/www\.instagram\.com\//.test(p.ig_url) ? p.ig_url : null

/** Seconds-ruler step for a clip of `dur` seconds. */
export function rulerMarks(dur: number): number[] {
  if (!(dur > 0)) return []
  const step = dur <= 12 ? 1 : dur <= 30 ? 5 : dur <= 90 ? 10 : 30
  const marks: number[] = []
  for (let t = 0; t < dur - step * 0.4; t += step) marks.push(t)
  marks.push(dur)
  return marks
}
