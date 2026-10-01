// AI Coach routes (PS-8). One read per scope; the two writes are your own notify
// prefs and your feedback on a report. The server is unchanged.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getJSON, request } from './http'

export type Scope = 'me' | 'squad'
export type NotifyMode = 'group' | 'dm' | 'off'
export type DetailMode = 'full' | 'link'
export type Rating = 'up' | 'down'
export type Moment = string | { t?: string; time?: string; ts?: string; note?: string; text?: string; description?: string }
export type Feedback = { rating: Rating | ''; tags: string[]; comment: string }
export type Review = {
  review_id?: string; clip_id?: string; psn_user?: string; is_mine?: boolean; game?: string; created_at?: number; status?: string
  summary?: string; overall_assessment?: string; grade?: string; strengths?: string[]; mistakes?: string[]; coaching_tips?: string[]
  notable_moments?: Moment[]; tags?: string[]; voice_comms?: string; my_feedback?: Partial<Feedback> | null
}
export type Row = { label: string; count: number }
export type Coaching = {
  scope: Scope; notify_mode: NotifyMode; detail_mode: DetailMode
  counts: { mine: number; squad: number; complete: number; processing: number }
  processing: { clip_id: string; psn_user: string; status: string; created_at: number; reason: string }[]
  reviews: Review[]
  sightings?: { player: string; observation: string; game: string; created_at: number }[]
  charts: { tags: Row[]; mistakes: (Row & { reviews?: string[] })[]; per_day: Row[]; grades: Row[] }
}

/** 60 s while a review is still processing, so a new report shows when it lands. */
export const POLL_MS = 60_000

export function useCoaching(scope: Scope) {
  return useQuery({
    queryKey: ['coach', scope],
    queryFn: ({ signal }) => getJSON<Coaching>(`/api/coaching?scope=${scope}&limit=50`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => ((q.state.data?.counts?.processing ?? 0) > 0 ? POLL_MS : false),
  })
}

export const savePrefs = (patch: { mode: NotifyMode } | { detail: DetailMode }) =>
  request<{ ok: boolean; notify_mode: NotifyMode; detail_mode: DetailMode }>('/api/coaching/prefs', { body: patch })

export const sendFeedback = (review_id: string, f: Feedback) =>
  request<{ ok: boolean; feedback_id: string }>('/api/coaching/feedback', {
    body: { review_id, rating: f.rating, tags: f.tags, comment: f.comment.slice(0, 500) },
  })

export const FEEDBACK_TAGS = ['wrong-grade', 'wrong-player', 'missed-moment', 'bad-tip', 'transcript-wrong', 'other']

/** S=5 down to D=1; a modifier nudges a third of a step, so C+ still reads above C. */
export function gradeVal(g: string | undefined): number | null {
  const s = String(g ?? '').toUpperCase().trim()
  const base = ({ S: 5, A: 4, B: 3, C: 2, D: 1 } as Record<string, number>)[s.charAt(0)]
  if (base == null) return null
  return base + (s.includes('+') ? 0.33 : s.includes('-') ? -0.33 : 0)
}
const GRADE_COLOR: Record<string, string> = { S: 'var(--gold-text)', A: 'var(--lime-text)', B: 'var(--cyan-text)', C: 'var(--warning)', D: 'var(--error)' }
export const gradeColor = (g: string | undefined) => GRADE_COLOR[String(g ?? '').toUpperCase().charAt(0)] ?? 'var(--text-dim)'

export function momentText(m: Moment): { t: string; note: string } {
  if (m && typeof m === 'object') return { t: m.t || m.time || m.ts || '', note: m.note || m.text || m.description || '' }
  return { t: '', note: String(m ?? '') }
}

export type Sort = 'new' | 'old' | 'best' | 'worst'
export type Filters = { q: string; game: string; player: string; sort: Sort }
export const NO_FILTERS: Filters = { q: '', game: 'all', player: 'all', sort: 'new' }

function haystack(r: Review) {
  return [r.overall_assessment, r.summary, ...(r.mistakes ?? []), ...(r.coaching_tips ?? []),
    ...(r.notable_moments ?? []).map((m) => { const x = momentText(m); return `${x.t} ${x.note}` }),
    ...(r.tags ?? []), r.game, r.psn_user].join(' ').toLowerCase()
}
/** Search, game/player filters and the grade sort, all client-side. */
export function filterReviews(list: Review[], f: Filters): Review[] {
  const q = f.q.trim().toLowerCase()
  const gv = (r: Review) => gradeVal(r.grade) ?? -1
  const out = list.filter((r) =>
    (f.player === 'all' || (r.psn_user || 'unknown') === f.player)
    && (f.game === 'all' || (r.game || 'unknown') === f.game)
    && (!q || haystack(r).includes(q)))
  const t = (r: Review) => r.created_at ?? 0
  if (f.sort === 'old') out.sort((a, b) => t(a) - t(b))
  else if (f.sort === 'best') out.sort((a, b) => gv(b) - gv(a))
  else if (f.sort === 'worst') out.sort((a, b) => gv(a) - gv(b))
  else out.sort((a, b) => t(b) - t(a))
  return out
}

// Feedback drafts outlive a re-render and a sign-in round trip (signed-out: "draft kept").
const DRAFT_KEY = 'crcmz.coach.fb'
export function loadDrafts(): Record<string, Feedback> {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}') as Record<string, Feedback> } catch { return {} }
}
export function saveDrafts(d: Record<string, Feedback>) {
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)) } catch { /* private mode: drafts live for this page only */ }
}
