// Watch · Library: movies in Jellyfin, finding new ones, and adding them through
// Real-Debrid. The server picks the copy (4K first, else 1080p, whatever fits on its
// disk), copies it onto its own disk and streams it as Jellyfin's 1080p transcode, so a
// party can play anything in the library.
import { request } from './http'

export type MovieState = 'new' | 'finding' | 'downloading' | 'copying' | 'adding' | 'ready' | 'failed'
export type Movie = { id: string; imdb: string; title: string; year: string; quality: string; overview: string; poster: string; added: string; by: string; can_remove: boolean }
export type Adding = { imdb: string; title: string; year: string; poster: string; status: MovieState; progress: number; quality: string; size_gb: number; by: string; error: string; id: string | null; at: number }
export type Result = { imdb: string; title: string; year: string; poster: string; overview: string; state: MovieState; id: string | null; quality: string; progress: number; error: string }
export type Library = { movies: Movie[]; adding: Adding[]; can_add: boolean }

export const getLibrary = (signal?: AbortSignal) => request<Library>('/api/watch/movies/library', { signal })
export const searchMovies = (q: string, signal?: AbortSignal) =>
  request<{ results: Result[] }>(`/api/watch/movies/search?q=${encodeURIComponent(q)}`, { signal, timeoutMs: 20_000 })
export const popularMovies = (signal?: AbortSignal) => request<{ results: Result[] }>('/api/watch/movies/popular', { signal, timeoutMs: 20_000 })
export const addMovie = (imdb: string) => request<Adding>('/api/watch/movies/add', { body: { imdb }, timeoutMs: 30_000 })
export const removeMovie = (id: string) => request<{ title: string; removed: number }>('/api/watch/movies/remove', { body: { id }, timeoutMs: 30_000 })
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
