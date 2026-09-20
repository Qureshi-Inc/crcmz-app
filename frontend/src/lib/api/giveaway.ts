import { api } from './http'

/**
 * Giveaways.
 *
 * Read this before touching anything here.
 *
 * **Nothing in this module is called on mount.** Every function below except
 * `getGiveaway` and `getHistory` changes real state — draws a real winner from real
 * members, reveals it, closes the cycle. The legacy dashboard called draw-and-reveal
 * *from inside its loader*: if an admin opened the Giveaway tab after the reveal time
 * had passed, loadGiveaway() POSTed to /draw-and-reveal and then recursed into itself.
 * That is a mutation triggered by rendering, and it is the reason the execution plan says
 * "component mounting or refetching must not accidentally trigger a draw".
 *
 * That behaviour is deliberately **not** reproduced. Which means a scheduled reveal now
 * only happens when an admin presses the button — see the blocker in docs/ux/STATUS.md:
 * making it automatic again needs an idempotent backend job, not a frontend side effect.
 *
 * The status machine, from giveaway.py:
 *   draft → open → locked → drawn → revealed → closed
 * with redraw available from `drawn`. The server validates every transition and returns
 * `{"error": "..."}` with a 200 for a refused one, so the helpers below turn that into a
 * thrown error rather than letting it look like success.
 */

export interface GiveawayEntry {
  memberId: string
  name: string
}

export interface GiveawayDraw {
  winnerName: string | null
  winnerId: string | null
}

export interface Giveaway {
  id: number
  title: string
  prize: string
  status: 'draft' | 'open' | 'locked' | 'drawn' | 'revealed' | 'closed' | string
  drawAt: string | null
  revealAt: string | null
  entries: GiveawayEntry[]
  /** Withheld from non-admins until the reveal — the backend nulls it. */
  activeDraw: GiveawayDraw | null
}

export interface Rotation {
  cycle: number
  totalMembers: number
  wonCount: number
  eligibleCount: number
  wonMembers: { memberId: string; name: string }[]
  allMembers: { memberId: string; name: string }[]
}

export interface GiveawayState {
  giveaway: Giveaway | null
  rotation: Rotation | null
  isAdmin: boolean
  userEligible: boolean
  userWonThisCycle: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function parseMember(item: unknown): { memberId: string; name: string }[] {
  const m = (item ?? {}) as Record<string, unknown>
  const id = str(m.member_id) ?? str(m.id)
  if (!id) return []
  return [{ memberId: id, name: str(m.display) ?? str(m.name) ?? id }]
}

export function getGiveaway(signal?: AbortSignal) {
  return api.get<GiveawayState>('/api/giveaway', {
    signal,
    timeoutMs: 25_000,
    parse: (raw): GiveawayState => {
      const root = (raw ?? {}) as Record<string, unknown>
      const g = (root.giveaway ?? null) as Record<string, unknown> | null
      const rot = (root.rotation ?? null) as Record<string, unknown> | null
      const draw = (g?.active_draw ?? null) as Record<string, unknown> | null
      return {
        isAdmin: root.is_admin === true,
        userEligible: root.user_eligible === true,
        userWonThisCycle: root.user_won_this_cycle === true,
        giveaway: g
          ? {
              id: num(g.id),
              title: str(g.title) ?? '',
              prize: str(g.prize) ?? '',
              status: str(g.status) ?? 'draft',
              drawAt: str(g.draw_at),
              revealAt: str(g.reveal_at),
              entries: Array.isArray(g.entries) ? g.entries.flatMap(parseMember) : [],
              activeDraw: draw
                ? { winnerName: str(draw.winner_name), winnerId: str(draw.winner_id) }
                : null,
            }
          : null,
        rotation: rot
          ? {
              cycle: num(rot.cycle),
              totalMembers: num(rot.total_members),
              wonCount: num(rot.won_count),
              eligibleCount: num(rot.eligible_count),
              wonMembers: Array.isArray(rot.won_members) ? rot.won_members.flatMap(parseMember) : [],
              allMembers: Array.isArray(rot.all_members) ? rot.all_members.flatMap(parseMember) : [],
            }
          : null,
      }
    },
  })
}

export interface HistoryRow {
  id: number
  title: string
  prize: string
  winnerName: string | null
  cycle: number
  closedAt: string | null
}

export function getHistory(signal?: AbortSignal) {
  return api.get<HistoryRow[]>('/api/giveaway/history', {
    signal,
    parse: (raw): HistoryRow[] => {
      const root = (raw ?? {}) as Record<string, unknown>
      const list = Array.isArray(root.history) ? root.history : Array.isArray(raw) ? raw : []
      return list.flatMap(item => {
        const h = (item ?? {}) as Record<string, unknown>
        return [{
          id: num(h.id),
          title: str(h.title) ?? '',
          prize: str(h.prize) ?? '',
          winnerName: str(h.winner_name) ?? str(h.winner),
          cycle: num(h.cycle),
          closedAt: str(h.closed_at) ?? str(h.created_at),
        }]
      })
    },
  })
}

/**
 * The transition endpoints return 200 with `{"error": "..."}` when the server refuses —
 * "must be open or locked, is 'revealed'", "no entries in this giveaway". A 200 body is
 * not an outcome, so this turns a refusal into a thrown error; otherwise the UI would
 * report a draw that never happened.
 */
async function mutate(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<unknown> {
  const result = await api[method === 'PUT' ? 'put' : 'post']<Record<string, unknown>>(path, body, {
    timeoutMs: 30_000,
  })
  const error = result && typeof result === 'object' ? result.error : null
  if (typeof error === 'string' && error) throw new Error(error)
  return result
}

export interface GiveawayInput {
  title: string
  prize: string
  /** ISO date strings, or null for "no scheduled time". */
  drawAt: string | null
  revealAt: string | null
}

const body = (input: GiveawayInput) => ({
  title: input.title,
  prize: input.prize,
  draw_at: input.drawAt,
  reveal_at: input.revealAt,
})

export const createGiveaway = (input: GiveawayInput) => mutate('/api/giveaway', 'POST', body(input))
export const updateGiveaway = (id: number, input: GiveawayInput) =>
  mutate(`/api/giveaway/${id}`, 'PUT', body(input))

export const publishGiveaway = (id: number) => mutate(`/api/giveaway/${id}/publish`, 'POST')
export const lockGiveaway = (id: number) => mutate(`/api/giveaway/${id}/lock`, 'POST')
export const drawWinner = (id: number) => mutate(`/api/giveaway/${id}/draw`, 'POST')
export const revealWinner = (id: number) => mutate(`/api/giveaway/${id}/reveal`, 'POST')
export const drawAndReveal = (id: number) => mutate(`/api/giveaway/${id}/draw-and-reveal`, 'POST')
export const closeGiveaway = (id: number) => mutate(`/api/giveaway/${id}/close`, 'POST')
export const redrawWinner = (id: number) => mutate(`/api/giveaway/${id}/redraw`, 'POST')

/**
 * Add someone to a giveaway. Both fields are required — the handler reads
 * `body["member_id"]` and `body["display_name"]` with subscripts, so omitting either is a
 * KeyError and a 500 rather than a validation message.
 */
export const addEntry = (id: number, memberId: string, displayName: string) =>
  mutate(`/api/giveaway/${id}/entries`, 'POST', {
    member_id: memberId,
    display_name: displayName,
  })

export const removeEntry = (id: number, memberId: string) =>
  api.del<{ status?: string }>(`/api/giveaway/${id}/entries/${encodeURIComponent(memberId)}`)
