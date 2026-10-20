// The Listen Together room's chat. Fed by the room's event stream (player.ts), read
// by the floating chat button. Members only, in memory on the server, gone when the
// room empties — so nothing here is persisted either.
import { useSyncExternalStore } from 'react'
import { getJSON, request } from '../../lib/http'

export type ChatLine = { seq: number; name: string; text: string; at: number; mine: boolean }
type ChatState = { lines: ChatLine[]; seq: number; unread: number; open: boolean }

const KEEP = 200
let chat: ChatState = { lines: [], seq: 0, unread: 0, open: false }
const listeners = new Set<() => void>()

function set(p: Partial<ChatState>) {
  chat = { ...chat, ...p }
  listeners.forEach((l) => l())
}

export function useRoomChat(): ChatState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => chat)
}

/** Everything said so far: on (re)joining, and after a gap. Unread is not re-counted. */
export function chatAll(v: { seq: number; messages: ChatLine[] }) {
  set({ lines: v.messages.slice(-KEEP), seq: v.seq })
}

let resyncing = false
export function chatLine(m: ChatLine) {
  if (m.seq <= chat.seq) return
  if (chat.seq && m.seq !== chat.seq + 1 && !resyncing) {
    // A line went missing (a slow connection drops the oldest): fetch the lot.
    resyncing = true
    void getJSON<{ seq: number; messages: ChatLine[] }>('/api/slap/together/chat')
      .then(chatAll).catch(() => {}).finally(() => { resyncing = false })
  }
  set({
    lines: [...chat.lines, m].slice(-KEEP),
    seq: m.seq,
    unread: chat.open || m.mine ? chat.unread : chat.unread + 1,
  })
}

export function resetChat() { set({ lines: [], seq: 0, unread: 0, open: false }) }
export function setChatOpen(open: boolean) { set(open ? { open, unread: 0 } : { open }) }

export async function say(text: string): Promise<void> {
  const m = await request<ChatLine>('/api/slap/together/chat', { body: { text } })
  chatLine(m)
}
