// Ask AI routes (PS-9). The answer never comes back on the ask: the server queues
// it and writes it into your thread. /api/assistant/stream follows it live as it is
// written; history polling is the fallback when that stream is gone.
import { useQuery } from '@tanstack/react-query'
import { getJSON, request } from './http'

export type Tools = { available: boolean; model: string; tools: { name: string; description: string }[] }
export type Msg = {
  id: number; role: 'user' | 'assistant'; content: string; status: 'done' | 'pending' | 'error'
  tools: string[]; elapsed_ms: number | null; created_at: number
}
export type History = { messages: Msg[]; pending: boolean; count: number }
export type Fact = { id: string; subject: string; text: string; author: string; created_at: number; mine: boolean }
export type Facts = { facts: Fact[]; total: number; mine: number; max_per_user: number; max_chars: number; subjects: string[] }

export const MAX_Q = 1000
export const MAX_IMG_BYTES = 4 * 1024 * 1024
/** 2 s while an answer is being written. */
export const POLL_MS = 2000

export const useTools = () => useQuery({ queryKey: ['ask', 'tools'], queryFn: ({ signal }) => getJSON<Tools>('/api/assistant/tools', signal), staleTime: 5 * 60_000 })
export const useHistory = () => useQuery({
  queryKey: ['ask', 'history'],
  queryFn: ({ signal }) => getJSON<History>('/api/assistant/history', signal),
  // The interval keeps going through a failed poll: the server keeps working regardless.
  refetchInterval: (q) => (q.state.data?.pending ? POLL_MS : false),
})
export const useFacts = () => useQuery({ queryKey: ['ask', 'facts'], queryFn: ({ signal }) => getJSON<Facts>('/api/assistant/facts', signal) })

export type Image = { b64: string; type: string; dataUrl: string; name: string }
export const ask = (question: string, img: Image | null) =>
  request<{ status: string; reply_id: number }>('/api/assistant/ask', {
    body: { question, ...(img ? { image_b64: img.b64, image_type: img.type } : {}) },
    timeoutMs: 30_000,
  })
export const stopAnswer = () => request<{ status: string }>('/api/assistant/stop', { body: {} })

/** One event from /api/assistant/stream. `reset` drops the text so far: the model
 *  had started talking, then decided to look something up first. */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reset' }
  | { type: 'tool'; name: string }
  | { type: 'tool_done'; name: string; ok: boolean }
  | { type: 'done'; status: 'done' | 'error'; content: string; tools?: string[]; elapsed_ms?: number }

/**
 * Follow one answer. The server replays every event from the start on each
 * connect, so `onOpen` is the cue to forget what an earlier connection delivered.
 * `onGone` fires when the stream can't be had (an old answer, a restart): the
 * caller falls back to polling. Returns the close function.
 */
export function streamAnswer(replyId: number, h: { onOpen: () => void; onEvent: (e: StreamEvent) => void; onGone: () => void }) {
  const es = new EventSource(`/api/assistant/stream?reply_id=${replyId}`)
  let opened = false
  es.onopen = () => { opened = true; h.onOpen() }
  es.onmessage = (m) => {
    let e: StreamEvent
    try { e = JSON.parse(m.data) as StreamEvent } catch { return }
    h.onEvent(e)
    if (e.type === 'done') es.close()
  }
  // A 404 closes it outright; a dropped connection retries on its own (CONNECTING).
  es.onerror = () => { if (es.readyState === EventSource.CLOSED || !opened) { es.close(); h.onGone() } }
  return () => es.close()
}

export const clearThread = () => request<{ status: string; removed: number }>('/api/assistant/clear', { body: {} })
export const addFact = (text: string, subject: string) => request<{ status: string; id: string; total: number }>('/api/assistant/facts', { body: { text, subject } })
export const deleteFact = (id: string) => request<{ status: string; total: number }>('/api/assistant/facts/delete', { body: { id } })

export const SUGGESTIONS: [string, string][] = [
  ['Tell me about the squad', 'tell me about this squad'],
  ['Who is online', 'who is online right now?'],
  ['Best music taste', 'who has the best music taste?'],
  ['Who yaps the most?', 'who sends the most messages?'],
  ['Busiest hours', 'what time of day is the group most active?'],
  ['What is CRCMZ?', 'what is CRCMZ?'],
]

// The draft outlives navigation and a sign-in round trip.
const DRAFT_KEY = 'crcmz.ask.draft'
export const loadDraft = () => { try { return sessionStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' } }
export const saveDraft = (v: string) => { try { if (v) sessionStorage.setItem(DRAFT_KEY, v); else sessionStorage.removeItem(DRAFT_KEY) } catch { /* private mode */ } }

export function readImage(file: File): Promise<Image> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const dataUrl = String(r.result)
      resolve({ b64: dataUrl.split(',')[1] ?? '', type: file.type || 'image/jpeg', dataUrl, name: file.name })
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
