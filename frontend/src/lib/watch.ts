// Watch Party routes (PS-6). The server is unchanged: these are the same calls the
// classic /watch page makes. The realtime part is the WatchParty socket, driven
// from features/watch/session.ts.
import { request } from './http'

export type WatchViewer = { id: string; name: string; nickname: string; psnOnlineId: string; mod: boolean }
export type WatchConfig = {
  authMode: string; origin: string; socketPath: string; rooms: string[]; defaultRoom: string; ticketTtl: number
  viewer: WatchViewer
}
export type Ticket = { ticket: string; expiresIn: number; room: string; viewer: { name: string; mod: boolean } }
export type HistViewer = { name: string; position: number; finished: boolean; updated_at: number }
export type HistItem = {
  url: string; source_url: string | null; kind: string | null; title: string; year: string | number | null
  description: string | null; overview: string | null; poster: string | null; meta_url: string | null
  named_by: 'viewer' | 'source' | null; chat_count: number; last_watched_at: number
  position: number; duration: number | null; finished: boolean
  viewers: HistViewer[]; mine: { position: number; finished: boolean; updated_at: number } | null
}
export type HistChat = { ts: number; name: string; msg: string; video_ts: number | null }

export const getConfig = (signal?: AbortSignal) => request<WatchConfig>('/api/watch/config', { signal })
export const joinRoom = (roomId: string) => request<Ticket>('/api/watch/join', { body: { roomId } })
export const extract = (url: string) => request<{ url: string; title?: string; kind?: string }>('/api/watch/extract', { body: { url }, timeoutMs: 60_000 })
export const setNickname = (nickname: string) => request<{ nickname: string; name: string }>('/api/watch/nickname', { body: { nickname } })
export const rally = (message: string) => request<{ status: string }>('/api/watch/rally', { body: { message } })
export const listHistory = (q: { room: string } | { mine: true }, signal?: AbortSignal) =>
  request<{ items: HistItem[] }>(`/api/watch/history?limit=24&${'mine' in q ? 'mine=1' : `room=${encodeURIComponent(q.room)}`}`, { signal })
export const historyChat = (url: string, room: string, signal?: AbortSignal) =>
  request<{ messages: HistChat[] }>(`/api/watch/history/chat?url=${encodeURIComponent(url)}&room=${encodeURIComponent(room)}`, { signal })
export const renameVideo = (url: string, title: string) => request<{ ok: boolean }>('/api/watch/history/title', { body: { url, title } })
export const forgetVideo = (url: string) => request<{ ok: boolean; removed: number }>('/api/watch/history', { method: 'DELETE', body: { url } })

/** Progress pings and diagnostics must survive the tab closing, so they use keepalive fetch, not request(). */
export function beacon(url: string, body: unknown): Promise<Response | null> {
  return fetch(url, {
    method: 'POST', keepalive: true, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => null)
}

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/
export const ytId = (url: string) => YT_RE.exec(url)?.[1] ?? null
export const isDirect = (url: string) => /\.(mp4|webm|ogg|mov|mkv|m3u8|mpd)(\?|#|$)/i.test(url)
export const isProxy = (url: string) => /^\/api\/watch\/proxy\?/.test(url)

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`
}
export function ago(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - (ts || 0))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}
export function initials(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
function hash(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h
}
export function tint(seed: string): string {
  const a = hash(String(seed || '')) % 360
  return `linear-gradient(145deg, hsl(${a} 60% 27%), hsl(${(a + 58) % 360} 55% 15%))`
}
export const hue = (seed: string) => hash(String(seed || '')) % 360

const scripts = new Map<string, Promise<void>>()
export function loadScript(src: string): Promise<void> {
  let p = scripts.get(src)
  if (!p) {
    p = new Promise<void>((res, rej) => {
      const s = document.createElement('script')
      s.src = src
      s.async = true
      s.onload = () => res()
      s.onerror = () => { scripts.delete(src); s.remove(); rej(new Error(`failed to load ${src}`)) }
      document.head.appendChild(s)
    })
    scripts.set(src, p)
  }
  return p
}

export const REACTIONS = ['😂', '🔥', '😍', '😮', '😭', '💀', '👏', '❤️', '🍿', '👀'] as const

/** iOS ignores element volume (it always reads back 1), so offer mute only there. */
export const CAN_VOL = (() => {
  try { const a = document.createElement('audio'); a.volume = 0.5; return a.volume === 0.5 } catch { return false }
})()
