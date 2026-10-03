// The Ring button (Huddle and Watch Party): calls everyone else's phone, or one person
// from the ring list (RingSheet). Phone apps ring full-screen; everyone else gets a
// high-priority push.
//   GET  /api/ring/people → [{id, name, reachable}]
//   POST /api/ring {kind, room?, to?: [id]} → {phones_rang, pushed}; 429 for a minute
//        after you ring everyone, 30 s after you ring one person
import { toast } from '../components/toast'
import { useQuery } from '@tanstack/react-query'
import { ApiError, request } from './http'

export async function ringSquad(kind: 'huddle' | 'watch', room = ''): Promise<void> {
  try {
    const r = await request<{ phones_rang: number; pushed: number }>('/api/ring', { body: { kind, room } })
    const n = r.phones_rang + r.pushed
    toast(n ? `Ringing everyone (${n} ${n === 1 ? 'device' : 'devices'})` : 'Nobody has notifications on for this yet', n ? 'success' : 'warning')
  } catch (e) {
    toast(e instanceof ApiError && e.status === 429 ? e.detail || 'You just rang. Give it a minute.' : "Couldn't ring everyone", 'error')
  }
}

export type RingPerson = { id: string; name: string; reachable: boolean }

export function useRingPeople(enabled: boolean) {
  return useQuery({
    queryKey: ['ring', 'people'],
    queryFn: ({ signal }) => request<RingPerson[]>('/api/ring/people', { signal }),
    enabled,
    staleTime: 60_000,
  })
}

/** Ring one person (from the ring list). True when it went out. */
export async function ringOne(kind: 'huddle' | 'watch', person: RingPerson, room = ''): Promise<boolean> {
  try {
    const r = await request<{ phones_rang: number; pushed: number }>('/api/ring', { body: { kind, room, to: [person.id] } })
    const n = r.phones_rang + r.pushed
    toast(n ? `Ringing ${person.name}` : `${person.name} has no notifications on for this`, n ? 'success' : 'warning')
    return n > 0
  } catch (e) {
    toast(e instanceof ApiError && e.status === 429 ? `You just rang ${person.name}. Give it a moment.` : `Couldn't ring ${person.name}`, 'error')
    return false
  }
}
