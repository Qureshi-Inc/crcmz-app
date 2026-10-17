import { useQuery } from '@tanstack/react-query'
import { getJSON, request } from './http'

export type Format = 'knockout' | 'double_elim' | 'league' | 'groups' | 'ffa'
export type Status = 'draft' | 'active' | 'complete'

export interface Mode {
  label: string; blurb: string; team_size: number; team_sizes: number[]; kind: 'h2h' | 'ffa'
  unit: string; draws: boolean; pens: boolean; formats: Format[]; best_of: number[]; default_bo: number
  legs: boolean; maps: boolean; default_format: Format; placement_points: number[]; kill_points: number
  lobbies: number; target: number | null
}
export interface Game { name: string; short: string; blurb: string; color: string; modes: Record<string, Mode> }
export interface Catalog { games: Record<string, Game>; formats: Record<Format, { label: string; blurb: string }>; colors: string[] }

export interface Settings {
  best_of: number; legs: number; third_place: boolean; final_reset: boolean; league_legs: number
  group_size: number; advance: number; pts_win: number; pts_draw: number; lobbies: number
  placement_points: number[]; kill_points: number; game_name: string; unit: string
}

export interface Member { id: string; display_name: string; psn_id: string; is_guest: boolean }
export interface Entrant { id: string; name: string; color: string; seed: number; group_label: string | null; members: Member[] }
export interface GameScore { s1: number; s2: number; map?: string }
export interface Match {
  id: string; stage: 'W' | 'L' | 'GF' | 'K' | 'G' | 'R' | 'P'; round: number; slot: number; group: string | null
  code: string; e1: string | null; e2: string | null; wait1: string | null; wait2: string | null
  games: GameScore[]; score1: number | null; score2: number | null; pens1: number | null; pens2: number | null
  result_side: number | null; winner_id: string | null; status: 'pending' | 'played' | 'bye' | 'void'
  playable: boolean; next_id: string | null; source: string | null; played_at: string | null
  partial: GameScore[]
}
export interface TableRow { entrant_id: string; pos: number; p: number; w: number; d: number; l: number; f: number; a: number; pts: number; form: string[] }
export interface LobbyResult { entrant_id: string; placement: number | null; kills: number; deaths: number | null }
export interface Lobby { id: string; num: number; status: 'pending' | 'played'; source: string | null; results: LobbyResult[] }
export interface BoardRow {
  entrant_id: string; pos: number; points: number; kills: number; deaths: number; wins: number; played: number
  avg_place: number | null; games: Record<string, { placement: number | null; kills: number; deaths: number | null; points: number }>
}
export interface Labels {
  game: string; mode: string; format: Format; game_label: string; game_short: string; game_color: string
  mode_label: string; format_label: string; kind: 'h2h' | 'ffa'; unit: string; draws: boolean; pens: boolean
  maps: boolean; target: number | null
}
export interface Summary extends Labels {
  id: string; name: string; status: Status; team_size: number; created_at: string; started_at: string | null
  finished_at: string | null; entrant_count: number; champion: { name: string; color: string } | null
  progress: { played: number; total: number }
}
export interface Tournament extends Labels {
  id: string; name: string; status: Status; team_size: number; settings: Settings; champion_id: string | null
  created_by: string; created_at: string; started_at: string | null; finished_at: string | null
  entrants: Entrant[]; matches: Match[]; tables: Record<string, TableRow[]>; lobbies: Lobby[]
  leaderboard: BoardRow[]; progress: { played: number; total: number }; inbox: number; can_manage?: boolean
}
export interface Person { key: string; display_name: string; psn_id: string; is_guest: boolean; player_id: string | null }

export interface Reading {
  kind: 'h2h' | 'scoreboard' | 'unknown'; game?: string; confidence?: number
  sides?: { label?: string; gamertags?: string[]; score?: number | null }[]
  penalties?: [number, number] | null
  rows?: { gamertag?: string; team?: string | null; placement?: number | null; kills?: number | null; deaths?: number | null }[]
}
export interface Suggestion {
  found: boolean; confident?: boolean; oriented?: boolean; type?: 'match' | 'lobby'; tournament_id?: string
  target_id?: string; label?: string; games?: { s1: number | null; s2: number | null }[]; pens?: number[] | null
  rows?: LobbyResult[]
}
export interface Shot {
  id: string; created_at: string; sender: string; source: string; status: 'reading' | 'pending' | 'applied' | 'dismissed'
  reading: Reading | null; suggestion: Suggestion | null; tournament_id: string | null; target_id: string | null; note: string | null
}

const T = '/api/tourney'
const send = <R,>(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  request<R>(url, { method, body: body ?? (method === 'DELETE' ? undefined : {}) })

export const useCatalog = () => useQuery({ queryKey: ['tourney', 'catalog'], staleTime: Infinity, queryFn: ({ signal }) => getJSON<Catalog>(`${T}/catalog`, signal) })
export const usePeople = () => useQuery({ queryKey: ['tourney', 'people'], staleTime: 60_000, queryFn: ({ signal }) => getJSON<Person[]>(`${T}/people`, signal) })
export const useTournaments = () => useQuery({ queryKey: ['tourney', 'list'], refetchInterval: 30_000, queryFn: ({ signal }) => getJSON<Summary[]>(`${T}/tournaments`, signal) })
export const useTournament = (id: string) => useQuery<Tournament>({
  queryKey: ['tourney', 't', id], refetchInterval: (q) => (q.state.data?.status === 'active' ? 10_000 : false),
  queryFn: ({ signal }) => getJSON<Tournament>(`${T}/tournaments/${id}`, signal),
})
export const useShots = (id: string, on: boolean) => useQuery({
  queryKey: ['tourney', 'shots', id], enabled: on, refetchInterval: 15_000,
  queryFn: ({ signal }) => getJSON<Shot[]>(`${T}/shots?tournament_id=${encodeURIComponent(id)}`, signal),
})

export const api = {
  create: (b: { name: string; game: string; mode: string; format: Format; team_size: number; settings: Partial<Settings> }) => send<Tournament>(`${T}/tournaments`, 'POST', b),
  rename: (id: string, name: string) => send<Tournament>(`${T}/tournaments/${id}`, 'PATCH', { name }),
  rules: (id: string, settings: Partial<Settings>) => send<Tournament>(`${T}/tournaments/${id}`, 'PATCH', { settings }),
  remove: (id: string) => send<{ ok: boolean }>(`${T}/tournaments/${id}`, 'DELETE'),
  addEntrants: (id: string, entries: { name?: string; color?: string; members: string[] }[]) => send<Tournament>(`${T}/tournaments/${id}/entrants`, 'POST', { entries }),
  editEntrant: (eid: string, b: { name?: string; color?: string; members?: string[] }) => send<Tournament>(`${T}/entrants/${eid}`, 'PATCH', b),
  removeEntrant: (eid: string) => send<Tournament>(`${T}/entrants/${eid}`, 'DELETE'),
  seed: (id: string, b: { order?: string[]; shuffle?: boolean }) => send<Tournament>(`${T}/tournaments/${id}/seeding`, 'POST', b),
  autoTeams: (id: string, members: string[]) => send<Tournament>(`${T}/tournaments/${id}/auto-teams`, 'POST', { members }),
  start: (id: string) => send<Tournament>(`${T}/tournaments/${id}/start`, 'POST'),
  reset: (id: string) => send<Tournament>(`${T}/tournaments/${id}/reset`, 'POST'),
  addLobby: (id: string) => send<Tournament>(`${T}/tournaments/${id}/lobbies`, 'POST'),
  report: (mid: string, games: GameScore[], pens: (number | null)[] | null) => send<Tournament>(`${T}/matches/${mid}/result`, 'POST', { games, pens }),
  undo: (mid: string) => send<Tournament>(`${T}/matches/${mid}/result`, 'DELETE'),
  reportLobby: (lid: string, rows: LobbyResult[]) => send<Tournament>(`${T}/lobbies/${lid}/result`, 'POST', { rows }),
  undoLobby: (lid: string) => send<Tournament>(`${T}/lobbies/${lid}/result`, 'DELETE'),
  guest: (name: string, psn_id: string) => send<Person>(`${T}/guests`, 'POST', { name, psn_id }),
  read: (b: { image_b64: string; mime: string; tournament_id?: string; target_id?: string }) =>
    request<{ reading: Reading; suggestion: Suggestion }>(`${T}/read`, { method: 'POST', body: b, timeoutMs: 200_000 }),
  applyShot: (sid: string, b: { target_id?: string; games?: GameScore[]; pens?: (number | null)[] | null; rows?: LobbyResult[] }) => send<Tournament>(`${T}/shots/${sid}/apply`, 'POST', b),
  dismissShot: (sid: string) => send<{ ok: boolean }>(`${T}/shots/${sid}/dismiss`, 'POST'),
}

/** Downscale a picked screenshot to a JPEG the AI server reads quickly. */
export async function fileToJpeg(file: File, max = 1600): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Not an image')); i.src = url
    })
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.85).split(',')[1] ?? ''
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function roundName(stage: Match['stage'], round: number, rounds: number): string {
  if (stage === 'GF') return round === 1 ? 'Grand final' : 'Final reset'
  if (stage === 'P') return '3rd place'
  if (stage === 'L') return round === rounds ? 'Losers final' : `Losers round ${round}`
  if (stage === 'R' || stage === 'G') return `Matchday ${round}`
  const left = rounds - round
  if (left === 0) return 'Final'
  if (left === 1) return 'Semi-finals'
  if (left === 2) return 'Quarter-finals'
  return `Round of ${2 ** (left + 1)}`
}

export function stageName(stage: Match['stage']): string {
  return { W: 'Winners bracket', L: 'Losers bracket', GF: 'Grand final', K: 'Knockout', G: 'Group stage', R: 'League', P: '3rd place' }[stage]
}
