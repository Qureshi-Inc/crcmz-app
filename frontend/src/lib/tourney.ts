import { getJSON, request } from './http'

export type TournamentFormat = 'single_elim' | 'double_elim' | 'round_robin' | 'group_knockout'
export type TournamentStatus = 'draft' | 'active' | 'complete'
export type MatchStatus = 'pending' | 'played' | 'bye'

export interface Player {
  id: string
  display_name: string
  zitadel_id: string | null
  is_custom: number
}

export interface Team {
  id: string
  tournament_id: string
  name: string
  color: string
  players?: Player[]
}

export interface Match {
  id: string
  tournament_id: string
  round: number
  match_num: number
  team1_id: string | null
  team2_id: string | null
  score1: number | null
  score2: number | null
  winner_id: string | null
  status: MatchStatus
  screenshot_url: string | null
  played_at: string | null
  next_match_id: string | null
  team1?: Team | null
  team2?: Team | null
  winner?: Team | null
}

export interface Round {
  round: number
  matches: Match[]
}

export interface Tournament {
  id: string
  name: string
  game: string
  format: TournamentFormat
  status: TournamentStatus
  created_by: string | null
  created_at: string
  team_count?: number
  teams?: Team[]
  rounds?: Round[]
}

export const FORMAT_LABELS: Record<TournamentFormat, string> = {
  single_elim: 'Single Elimination',
  double_elim: 'Double Elimination',
  round_robin: 'Round Robin',
  group_knockout: 'Group + Knockout',
}

export const GAMES = ['FIFA', 'COD', 'Warzone', 'Rocket League', 'NBA 2K', 'Madden', 'Tekken', 'Other']

export const listTournaments = (status?: string, signal?: AbortSignal) =>
  getJSON<Tournament[]>(`/api/tourney/tournaments${status ? `?status=${status}` : ''}`, signal)

export const getTournament = (id: string, signal?: AbortSignal) =>
  getJSON<Tournament>(`/api/tourney/tournaments/${id}`, signal)

export const createTournament = (body: { name: string; game: string; format: string }) =>
  request<Tournament>('/api/tourney/tournaments', { method: 'POST', body })

export const setTournamentStatus = (id: string, status: string) =>
  request(`/api/tourney/tournaments/${id}/status`, { method: 'PATCH', body: { status } })

export const listPlayers = (signal?: AbortSignal) =>
  getJSON<Player[]>('/api/tourney/players', signal)

export const addPlayer = (body: { display_name: string; zitadel_id?: string; is_custom?: boolean }) =>
  request<Player>('/api/tourney/players', { method: 'POST', body })

export const addTeam = (tid: string, body: { name: string; color?: string }) =>
  request<Team>(`/api/tourney/tournaments/${tid}/teams`, { method: 'POST', body })

export const removeTeam = (tid: string, teamId: string) =>
  request(`/api/tourney/tournaments/${tid}/teams/${teamId}`, { method: 'DELETE' })

export const addRosterPlayer = (teamId: string, playerId: string) =>
  request(`/api/tourney/teams/${teamId}/players/${playerId}`, { method: 'POST', body: {} })

export const removeRosterPlayer = (teamId: string, playerId: string) =>
  request(`/api/tourney/teams/${teamId}/players/${playerId}`, { method: 'DELETE' })

export const generateBracket = (tid: string) =>
  request<Tournament>(`/api/tourney/tournaments/${tid}/bracket`, { method: 'POST', body: {} })

export const recordResult = (matchId: string, score1: number, score2: number) =>
  request<Tournament>(`/api/tourney/matches/${matchId}`, { method: 'PATCH', body: { score1, score2 } })

export const getStandings = (tid: string, signal?: AbortSignal) =>
  getJSON(`/api/tourney/tournaments/${tid}/standings`, signal)
