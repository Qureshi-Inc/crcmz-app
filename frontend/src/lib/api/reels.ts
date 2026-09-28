import { api } from './http'

/**
 * My Reels — the signed-in person's highlight-eligible clips, via the reel-review service.
 *
 * The backend (reels.py) resolves the Zitadel session to a PSN id and only returns
 * clips that person sent; admins can ask for everyone's with `all`. Clip ids contain
 * '#', so every path segment is encoded.
 */

export interface ReelClip {
  clipId: string
  sender: string
  when: string | null
  duration: number | null
  message: string
  game: string | null
  vetoed: boolean
  hasAnalysis: boolean
  analysisWindow: [number, number] | null
  featuredLabel: string | null
  latestRenderId: string | null
  override: ReelOverride | null
}

export interface ReelOverride {
  windowStart: number | null
  windowEnd: number | null
  cropMode: CropMode
  label: string | null
}

export type CropMode = 'ai' | 'center'

export interface ReelList {
  me: { psnId: string; displayName: string; admin: boolean }
  scope: 'mine' | 'all'
  clips: ReelClip[]
  /** 'roster' = the pipeline's authoritative list; 'mirror' = best-effort fallback. */
  source: 'roster' | 'mirror' | null
  rosterPushedAt: number | null
  needsPsnLink: boolean
}

export interface RenderJob {
  id: string
  clipId: string
  status: 'queued' | 'running' | 'done' | 'error' | string
  error: string | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseOverride(raw: unknown): ReelOverride | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  return {
    windowStart: num(o.window_start),
    windowEnd: num(o.window_end),
    cropMode: o.crop_mode === 'center' ? 'center' : 'ai',
    label: str(o.label),
  }
}

function parseClip(item: unknown): ReelClip[] {
  const c = (item ?? {}) as Record<string, unknown>
  const clipId = str(c.clip_id)
  if (!clipId) return []
  const w = Array.isArray(c.analysis_window) ? c.analysis_window : null
  const ws = w ? num(w[0]) : null
  const we = w ? num(w[1]) : null
  return [{
    clipId,
    sender: str(c.sender) ?? 'unknown',
    // "2026-09-26 10:38" — Safari's Date.parse rejects the space separator.
    when: str(c.when)?.replace(' ', 'T') ?? null,
    duration: num(c.duration),
    message: str(c.message) ?? '',
    game: str(c.game),
    vetoed: Boolean(c.vetoed),
    hasAnalysis: Boolean(c.has_analysis),
    analysisWindow: ws !== null && we !== null ? [ws, we] : null,
    featuredLabel: str(c.featured_label),
    latestRenderId: str(c.latest_render_id),
    override: parseOverride(c.override),
  }]
}

const seg = (clipId: string) => encodeURIComponent(clipId)

export function getReels(all: boolean, signal?: AbortSignal) {
  return api.get<ReelList>(`/api/reels${all ? '?all=true' : ''}`, {
    signal,
    // A cold reel-review may be fetching from the MCP.
    timeoutMs: 30_000,
    parse: (raw): ReelList => {
      const r = (raw ?? {}) as Record<string, unknown>
      const me = (r.me ?? {}) as Record<string, unknown>
      const roster = (r.roster ?? null) as Record<string, unknown> | null
      return {
        me: { psnId: str(me.psn_id) ?? '', displayName: str(me.display_name) ?? '', admin: Boolean(me.admin) },
        scope: r.scope === 'all' ? 'all' : 'mine',
        clips: Array.isArray(r.clips) ? r.clips.flatMap(parseClip) : [],
        source: r.source === 'roster' || r.source === 'mirror' ? r.source : null,
        rosterPushedAt: roster ? num(roster.pushed_at) : null,
        needsPsnLink: Boolean(r.needs_psn_link),
      }
    },
  })
}

export interface RenderRequest {
  windowStart: number | null
  windowEnd: number | null
  cropMode: CropMode
  label: string | null
}

function renderBody(r: RenderRequest) {
  return { window_start: r.windowStart, window_end: r.windowEnd, crop_mode: r.cropMode, label: r.label }
}

export function startRender(clipId: string, req: RenderRequest) {
  return api.post<{ render_id?: string }>(`/api/reels/clips/${seg(clipId)}/render`, renderBody(req))
}

export function getRender(rid: string, signal?: AbortSignal) {
  return api.get<RenderJob>(`/api/reels/renders/${encodeURIComponent(rid)}`, {
    signal,
    parse: (raw): RenderJob => {
      const r = (raw ?? {}) as Record<string, unknown>
      return { id: str(r.id) ?? rid, clipId: str(r.clip_id) ?? '', status: str(r.status) ?? 'unknown', error: str(r.error) }
    },
  })
}

export function saveOverride(clipId: string, req: RenderRequest) {
  return api.post(`/api/reels/clips/${seg(clipId)}/override`, renderBody(req))
}

export function vetoClip(clipId: string, reason: string) {
  return api.post(`/api/reels/clips/${seg(clipId)}/veto`, { reason })
}

export function unvetoClip(clipId: string) {
  return api.del(`/api/reels/clips/${seg(clipId)}/veto`)
}

export const renderVideoUrl = (rid: string) => `/api/reels/renders/${encodeURIComponent(rid)}/video`
export const sourceVideoUrl = (clipId: string) => `/api/reels/clips/${seg(clipId)}/source`
