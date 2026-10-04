// Watch · Library: movies in Jellyfin, finding new ones, and adding them through
// Real-Debrid. The server picks the copy (4K first, else 1080p, whatever fits on its
// disk), copies it onto its own disk and streams it as Jellyfin's 1080p transcode, so a
// party can play anything in the library.
import { request } from './http'

export type MovieState = 'new' | 'finding' | 'downloading' | 'copying' | 'adding' | 'ready' | 'failed'
export type Movie = { id: string; imdb: string; title: string; year: string; quality: string; overview: string; poster: string; added: string; by: string; can_remove: boolean }
export type Adding = { imdb: string; title: string; year: string; poster: string; status: MovieState; progress: number; quality: string; size_gb: number; by: string; error: string; id: string | null; at: number }
export type Result = { imdb: string; title: string; year: string; poster: string; background?: string; rating?: string; genres?: string[]; overview: string; state: MovieState; id: string | null; quality: string; progress: number; error: string }
export type Library = { movies: Movie[]; adding: Adding[]; can_add: boolean }

export type ListKind = 'popular' | 'new' | 'top'
export type Row = { id: string; title: string; kind: ListKind; genre: string; items: Result[] }
export type Home = { featured: Result | null; rows: Row[]; genres: string[] }
export type Details = Result & {
  logo: string; runtime: number; director: string[]; cast: string[]; writer: string[]; awards: string; country: string
  trailers: string[]; can_add: boolean; by: string; can_remove: boolean; can_dismiss?: boolean; library_quality: string; adding: Adding | null
  /** The Real-Debrid release it was added from ('' when the app didn't add it). */
  release?: string
}
export type NowPlaying = { room: string; watching: number; video: string; title: string; poster: string; id: string | null; paused: boolean }

export const getHome = (genre: string, signal?: AbortSignal) =>
  request<Home>(`/api/watch/movies/home${genre ? `?genre=${encodeURIComponent(genre)}` : ''}`, { signal, timeoutMs: 25_000 })
export const getCatalog = (kind: ListKind, genre: string, skip: number, signal?: AbortSignal) =>
  request<{ results: Result[]; next: number }>(`/api/watch/movies/catalog?kind=${kind}&genre=${encodeURIComponent(genre)}&skip=${skip}`, { signal, timeoutMs: 25_000 })
export const getDetails = (imdb: string, signal?: AbortSignal) => request<Details>(`/api/watch/movies/meta/${encodeURIComponent(imdb)}`, { signal, timeoutMs: 25_000 })
export const getNow = (signal?: AbortSignal) => request<NowPlaying>('/api/watch/movies/now', { signal })
export const isMovieStream = (url: string) => /^\/api\/watch\/movies\/stream\/[0-9a-f]{32}\//.test(url)

export const getLibrary = (signal?: AbortSignal) => request<Library>('/api/watch/movies/library', { signal })
export const searchMovies = (q: string, signal?: AbortSignal) =>
  request<{ results: Result[] }>(`/api/watch/movies/search?q=${encodeURIComponent(q)}`, { signal, timeoutMs: 20_000 })
export const popularMovies = (signal?: AbortSignal) => request<{ results: Result[] }>('/api/watch/movies/popular', { signal, timeoutMs: 20_000 })
/** `quality`: the adder's pick when both copies exist; left out, the best copy. */
export const addMovie = (imdb: string, quality?: '4k' | '1080p') =>
  request<Adding>('/api/watch/movies/add', { body: quality ? { imdb, quality } : { imdb }, timeoutMs: 30_000 })
/** The copies Real-Debrid can get, best first: the first is the one Add picks. */
export type Copy = { id: string; release: string; size_gb: number; label: string; seeders: number }
export const getCopies = (imdb: string, signal?: AbortSignal) =>
  request<{ imdb: string; copies: Copy[] }>(`/api/watch/movies/copies/${imdb}`, { signal, timeoutMs: 30_000 })
/** Add one copy by name rather than the best one. */
export const addCopy = (imdb: string, copy: string) => request<Adding>('/api/watch/movies/add', { body: { imdb, copy }, timeoutMs: 30_000 })
/** Swap a film's copy for another: the old one is removed, this one added. */
export const replaceCopy = (imdb: string, copy: string) => request<Adding>('/api/watch/movies/replace', { body: { imdb, copy }, timeoutMs: 60_000 })
export type CopyOption = { size_gb: number; hdr: boolean; label: string }
export type Options = { imdb: string; '4k': CopyOption | null; '1080p': CopyOption | null }
export const getOptions = (imdb: string, signal?: AbortSignal) =>
  request<Options>(`/api/watch/movies/options/${imdb}`, { signal, timeoutMs: 30_000 })
export const removeMovie = (id: string) => request<{ title: string; removed: number }>('/api/watch/movies/remove', { body: { id }, timeoutMs: 30_000 })
/** Clear a failed add from On the way. */
export const dismissMovie = (imdb: string) => request<{ ok: boolean }>('/api/watch/movies/dismiss', { body: { imdb } })
export const streamUrl = (id: string) => `/api/watch/movies/stream/${id}/master.m3u8`

/** In flight: still worth polling for. */
export const inFlight = (s: MovieState) => s === 'finding' || s === 'downloading' || s === 'copying' || s === 'adding'

/** A step with a real percentage behind it (the bar fills rather than pulses). */
export const measured = (s: MovieState) => s === 'downloading' || s === 'copying'

export function stateText(s: MovieState, progress = 0): string {
  switch (s) {
    case 'finding': return 'Finding a copy…'
    case 'downloading': return progress > 0 ? `Fetching a copy · ${Math.floor(progress)}%` : 'Fetching a copy…'
    case 'copying': return `Downloading to the server… ${Math.floor(progress)}%`
    case 'adding': return 'Adding to library…'
    case 'ready': return 'In the library'
    case 'failed': return "Couldn't add it"
    default: return ''
  }
}
