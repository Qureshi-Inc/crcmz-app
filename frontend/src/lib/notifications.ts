// The notification centre: one inbox for every alert the app raises (rallies,
// Watch Parties, Huddles, giveaways, clips, Slap @mentions, movies). The server routes each
// alert to this inbox, to push, and for personal ones to WhatsApp and Mattermost.
import { useEffect } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from './http'

export type Notice = {
  id: number
  /** ms since epoch */
  at: number
  category: string
  source: 'squad' | 'watch' | 'huddle' | 'giveaway' | 'clips' | 'slap' | string
  title: string
  body: string
  url: string
  /** Meant for you alone (an @mention), not a broadcast. */
  personal: boolean
  read: boolean
}
export type Inbox = { items: Notice[]; more: boolean; unread: number }
export type Channels = {
  channels: { id: 'whatsapp' | 'mattermost'; label: string }[]
  prefs: Record<string, boolean>
  reachable: Record<string, boolean>
}

export const UNREAD_MS = 60_000
const KEY = ['notifications'] as const

/** The bell's count. Polled once a minute, on focus, and the moment a push lands. */
export function useUnread(enabled = true) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: [...KEY, 'unread'],
    queryFn: ({ signal }) => request<{ unread: number }>('/api/notifications/unread', { signal, quiet401: true }),
    refetchInterval: UNREAD_MS,
    refetchOnWindowFocus: true,
    retry: false,
    enabled,
  })
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const fn = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'crcmz:push') void qc.invalidateQueries({ queryKey: KEY })
    }
    navigator.serviceWorker.addEventListener('message', fn)
    return () => navigator.serviceWorker.removeEventListener('message', fn)
  }, [qc])
  const n = q.data?.unread ?? 0
  // The installed app's icon carries the count too, where the OS supports it.
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
    if (!q.isSuccess) return
    if (n > 0) nav.setAppBadge?.(n).catch(() => {})
    else nav.clearAppBadge?.().catch(() => {})
  }, [n, q.isSuccess])
  return n
}

export function useInbox(source: string) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'inbox', source],
    queryFn: ({ signal, pageParam }) => {
      const qs = new URLSearchParams()
      if (pageParam) qs.set('before', String(pageParam))
      if (source) qs.set('source', source)
      return request<Inbox>(`/api/notifications${qs.size ? `?${qs}` : ''}`, { signal })
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.more && last.items.length ? last.items[last.items.length - 1]!.id : undefined),
    refetchInterval: UNREAD_MS,
  })
}

export const markRead = (ids: number[] | 'all') =>
  request<{ unread: number }>('/api/notifications/read', { body: ids === 'all' ? { all: true } : { ids } })

export function useChannels(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'channels'],
    queryFn: ({ signal }) => request<Channels>('/api/notifications/channels', { signal }),
    enabled,
  })
}

export const saveChannels = (changes: Record<string, boolean>) =>
  request<{ prefs: Record<string, boolean> }>('/api/notifications/channels', { body: changes })

/** DM yourself on each switched-on channel: true sent, false failed, null off or not linked. */
export const testDm = () =>
  request<Record<'whatsapp' | 'mattermost', boolean | null>>('/api/notifications/test-dm', { body: {} })

/** "2m", "3h", "Mon", "12 Sep": short enough for a row. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = new Date(at)
  if (s < 6 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
