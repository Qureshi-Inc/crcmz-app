// PS-2 · Clips endpoint contract. Only the fields the UI reads are typed.
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getJSON } from './http'

// ── GET /api/pipeline-status (30 s while Overview is visible) ─────────────────
export type ManifestClip = { uid: string; sender: string | null; duration: number | null; at: number | null; included: boolean | null; reason: string | null }
export type LastMontage = { version: number; year: number; month: number; clips: number; duration: number; sent: boolean }
export type PipelineStatus = {
  clips_this_month: number
  last_clip_at: number | null
  last_clip_sender: string | null
  next_build_ts: number | null
  next_build_label: string | null
  next_build_month: string | null
  last_montage: LastMontage | null
  clips: ManifestClip[]
}
export const PIPELINE_MS = 30_000

export function usePipelineStatus() {
  return useQuery({
    queryKey: ['pipeline-status'],
    queryFn: ({ signal }) => getJSON<PipelineStatus>('/api/pipeline-status', signal),
    refetchInterval: PIPELINE_MS,
  })
}

// ── GET /api/reels (no poll; on load, focus, after Sync) ──────────────────────
export type PipelineState = { state?: string; label?: string; detail?: string; reactions?: number; gate?: number }
export type Reel = {
  clip_id: string
  sender?: string | null
  game?: string | null
  duration?: number | null
  when?: string | null
  message?: string | null
  analysis_window?: [number, number] | null
  pipeline?: PipelineState | null
  has_analysis?: boolean
  has_render?: boolean
  override?: unknown
  vetoed?: boolean
}
export type ReelsResponse = {
  me: { psn_id: string; display_name: string; admin: boolean } | null
  scope: 'mine' | 'all'
  clips: Reel[]
  source: string | null
  roster: { pushed_at?: number } | null
  needs_psn_link: boolean
}

export function useReels(all: boolean) {
  return useQuery({
    queryKey: ['reels', all ? 'all' : 'mine'],
    queryFn: ({ signal }) => getJSON<ReelsResponse>(all ? '/api/reels?all=true' : '/api/reels', signal),
    staleTime: 60_000,
  })
}

export const reelFrame = (r: Reel) => {
  const w = r.analysis_window
  const t = w && w[0] != null ? (Number(w[0]) + Number(w[1])) / 2 : 1
  return `/api/reels/clips/${encodeURIComponent(r.clip_id)}/frame?t=${t.toFixed(1)}`
}
export const reelSource = (r: Reel) => `/api/reels/clips/${encodeURIComponent(r.clip_id)}/source`

// ── GET /api/video-uploads/mine ───────────────────────────────────────────────
export type Upload = {
  video_post_id: string
  status: 'queued' | 'posted' | 'skipped' | string
  caption: string | null
  filename: string | null
  uploaded_at: number
  posted_at: number | null
  skip_reason: string | null
  duration_seconds: number | null
  platforms: Record<string, { url: string } | null>
}
export type UploadsResponse = { psn_id: string; uploads: Upload[]; can_upload: boolean; open_session: unknown }

export function useUploads() {
  return useQuery({
    queryKey: ['uploads', 'mine'],
    queryFn: ({ signal }) => getJSON<UploadsResponse>('/api/video-uploads/mine', signal),
  })
}

// ── GET /clips (the catalogue) and GET /clips/{uid} ───────────────────────────
export type Clip = {
  message_uid: string
  sender_online_id: string | null
  psn_created_at: number | null
  created_at?: number | null
  duration_seconds: number | null
  width: number | null
  height: number | null
  file_size: number | null
  status: string
  archive_status: string | null
  whatsapp_delivered_at: number | null
  montage_eligible: number | boolean | null
  game_name?: string | null
  body?: string | null
  last_error?: string | null
}
export type ClipFilters = { month: string; sender: string; status: string }
export const CLIP_PAGE = 50

function clipsUrl(f: ClipFilters, offset: number) {
  const p = new URLSearchParams({ limit: String(CLIP_PAGE), offset: String(offset) })
  if (f.month) p.set('month', f.month)
  if (f.sender) p.set('sender', f.sender)
  if (f.status) p.set('status', f.status)
  return `/clips?${p}`
}

export function useClipCatalogue(f: ClipFilters) {
  return useInfiniteQuery({
    queryKey: ['clips', f],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => getJSON<{ clips: Clip[]; count: number }>(clipsUrl(f, pageParam), signal),
    getNextPageParam: (last, pages) => (last.clips.length < CLIP_PAGE ? undefined : pages.length * CLIP_PAGE),
    placeholderData: keepPreviousData,
  })
}

export function useClipDetail(uid: string | null) {
  return useQuery({
    queryKey: ['clip', uid],
    enabled: uid !== null,
    queryFn: ({ signal }) => getJSON<Clip>(`/clips/${encodeURIComponent(uid!)}`, signal),
  })
}

/** `uid` holds '#', so it goes in the query string, URL-encoded (B-1: session cookie). */
export const clipMedia = (uid: string) => `/api/clips/media?uid=${encodeURIComponent(uid)}`

// ── Formatting ────────────────────────────────────────────────────────────────
export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—'
  const n = Math.round(s)
  if (n < 60) return `${n}s`
  return `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`
}

export function fmtAgo(tsSec: number | null | undefined, now = Date.now()): string {
  if (!tsSec) return ''
  const d = Math.max(0, now / 1000 - tsSec)
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`
  return new Date(tsSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function fmtDate(tsSec: number | null | undefined): string {
  if (!tsSec) return '—'
  return new Date(tsSec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '—'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** "3d 4h", "5h 12m", "8m". Null once the time has passed. */
export function fmtCountdown(targetSec: number | null | undefined, now = Date.now()): string | null {
  if (!targetSec) return null
  const s = Math.floor(targetSec - now / 1000)
  if (s <= 0) return null
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${Math.max(1, m)}m`
}

/** reel-review's `when` is "YYYY-MM-DD HH:MM:SS". */
export function whenTs(w: string | null | undefined): number {
  if (!w) return 0
  const t = Date.parse(String(w).replace(' ', 'T'))
  return Number.isNaN(t) ? 0 : t / 1000
}

export const PIPE_TEXT: Record<string, string> = {
  posted: '✅ Posted', twin_of_posted: '👯 Duplicate of posted', vetoed: '🛑 Vetoed',
  fire: '🔥 Fire reel', daily_eligible: '📅 Daily highlights', not_eligible: '⏸ Not eligible',
}
export const PIPE_TONE: Record<string, 'live' | 'accent' | 'gold' | 'dim' | 'warn'> = {
  posted: 'live', daily_eligible: 'live', fire: 'accent', fail: 'accent', twin_of_posted: 'warn', vetoed: 'warn', not_eligible: 'dim',
}
export function pipeText(p: PipelineState | null | undefined): string {
  if (!p?.state) return ''
  if (p.state === 'fail') return `😂 Fail reel · ${p.reactions || 0}/${p.gate || 2} reactions`
  if (p.state === 'not_eligible') return PIPE_TEXT.not_eligible + (p.detail ? ` · ${p.detail}` : '')
  return PIPE_TEXT[p.state] || p.label || ''
}

export const CLIP_STATUS: Record<string, string> = {
  delivered: 'Sent to WhatsApp', archived: 'Archived', discovered: 'Waiting', failed: 'Failed',
}
