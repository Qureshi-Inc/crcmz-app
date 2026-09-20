import { api } from './http'

/**
 * Clips and the montage pipeline.
 *
 * Worth knowing before building anything here: **there is no media endpoint.** The
 * clip rows carry `storage_key_original` and `storage_key_normalized` pointing into the
 * S3 bucket, and the pipeline uploads video there and forwards it to WhatsApp and
 * Discord — but nothing in server.py generates a presigned URL, serves bytes, or
 * produces a thumbnail. /clips and /clips/{uid} return metadata only.
 *
 * So the Clips screen shows what actually exists: who, when, how long, whether it went
 * out, whether it is in the montage. It does not render a <video> against a URL that is
 * not there, and it says so rather than showing broken players. Adding a presigned-URL
 * endpoint is a backend change, tracked as a blocker in docs/ux/STATUS.md.
 */

export interface Clip {
  uid: string
  sender: string
  groupName: string | null
  /** Epoch seconds. The DB stores REAL. */
  createdAt: number | null
  discoveredAt: number | null
  status: string
  durationSeconds: number | null
  width: number | null
  height: number | null
  fileSize: number | null
  body: string | null
  montageEligible: boolean
  montageId: string | null
  whatsappDeliveredAt: number | null
  lastError: string | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseClip(item: unknown): Clip[] {
  const c = (item ?? {}) as Record<string, unknown>
  const uid = str(c.message_uid)
  if (!uid) return []
  return [{
    uid,
    sender: str(c.sender_online_id) ?? 'unknown',
    groupName: str(c.psn_group_name),
    createdAt: num(c.psn_created_at),
    discoveredAt: num(c.discovered_at),
    status: str(c.status) ?? 'unknown',
    durationSeconds: num(c.duration_seconds),
    width: num(c.width),
    height: num(c.height),
    fileSize: num(c.file_size),
    body: str(c.body),
    // The column defaults to 1, so absent means eligible — matching the backend
    // rather than defaulting to "excluded" and misreporting every older row.
    montageEligible: c.montage_eligible === undefined ? true : Boolean(c.montage_eligible),
    montageId: str(c.montage_id),
    whatsappDeliveredAt: num(c.whatsapp_delivered_at),
    lastError: str(c.last_error),
  }]
}

export interface ClipFilters {
  /** 'YYYY-MM' */
  month?: string
  sender?: string
  status?: string
  montageEligible?: boolean
  limit?: number
  offset?: number
}

export interface ClipPage {
  clips: Clip[]
  count: number
}

export function getClips(filters: ClipFilters = {}, signal?: AbortSignal) {
  const qs = new URLSearchParams()
  if (filters.month) qs.set('month', filters.month)
  if (filters.sender) qs.set('sender', filters.sender)
  if (filters.status) qs.set('status', filters.status)
  if (filters.montageEligible !== undefined) {
    qs.set('montage_eligible', String(filters.montageEligible))
  }
  qs.set('limit', String(Math.min(filters.limit ?? 50, 200)))
  if (filters.offset) qs.set('offset', String(filters.offset))

  return api.get<ClipPage>(`/clips?${qs.toString()}`, {
    signal,
    parse: (raw): ClipPage => {
      const root = (raw ?? {}) as { clips?: unknown; count?: unknown }
      const list = Array.isArray(root.clips) ? root.clips : []
      return { clips: list.flatMap(parseClip), count: num(root.count) ?? list.length }
    },
  })
}

/**
 * Re-forward a clip to WhatsApp. A write, and not idempotent — the group gets the
 * video again. Never retried automatically.
 */
export function resendClip(uid: string, signal?: AbortSignal) {
  return api.post<{ status?: string }>(`/api/clips/${encodeURIComponent(uid)}/resend`, undefined, {
    signal,
    timeoutMs: 30_000,
  })
}

/* ── Pipeline status ───────────────────────────────────────────────────────────
 * The legacy Clips tab opened with this: service health, versions, last ping. That is
 * operator information, and it was the first thing a member saw when they wanted to
 * look at clips. The montage summary belongs on the Clips screen; the service table
 * moved to Admin.
 */

export interface ServiceHealth {
  name: string
  status: string
  version: string | null
  at: number | null
}

export interface PipelineStatus {
  services: ServiceHealth[]
  clipsThisMonth: number | null
  lastClipAt: number | null
  lastClipSender: string | null
  lastMontage: { month: string | null; status: string | null; duration: number | null } | null
  nextBuildMonth: string | null
  nextBuildLabel: string | null
  nextBuildTs: number | null
}

export function getPipelineStatus(signal?: AbortSignal) {
  return api.get<PipelineStatus>('/api/pipeline-status', {
    signal,
    // It pings other services; a slow one should not blank the screen instantly.
    timeoutMs: 20_000,
    parse: (raw): PipelineStatus => {
      const r = (raw ?? {}) as Record<string, unknown>
      const svcRoot = (r.services ?? {}) as Record<string, unknown>
      const services = Object.entries(svcRoot).map(([name, v]): ServiceHealth => {
        const s = (v ?? {}) as Record<string, unknown>
        return {
          name,
          status: str(s.status) ?? 'unknown',
          version: str(s.version),
          at: num(s.at) ?? (str(s.at) ? Date.parse(str(s.at) as string) / 1000 : null),
        }
      })
      const lm = (r.last_montage ?? null) as Record<string, unknown> | null
      return {
        services,
        clipsThisMonth: num(r.clips_this_month),
        lastClipAt: num(r.last_clip_at) ?? (str(r.last_clip_at) ? Date.parse(str(r.last_clip_at) as string) / 1000 : null),
        lastClipSender: str(r.last_clip_sender),
        lastMontage: lm
          ? { month: str(lm.month), status: str(lm.status), duration: num(lm.duration) }
          : null,
        nextBuildMonth: str(r.next_build_month),
        nextBuildLabel: str(r.next_build_label),
        nextBuildTs: num(r.next_build_ts),
      }
    },
  })
}
