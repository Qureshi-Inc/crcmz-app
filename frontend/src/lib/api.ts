// Read endpoints and their shapes (JOURNEY.md PS-0 / PS-1 endpoint contracts).
// Only fields the UI consumes are typed; everything else passes through untouched.
import { useQuery } from '@tanstack/react-query'
import { ApiError, getJSON, request } from './http'

export type Member = {
  online_id?: string | null
  mm_username?: string | null
  avatar?: string | null
  online?: boolean
  playing?: boolean
  game?: string | null
  game_icon?: string | null
  recent_game?: string | null
  recent_game_icon?: string | null
  last_online?: string | null
  platform?: string | null
  trophy_level?: number | null
  platinum?: number | null
  gold?: number | null
  silver?: number | null
  bronze?: number | null
  has_stats?: boolean
  linked?: boolean
  /** Steam-only rows have no online_id; this is their name. */
  name?: string | null
  /** Where the shown presence comes from: the avatar's platform badge. */
  platform_source?: Platform
  platforms?: Platform[]
  steam?: SteamPart | null
}
export type SquadResponse = { squad: Member[]; error?: string }

export type SteamGame = { name: string | null; hours?: number; icon: string | null }
/** Present when the person signed in with Steam (Settings → Steam). null = private/unknown. */
export type SteamPart = {
  persona_name: string | null; profile_url: string | null; state: string; online: boolean; playing: boolean
  game: string | null; private: boolean; level: number | null; game_count: number | null
  hours_total: number | null; hours_2weeks: number | null; top_game: SteamGame | null
}
export type Platform = 'psn' | 'steam'

export type HypeLevel = 'dead' | 'cold' | 'warm' | 'hot' | 'fire' | 'overload'
export type Hype = { count: number; pct: number; label: string; level: HypeLevel }

export type Tile = { label: string; msg: string; cls?: string; custom?: boolean; mine?: boolean; path?: string }
export type Board = { buttons: Tile[] }
export type PersonalBoard = { buttons: Tile[]; signed_in: boolean }

export type Account =
  | { state: 'signed-in'; linked: boolean; onlineId: string | null }
  | { state: 'signed-out' }
  | { state: 'unknown' }

export const SQUAD_MS = 30_000
export const HYPE_MS = 60_000

/** `/api/squad` can answer 200 with `error` set ("auth unavailable"): that is an error too. */
async function fetchSquad(signal?: AbortSignal): Promise<SquadResponse> {
  const d = await getJSON<SquadResponse>('/api/squad', signal)
  if (d.error) throw new ApiError(500, d.error, null)
  return { squad: Array.isArray(d.squad) ? d.squad : [] }
}

/** One shared store (PS-0): the shell badge and the Squad page read the same query. */
export function useSquad() {
  return useQuery({ queryKey: ['squad'], queryFn: ({ signal }) => fetchSquad(signal), refetchInterval: SQUAD_MS })
}

export function useHype() {
  return useQuery({ queryKey: ['hype'], queryFn: ({ signal }) => getJSON<Hype>('/api/hype', signal), refetchInterval: HYPE_MS })
}

export function useSharedBoard() {
  return useQuery({ queryKey: ['board', 'shared'], queryFn: ({ signal }) => getJSON<Board>('/api/soundboard', signal) })
}

export function usePersonalBoard() {
  return useQuery({ queryKey: ['board', 'mine'], queryFn: ({ signal }) => getJSON<PersonalBoard>('/api/soundboard/personal', signal) })
}

/** The session probe. The server caches the admin check for 5 min, so do we. */
export function useAdminCheck() {
  return useQuery({
    queryKey: ['admin'],
    queryFn: ({ signal }) => getJSON<{ admin: boolean }>('/api/admin/check', signal),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
  })
}

/** Who am I, and is my PSN linked? Drives the account row and the composer's "sends as crcmz-mod" note. */
export function useAccount() {
  return useQuery({
    queryKey: ['account'],
    staleTime: 10 * 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 1,
    queryFn: async ({ signal }): Promise<Account> => {
      try {
        const d = await request<{ linked?: boolean; online_id?: string | null }>('/auth/settings/psn', { signal, quiet401: true })
        return { state: 'signed-in', linked: Boolean(d.linked), onlineId: d.online_id ?? null }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return { state: 'signed-out' }
        throw e
      }
    },
  })
}

export const displayName = (m: Member) => m.online_id || m.name || m.mm_username || 'Unknown'
