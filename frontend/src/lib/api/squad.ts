import { api } from './http'

/**
 * Presence, hype and the quick-send path.
 *
 * The shapes here are written from the actual handlers in server.py, not from an
 * OpenAPI document: the endpoints return bare dicts with no response_model, so the
 * generated schema would say `{}` and a generated type would be a lie. Each `parse`
 * below therefore validates what it actually needs and tolerates the rest, which is
 * also what stops one added backend field from breaking a screen.
 */

export interface SquadMember {
  onlineId: string
  online: boolean
  platform: string | null
  game: string | null
  lastSeen: string | null
  avatar: string | null
  trophyLevel: number | null
  platinum: number
  gold: number
}

export interface SquadResponse {
  members: SquadMember[]
  /** Set when the backend answered but PSN was unavailable. */
  error: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** /api/squad → {"squad": [...], "error"?: str}. */
export function getSquad(signal?: AbortSignal) {
  return api.get<SquadResponse>('/api/squad', {
    signal,
    // PSN sweeps are slow; the backend caches but a cold call can take a while.
    timeoutMs: 25_000,
    parse: (raw): SquadResponse => {
      const root = (raw ?? {}) as { squad?: unknown; error?: unknown }
      const list = Array.isArray(root.squad) ? root.squad : []
      return {
        error: str(root.error),
        members: list.flatMap((item): SquadMember[] => {
          const m = (item ?? {}) as Record<string, unknown>
          const onlineId = str(m.online_id)
          // No id means nothing can be rendered or keyed — drop it rather than paint a
          // blank row.
          if (!onlineId) return []
          return [{
            onlineId,
            online: m.online === true,
            platform: str(m.platform),
            game: str(m.game) ?? str(m.recent_game),
            lastSeen: str(m.last_seen) ?? str(m.lastOnlineDate),
            avatar: str(m.avatar),
            trophyLevel: num(m.trophy_level),
            platinum: num(m.platinum) ?? 0,
            gold: num(m.gold) ?? 0,
          }]
        }),
      }
    },
  })
}

export interface Hype {
  count: number
  pct: number
  label: string
  level: string
}

/** /api/hype → {"count", "pct", "label", "level"}. */
export function getHype(signal?: AbortSignal) {
  return api.get<Hype>('/api/hype', {
    signal,
    parse: (raw): Hype => {
      const h = (raw ?? {}) as Record<string, unknown>
      return {
        count: num(h.count) ?? 0,
        // Clamp: the bar's width comes straight from this and a bad value would
        // overflow the container.
        pct: Math.max(0, Math.min(100, num(h.pct) ?? 0)),
        label: str(h.label) ?? 'Quiet',
        level: str(h.level) ?? 'cold',
      }
    },
  })
}

/**
 * Send a one-off message to the squad group.
 *
 * Not idempotent, and there is no server-side deduplication to lean on. Callers must
 * guard the call itself and must not retry automatically — see the mutation policy in
 * app/queryClient.ts.
 */
export function sendSquadMessage(message: string, signal?: AbortSignal) {
  return api.post<{ status?: string }>('/v2/send', { message }, { signal, timeoutMs: 20_000 })
}

/** Fire a saved board button. `asUser` posts as the signed-in member. */
export function sendBoardMessage(message: string, asUser: boolean, signal?: AbortSignal) {
  return api.post<{ status?: string }>(asUser ? '/v2/send' : '/v2/squad', { message }, {
    signal,
    timeoutMs: 20_000,
  })
}
