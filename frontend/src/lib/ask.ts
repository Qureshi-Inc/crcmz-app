// Ask AI routes (PS-9). The answer never comes back on the ask: the server queues
// it and writes it into your thread, so the page polls history while it is pending.
// The server is unchanged.
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

// The draft (and a staged image) outlive navigation and a sign-in round trip.
const DRAFT_KEY = 'crcmz.ask.draft'
export const loadDraft = () => { try { return sessionStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' } }
export const saveDraft = (v: string) => { try { if (v) sessionStorage.setItem(DRAFT_KEY, v); else sessionStorage.removeItem(DRAFT_KEY) } catch { /* private mode */ } }
export const staged: { img: Image | null } = { img: null }

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
