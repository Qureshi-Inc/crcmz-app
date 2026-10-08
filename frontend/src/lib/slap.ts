// PS-3 · Slap endpoint contract. The browser only ever talks to /api/slap/*;
// the server holds the Jellyfin key and stamps every social write with the
// caller's own Jellyfin name.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getJSON, request } from './http'

export type Track = {
  id: string
  title: string
  artist: string
  album: string
  album_id: string
  album_artist: string
  genres: string[]
  year: number | null
  duration: number
  added: string
  art: string | null
  fav: boolean
  plays: number
}
export type Playlist = { id: string; name: string; count: number; art: string | null; editable: boolean }
export type Library = { tracks: Track[]; playlists: Playlist[] }
export type PlaylistDetail = { id: string; name: string; editable: boolean; items: { entry: string; id: string }[] }
export type SlapMe = { name: string; jellyfin_user: string; slap_user: string; created: boolean; admin: boolean }

/** A queued track: the fields the Together room carries, plus its queue identity. */
export type QueueItem = Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'album_id' | 'duration' | 'art'> & { qid: string; added_by?: string }
export type Room = {
  queue: QueueItem[]
  index: number
  playing: boolean
  position: number
  at: number
  version: number
  by: string
  last: string
  members: { name: string; since: number }[]
}

// A replaced track keeps its id: a version stops this device replaying the cached old audio.
const streamV = new Map<string, number>()
export const streamUrl = (id: string) => `/api/slap/stream/${id}${streamV.has(id) ? `?v=${streamV.get(id)}` : ''}`
export const bumpStream = (id: string) => { streamV.set(id, Date.now()) }
// Art is cached for a day; bump ART_V when cached copies may be bad (they were once,
// while the library was unreachable), so every device fetches them again.
const ART_V = 2
export const artUrl = (id: string | null | undefined, size: 96 | 300 | 600 = 96) => (id ? `/api/slap/art/${id}?size=${size}&v=${ART_V}` : null)

export function useSlapMe(enabled = true) {
  return useQuery({
    queryKey: ['slap', 'me'],
    queryFn: ({ signal }) => getJSON<SlapMe>('/api/slap/me', signal),
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  })
}

export function useLibrary() {
  return useQuery({
    queryKey: ['slap', 'library'],
    queryFn: ({ signal }) => request<Library>('/api/slap/library', { signal, timeoutMs: 30_000 }),
    staleTime: 60_000,
  })
}

export function usePlaylist(pid: string | null) {
  return useQuery({
    queryKey: ['slap', 'playlist', pid],
    queryFn: ({ signal }) => getJSON<PlaylistDetail>(`/api/slap/playlists/${pid}`, signal),
    enabled: !!pid,
  })
}

export function useRefreshLibrary() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['slap'] })
}

/** A slaptastic read through the proxy. No poll: loaded on open, refreshed by ↻. */
export function useSocial<T>(path: string | null, params?: Record<string, string | number>, opts: { enabled?: boolean } = {}) {
  const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : ''
  return useQuery({
    queryKey: ['slap', 'social', path, qs],
    queryFn: ({ signal }) => request<T>(`/api/slap/social/${path}${qs}`, { signal, timeoutMs: 60_000 }),
    enabled: !!path && (opts.enabled ?? true),
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

// ── Writes ──────────────────────────────────────────────────────────────────
const trackBody = (t: Pick<Track, 'id' | 'title' | 'artist' | 'album'>) => ({ track_id: t.id, title: t.title, artist: t.artist, album: t.album })

export const setFavorite = (id: string, on: boolean) =>
  request<{ fav: boolean }>(`/api/slap/favorites/${id}`, { method: on ? 'POST' : 'DELETE' })

export type Thumbs = { up: string[]; down: string[]; mine: -1 | 0 | 1 }
/** Beside a track in the player: whose picks brought it in, and who thumbed it. */
export type TrackSocial = { picked_by: string[]; thumbs: Thumbs }

export function useTrackSocial(id: string | null | undefined) {
  return useQuery({
    queryKey: ['slap', 'track', id],
    queryFn: ({ signal }) => request<TrackSocial>(`/api/slap/track/${id}`, { signal }),
    enabled: !!id,
    staleTime: 60_000,
    retry: false,
  })
}

export const sendThumb = (t: Pick<Track, 'id' | 'title' | 'artist' | 'album'>, thumbs: -1 | 0 | 1) =>
  request<Thumbs>('/api/slap/thumb', { body: { ...trackBody(t), thumbs } })

/** Slap usernames as the short names Slap shows, each once. */
export const slapNames = (list: string[]) => [...new Set(list.map((u) => slapName(u) || u))]

/** "Moiz", "Moiz and Noor", "Moiz, Noor and 2 more". */
export function names(list: string[], max = 2): string {
  if (list.length <= max) return list.length === 2 ? `${list[0]} and ${list[1]}` : list.join('')
  const rest = list.length - max
  return `${list.slice(0, max).join(', ')} and ${rest} more`
}

export type SlapComment = {
  id: string; username: string; track_id?: string; title: string; artist: string
  text: string; is_reaction: boolean; created_at: string
}
/** Posts a comment or reaction. `mentioned` names whoever the @tags reached. */
export const sendComment = (t: Pick<Track, 'id' | 'title' | 'artist' | 'album'>, text: string, isReaction: boolean) =>
  request<Partial<SlapComment> & { mentioned?: string[] }>('/api/slap/comment', { body: { ...trackBody(t), text, is_reaction: isReaction } })

export type Mentionable = { handle: string; name: string; aka?: string[] }
/** Who an @ can tag: handles and names only, from the identity graph. */
export function useMentionable(enabled = true) {
  return useQuery({
    queryKey: ['slap', 'mentionable'],
    queryFn: ({ signal }) => request<{ people: Mentionable[] }>('/api/slap/mentionable', { signal }),
    staleTime: 10 * 60_000,
    enabled,
  })
}

/** One track's comments and reactions, newest first. */
export function useTrackComments(trackId: string | null) {
  return useSocial<{ comments: SlapComment[] }>(trackId ? 'listening/comments' : null, trackId ? { track_id: trackId, limit: 30 } : undefined)
}

export function reportListen(kind: 'play' | 'skip', t: Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'duration'>, heard: number, completed: boolean) {
  return request(`/api/slap/listen/${kind}`, {
    quiet401: true,
    body: {
      ...trackBody(t), duration_seconds: Math.round(t.duration), listened_seconds: Math.round(heard),
      completed, hour_of_day: new Date().getHours(),
    },
  })
}

export const createPlaylist = (name: string, ids: string[]) => request<{ id: string; name: string }>('/api/slap/playlists', { body: { name, ids } })
export const addToPlaylist = (pid: string, ids: string[]) => request<{ added: number }>(`/api/slap/playlists/${pid}/items`, { body: { ids } })
export const removeFromPlaylist = (pid: string, entries: string[]) => request(`/api/slap/playlists/${pid}/remove`, { body: { entries } })
export const deletePlaylist = (pid: string) => request(`/api/slap/playlists/${pid}`, { method: 'DELETE' })
export const editTrackInfo = (id: string, info: { title?: string; artist?: string; album?: string; genre?: string; year?: number | null }) =>
  request(`/api/slap/tracks/${id}/info`, { body: info })

export type TogetherOp = 'play' | 'pause' | 'seek' | 'next' | 'prev' | 'ended' | 'jump' | 'add' | 'next_up' | 'replace' | 'remove' | 'move' | 'clear'
export const together = (op: TogetherOp, extra: Record<string, unknown> = {}) => request<Room>('/api/slap/together', { body: { op, ...extra } })

// ── Display ─────────────────────────────────────────────────────────────────
/** SL-20: slaptastic usernames → the names the squad uses. Unknown names pass through. */
const SLAP_NAMES: Record<string, string> = {
  moiz: 'moiz', themoosecompany: 'moose', mutasif: 'moose', shahraiz: 'shahraiz', zubair221b: 'zubair',
  nooramin40: 'noor', deception: 'deception', brendan: 'deception', asamad89: 'asamad', samad: 'asamad',
}
/** Everyone else (anyone who joined later): their name from the identity graph, by every
 *  username they go by (Mattermost, Jellyfin, chosen). Loaded once by useSlapNames(). */
let MEMBER_NAMES: Record<string, string> = {}
export const slapName = (u: string | null | undefined) => {
  if (!u) return ''
  const k = u.toLowerCase()
  return SLAP_NAMES[k] ?? MEMBER_NAMES[k] ?? u
}

/** Fetch the member names; the component that calls it re-renders when they arrive. */
export function useSlapNames(enabled = true) {
  const q = useQuery({
    queryKey: ['slap', 'names'],
    queryFn: ({ signal }) => request<Record<string, string>>('/api/slap/names', { signal, quiet401: true }),
    staleTime: 10 * 60_000,
    enabled,
  })
  if (q.data && q.data !== MEMBER_NAMES) MEMBER_NAMES = q.data
  return q.data
}

export function fmtTime(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

// ── Reroll: the wrong song was downloaded; find and swap in the right one ────
export type Source = { url: string; title: string; channel: string; duration_seconds: number | null; view_count: number | null; score: number }
export type Sources = { query: string; track: { title: string; artist: string; duration: number }; candidates: Source[] }
// A YouTube search takes a while: give it the server's full minute and a half.
export const findSources = (id: string, q = '', signal?: AbortSignal) =>
  request<Sources>(`/api/slap/tracks/${id}/sources${q ? `?q=${encodeURIComponent(q)}` : ''}`, { signal, timeoutMs: 100_000 })
export const replaceTrack = (id: string, url: string) => request<{ job: string }>(`/api/slap/tracks/${id}/replace`, { body: { url } })
export type Reroll = { tid: string; state: 'working' | 'done' | 'failed'; error: string; duration: number }
export const rerollStatus = (job: string) => getJSON<Reroll>(`/api/slap/rerolls/${job}`)
/** A pasted YouTube or SoundCloud page link, or null. */
export function sourceLink(text: string): string | null {
  try {
    const u = new URL(text.trim())
    const h = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
    return (u.protocol === 'https:' || u.protocol === 'http:') && ['youtube.com', 'youtu.be', 'soundcloud.com'].includes(h) ? u.href : null
  } catch {
    return null
  }
}

// ── Discover ────────────────────────────────────────────────────────────────
/** A song the library doesn't have yet: Listen plays Apple's 30-second preview,
 *  Download sends it to the importer and files it in the presser's picks. */
export type Find = {
  id: string; title: string; artist: string; album: string; art: string | null; preview: string | null
  duration: number; for: string; status: 'new' | 'queued' | 'review' | 'done' | 'failed'
  by: string | null; track_id: string | null; error: string | null
}
/** `off`: the App Store review account, which gets no New finds. */
export type Discover = { week: string; expires: number; finds: Find[]; why: Record<string, string>; ready: boolean; making: boolean; off?: boolean }

export function useDiscover() {
  return useQuery({
    queryKey: ['slap', 'discover'],
    queryFn: ({ signal }) => request<Discover>('/api/slap/discover', { signal, timeoutMs: 30_000 }),
    staleTime: 30_000,
    // Follow downloads in flight (and a mix still being made) without a reload.
    refetchInterval: (q) => (q.state.data && (q.state.data.making || !q.state.data.ready
      || q.state.data.finds.some((f) => f.status === 'queued')) ? 12_000 : false),
  })
}

export const downloadFind = (id: string) => request<Find>('/api/slap/discover/download', { body: { id }, timeoutMs: 45_000 })
export const approveFind = (id: string) => request<Find>('/api/slap/discover/approve', { body: { id } })

/** Share a song link. Uses native share sheet on mobile, clipboard fallback on desktop. */
export function shareSong(t: { id: string; title: string; artist: string }) {
  const url = `${window.location.origin}/share/song/${encodeURIComponent(t.id)}`
  if (navigator.share) {
    void navigator.share({ title: `${t.title} · ${t.artist}`, url })
  } else {
    void navigator.clipboard.writeText(url)
  }
}
