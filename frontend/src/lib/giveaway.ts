// Giveaway routes (PS-5). Reading never mutates: the page only POSTs from an
// admin's explicit, confirmed action. The server is unchanged.
import { markSignedOut } from './session'
import { ApiError, request } from './http'

export type GwStatus = 'draft' | 'open' | 'locked' | 'drawn' | 'revealed' | 'closed'
export type GwEntry = { member_id: string; display_name: string }
export type GwDraw = {
  draw_number: number; winner_id: string | null; winner_name: string | null; drawn_at: string
  status: string; manifest_hash: string | null; invalidation_reason?: string | null
}
export type Giveaway = {
  id: number; title: string; prize: string; status: GwStatus
  draw_at: string | null; reveal_at: string | null; drawn_at: string | null; revealed_at: string | null; closed_at?: string | null
  entries: GwEntry[]; active_draw: GwDraw | null
}
export type GwMember = { id: string; display: string }
export type Rotation = {
  cycle: number; total_members: number; won_count: number; eligible_count: number
  eligible?: GwMember[]; won_members: { member_id: string; display_name: string; won_at: string; giveaway_id: number | null }[]
  all_members: GwMember[]
}
export type GwData = { giveaway: Giveaway | null; rotation: Rotation; is_admin: boolean; user_eligible: boolean; user_won_this_cycle: boolean }

/** Members never see drafts (F-6): the member view treats one as "no giveaway". */
export const memberSees = (g: Giveaway | null, admin: boolean) => (g && (admin || g.status !== 'draft') ? g : null)
export const PENDING: GwStatus[] = ['open', 'locked', 'drawn']

/**
 * reveal_at comes from a datetime-local field ("2026-10-03T20:00"), so it is
 * local time. new Date() would read a bare date as UTC; parse the parts instead.
 * Server timestamps (with an offset) parse normally.
 */
export function parseWhen(s: string | null | undefined): number | null {
  if (!s) return null
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  const [d, tm = '00:00'] = s.split('T')
  const [y, mo, dy] = (d ?? '').split('-').map(Number)
  const [h, mi] = tm.slice(0, 5).split(':').map(Number)
  if (!y || !mo || !dy) return null
  const t = new Date(y, mo - 1, dy, h || 0, mi || 0).getTime()
  return Number.isFinite(t) ? t : null
}
export const fmtWhen = (ms: number | null, withYear = false) =>
  ms == null ? '—' : new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' })
/** The value a datetime-local input wants, in local time. */
export function toLocalInput(ms: number | null): string {
  if (ms == null) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export type Parts = { d: number; h: number; m: number; s: number }
export function splitMs(ms: number): Parts {
  const t = Math.max(0, Math.floor(ms / 1000))
  return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 }
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
export function countdownLabel(lead: string, p: Parts): string {
  const bits = [p.d ? plural(p.d, 'day') : '', plural(p.h, 'hour'), plural(p.m, 'minute')].filter(Boolean)
  return `${lead} ${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`
}

// ── Admin writes ──────────────────────────────────────────────────────────────
type Ok = { status?: string; entries?: number; winner?: string }
const base = (id: number) => `/api/giveaway/${id}`
export const createGiveaway = (b: { title: string; prize: string; reveal_at: string | null }) => request<Giveaway>('/api/giveaway', { body: b })
export const publishGiveaway = (id: number) => request<Ok>(`${base(id)}/publish`, { method: 'POST' })
export const updateGiveaway = (id: number, b: { title: string; prize: string; reveal_at: string | null }) => request<Giveaway>(base(id), { method: 'PUT', body: b })
export const drawAndReveal = (id: number) => request<Ok>(`${base(id)}/draw-and-reveal`, { method: 'POST', timeoutMs: 30_000 })
export const redraw = (id: number, reason: string) => request<Ok>(`${base(id)}/redraw`, { body: { reason }, timeoutMs: 30_000 })
export const closeGiveaway = (id: number) => request<Ok>(`${base(id)}/close`, { method: 'POST' })
export const addEntry = (id: number, m: GwMember) => request<Ok>(`${base(id)}/entries`, { body: { member_id: m.id, display_name: m.display } })
export const removeEntry = (id: number, memberId: string) => request<Ok>(`${base(id)}/entries/${encodeURIComponent(memberId)}`, { method: 'DELETE' })

export type SeedResult =
  | { kind: 'ok'; winner: GwMember }
  | { kind: 'no_match'; members: GwMember[] }
  | { kind: 'ambiguous'; members: GwMember[] }

/** Reset & seed answers 404/409 with a pick list in the body, so it reads the body itself. */
export async function resetAndSeed(b: { winner_query: string; title: string; prize: string }): Promise<SeedResult> {
  const res = await fetch('/api/giveaway/admin/reset-and-seed', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })
  const body = (await res.json().catch(() => ({}))) as {
    error?: string; detail?: string; all_members?: GwMember[]; matches?: GwMember[]; seeded_winner?: GwMember
  }
  if (res.ok && body.seeded_winner) return { kind: 'ok', winner: body.seeded_winner }
  if (res.status === 404 && body.error === 'no_match') return { kind: 'no_match', members: body.all_members ?? [] }
  if (res.status === 409 && body.error === 'ambiguous') return { kind: 'ambiguous', members: body.matches ?? [] }
  if (res.status === 401) markSignedOut()
  throw new ApiError(res.status, body.detail || body.error || '', null)
}
