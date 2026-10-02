// The Ring button (Huddle and Watch Party): calls everyone else's phone. Android
// app phones ring full-screen; everyone else gets a high-priority push.
//   POST /api/ring {kind, room?} → {phones_rang, pushed}; 429 for a minute after you ring
import { toast } from '../components/toast'
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
