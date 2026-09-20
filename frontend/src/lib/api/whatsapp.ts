import { api } from './http'

/**
 * WhatsApp analytics.
 *
 * All nine read endpoints take the same (range, start, end) triple, so the range lives
 * in one type and one query-string builder. The valid range values come from
 * `_ts_bounds` in whatsapp_analytics.py — an unknown value falls through to "all time"
 * there, which is why the UI only ever sends one of these.
 *
 * These are aggregates over ~10k rows; "all time" is measurably slower than a month. The
 * query keys include the range so a superseded response can never land in the current
 * view, and CACHE.analytics keeps them out of refetch-on-focus.
 */

export const RANGES = [
  { value: 'all_time', label: 'All time' },
  { value: 'this_year', label: 'This year' },
  { value: 'this_month', label: 'This month' },
  { value: 'prev_month', label: 'Last month' },
  { value: 'today', label: 'Today' },
  { value: 'custom', label: 'Custom…' },
] as const

export type RangeValue = (typeof RANGES)[number]['value']

export interface Range {
  range: RangeValue
  /** 'YYYY-MM-DD'. Only used when range is 'custom'. */
  start?: string
  end?: string
}

export function rangeQuery(r: Range): string {
  const qs = new URLSearchParams({ range: r.range })
  if (r.range === 'custom') {
    if (r.start) qs.set('start', r.start)
    if (r.end) qs.set('end', r.end)
  }
  return `?${qs.toString()}`
}

/** A custom range is only sendable once both ends exist and are the right way round. */
export function customRangeError(start: string, end: string): string | null {
  if (!start || !end) return 'Pick both a start and an end date.'
  if (Date.parse(start) > Date.parse(end)) return 'The start date is after the end date.'
  return null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export interface WaStats {
  totalMessages: number
  totalMembers: number
  totalVideos: number
  totalPhotos: number
  totalMedia: number
  conversationDays: number
  firstTs: number | null
  lastTs: number | null
  memberMessageCounts: { name: string; messages: number }[]
}

export function getStats(r: Range, signal?: AbortSignal) {
  return api.get<WaStats>(`/api/whatsapp/stats${rangeQuery(r)}`, {
    signal,
    // Aggregating a decade of messages is not instant.
    timeoutMs: 45_000,
    parse: (raw): WaStats => {
      const s = (raw ?? {}) as Record<string, unknown>
      const counts = s.member_message_counts
      return {
        totalMessages: num(s.total_messages),
        totalMembers: num(s.total_members),
        totalVideos: num(s.total_videos),
        totalPhotos: num(s.total_photos),
        totalMedia: num(s.total_media),
        conversationDays: num(s.conversation_days),
        firstTs: typeof s.first_ts === 'number' ? s.first_ts : null,
        lastTs: typeof s.last_ts === 'number' ? s.last_ts : null,
        memberMessageCounts: Array.isArray(counts)
          ? counts.flatMap(c => {
              const row = (c ?? {}) as Record<string, unknown>
              const name = str(row.name) ?? str(row.sender_name)
              return name ? [{ name, messages: num(row.messages) ?? num(row.n) }] : []
            })
          : [],
      }
    },
  })
}

export interface MemberRow {
  name: string
  messages: number
  totalWords: number
  avgWordsPerMsg: number
}

export function getMembers(r: Range, signal?: AbortSignal) {
  return api.get<MemberRow[]>(`/api/whatsapp/members${rangeQuery(r)}`, {
    signal,
    timeoutMs: 45_000,
    parse: (raw): MemberRow[] => {
      const root = (raw ?? {}) as Record<string, unknown>
      // The endpoint has been seen keyed both ways depending on the helper; accept either
      // rather than render an empty table because of a wrapper name.
      const list = Array.isArray(root.members)
        ? root.members
        : Array.isArray(root.rows)
          ? root.rows
          : []
      return list.flatMap(item => {
        const m = (item ?? {}) as Record<string, unknown>
        const name = str(m.name) ?? str(m.sender_name)
        if (!name) return []
        return [{
          name,
          messages: num(m.messages),
          totalWords: num(m.total_words),
          avgWordsPerMsg: num(m.avg_words_per_msg),
        }]
      })
    },
  })
}

export interface Award {
  key: string
  title: string
  /** Who won it, or the emoji/hour/date for the awards that are not about a person. */
  winner: string
  detail: string | null
}

/**
 * Awards are a dict keyed by award name, each value `{name, count}` (or `{emoji,...}`,
 * `{hour,...}`, `{date,...}`, or a bare number for longest_streak_days) and `null` when
 * there is no winner in the range. Flattened into a list here, with the human titles,
 * because the keys are an internal vocabulary.
 */
const AWARD_TITLES: Record<string, string> = {
  certified_yapper: 'Certified yapper',
  night_owl: 'Night owl',
  early_bird: 'Early bird',
  video_king: 'Video king',
  photo_king: 'Photo king',
  most_reacted_person: 'Most reacted to',
  most_used_emoji: 'Most used emoji',
  most_skull: 'Most 💀',
  most_laugh: 'Most 😂',
  most_fire: 'Most 🔥',
  peak_hour: 'Busiest hour',
  biggest_day: 'Busiest day',
  longest_streak_days: 'Longest daily streak',
  fastest_replier: 'Fastest replier',
  ghost_of_month: 'Ghost of the month',
}

export function getAwards(r: Range, signal?: AbortSignal) {
  return api.get<Award[]>(`/api/whatsapp/awards${rangeQuery(r)}`, {
    signal,
    timeoutMs: 45_000,
    parse: (raw): Award[] => {
      const root = (raw ?? {}) as Record<string, unknown>
      const out: Award[] = []
      for (const [key, title] of Object.entries(AWARD_TITLES)) {
        const v = root[key]
        if (v === null || v === undefined) continue
        // longest_streak_days is a bare count, not an object.
        if (typeof v === 'number') {
          out.push({ key, title, winner: `${v} day${v === 1 ? '' : 's'}`, detail: null })
          continue
        }
        if (typeof v !== 'object') continue
        const a = v as Record<string, unknown>
        const winner =
          str(a.name) ??
          str(a.emoji) ??
          str(a.date) ??
          (typeof a.hour === 'number' ? `${String(a.hour).padStart(2, '0')}:00` : null)
        if (!winner) continue
        const count = typeof a.count === 'number' ? a.count : null
        const avg = typeof a.avg_minutes === 'number' ? a.avg_minutes : null
        out.push({
          key,
          title,
          winner,
          detail:
            avg !== null
              ? `${avg} min average`
              : count !== null
                ? `${count}`
                : null,
        })
      }
      return out
    },
  })
}

export interface EmojiRow {
  emoji: string
  count: number
}

export function getEmojis(r: Range, signal?: AbortSignal) {
  return api.get<EmojiRow[]>(`/api/whatsapp/emojis${rangeQuery(r)}`, {
    signal,
    timeoutMs: 45_000,
    parse: (raw): EmojiRow[] => {
      const root = (raw ?? {}) as Record<string, unknown>
      const list = Array.isArray(root.top_emoji) ? root.top_emoji : []
      return list.flatMap(item => {
        const e = (item ?? {}) as Record<string, unknown>
        const emoji = str(e.emoji)
        return emoji ? [{ emoji, count: num(e.count) }] : []
      })
    },
  })
}

export interface CanImport {
  canImport: boolean
  reason: string | null
}

export function getCanImport(signal?: AbortSignal) {
  return api.get<CanImport>('/api/whatsapp/can-import', {
    signal,
    parse: (raw): CanImport => {
      const r = (raw ?? {}) as Record<string, unknown>
      return { canImport: r.can_import === true, reason: str(r.reason) }
    },
  })
}

/** Where the export download lives. A plain link, not a fetch — the browser saves it. */
export const exportUrl = (r: Range) => `/api/whatsapp/export${rangeQuery(r)}`

/* Ceilings, smallest first. This app caps at 50 MB and Cloudflare rejects anything over
 * 100 MB at the edge — before the request reaches the app, with an HTML error page. A
 * "with media" export blows past both, so the size is checked here and the error names
 * the real cause instead of showing a parse failure. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

export function importSizeError(bytes: number): string | null {
  if (bytes > 100 * 1024 * 1024) {
    return 'That file is over 100 MB, so Cloudflare will reject it before it reaches the app. Export the chat "without media".'
  }
  if (bytes > MAX_IMPORT_BYTES) {
    return 'That file is over 50 MB. Export the chat "without media" and try again.'
  }
  return null
}

export function importChat(file: File, signal?: AbortSignal) {
  const form = new FormData()
  form.append('file', file)
  return api.post<{ status: string; messageCount: number; duplicateCount: number }>(
    '/api/whatsapp/import',
    undefined,
    {
      form,
      signal,
      // Parsing a year of chat history takes a while.
      timeoutMs: 180_000,
      parse: (raw): { status: string; messageCount: number; duplicateCount: number } => {
        const r = (raw ?? {}) as Record<string, unknown>
        return {
          status: str(r.status) ?? 'imported',
          messageCount: num(r.message_count),
          duplicateCount: num(r.duplicate_count),
        }
      },
    },
  )
}
