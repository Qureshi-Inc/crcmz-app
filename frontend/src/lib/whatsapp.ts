// WhatsApp analytics routes (PS-4). Every read is public and takes the same range
// params; only export and import need a session. The server is unchanged.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getJSON } from './http'

export type RangeId = 'all_time' | 'this_year' | 'this_month' | 'prev_month' | 'custom'
export type Range = { id: RangeId; start: string; end: string }
export const RANGES: { id: RangeId; label: string }[] = [
  { id: 'all_time', label: 'All time' }, { id: 'this_year', label: 'This year' }, { id: 'this_month', label: 'This month' },
  { id: 'prev_month', label: 'Last month' }, { id: 'custom', label: 'Custom' },
]
export const rangeLabel = (r: Range) =>
  r.id === 'custom' ? (r.start && r.end ? `${r.start} – ${r.end}` : 'Custom') : (RANGES.find((x) => x.id === r.id)?.label ?? 'All time')

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** The range in the URL (?range=&start=&end=). A custom range needs both dates, start first. */
export function parseRange(sp: URLSearchParams): Range {
  const id = sp.get('range') as RangeId | null
  if (id === 'custom') {
    const start = sp.get('start') ?? ''
    const end = sp.get('end') ?? ''
    if (DATE.test(start) && DATE.test(end) && start <= end) return { id, start, end }
    return { id: 'all_time', start: '', end: '' }
  }
  return { id: RANGES.some((r) => r.id === id) ? id! : 'all_time', start: '', end: '' }
}
export function rangeQuery(r: Range): string {
  const p = new URLSearchParams({ range: r.id })
  if (r.id === 'custom') { p.set('start', r.start); p.set('end', r.end) }
  return p.toString()
}

export type Named = { name: string; count: number }
export type WaStats = {
  total_messages: number; total_members: number; total_videos: number; total_photos: number; total_media: number
  conversation_days: number; first_ts: number | null; last_ts: number | null; member_message_counts: { sender_name: string; cnt: number }[]
}
export type WaAwards = Partial<{
  certified_yapper: Named | null; night_owl: Named | null; early_bird: Named | null; video_king: Named | null; photo_king: Named | null
  most_reacted_person: Named | null; most_skull: Named | null; most_laugh: Named | null; most_fire: Named | null; ghost_of_month: Named | null
  most_reacted_message: { sender_name: string; text: string; timestamp: number; cnt: number } | null
  most_used_emoji: { emoji: string; count: number } | null; peak_hour: { hour: number; count: number } | null
  biggest_day: { date: string; count: number } | null; longest_streak_days: number | null
  fastest_replier: { name: string; avg_minutes: number } | null
}>
export type WaActivity = {
  by_hour: { hour: number; count: number }[]; by_dow: { dow: number; label: string; count: number }[]
  daily: { date: string; count: number }[]; monthly: { month: string; count: number }[]
  top_days: { date: string; count: number }[]; member_monthly: Record<string, Record<string, number>>
}
export type WaHeatmap = { cells: { dow: number; hour: number; count: number }[]; max_count: number }
export type WaWords = { top_words: { word: string; count: number }[]; member_top_words: Record<string, { word: string; count: number }[]> }
export type WaEmojis = { top_emoji: { emoji: string; count: number; pct: number }[]; total_emoji: number; member_top_emoji: Record<string, { emoji: string; count: number }[]> }
export type WaResponse = {
  member_avg_minutes: { name: string; avg_minutes: number; count: number }[]; distribution: { label: string; count: number }[]
  fastest_responder: string | null; event_count: number
}
export type WaMember = {
  name: string; messages: number; photos: number; videos: number; audios: number; media_omitted: number
  total_words: number; total_chars: number; avg_words_per_msg: number; first_ts: number | null; last_ts: number | null
}
export type WaImport = { status?: string; message_count?: number; duplicate_count?: number; total_parsed?: number }

type Kinds = {
  stats: WaStats; awards: WaAwards; activity: WaActivity; heatmap: WaHeatmap; words: WaWords
  emojis: WaEmojis; 'response-times': WaResponse; members: { members: WaMember[] }
}
/**
 * One query per endpoint, keyed by the range. The key is the generation guard: a
 * late answer for an old range lands under its own key and is never shown, and the
 * previous range's numbers stay up (dimmed) until the new ones arrive.
 */
export function useWa<K extends keyof Kinds>(kind: K, r: Range) {
  const qs = rangeQuery(r)
  return useQuery({
    queryKey: ['wa', kind, qs],
    queryFn: ({ signal }) => getJSON<Kinds[K]>(`/api/whatsapp/${kind}?${qs}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  })
}
export function useCanImport(signedIn: boolean) {
  return useQuery({
    queryKey: ['wa', 'can-import', signedIn],
    queryFn: ({ signal }) => getJSON<{ can_import: boolean }>('/api/whatsapp/can-import', signal),
    staleTime: 5 * 60_000,
  })
}

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024
export const EXPORT_HINT = 'Re-export without media: WhatsApp → the chat → ⋮ → More → Export chat → Without media. The analytics only read the chat text.'
