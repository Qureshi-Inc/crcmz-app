import { api } from './http'

/**
 * The squad assistant.
 *
 * The important property: **the server owns the conversation.** /api/assistant/ask
 * returns 202 with a reply_id and nothing else — the answer is written into the thread
 * by a background thread, and /api/assistant/history returns the thread plus a `pending`
 * flag. So a refresh, a closed tab or a locked phone loses nothing, and the client's job
 * is to poll while something is pending rather than to hold the answer in memory.
 *
 * There is no streaming and no progress percentage. Inventing either would be showing
 * the user a number the backend does not have.
 */

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  /** 'pending' while the reply is still being written. */
  status: string
  tools: string[]
  elapsedMs: number | null
  createdAt: string | null
}

export interface ChatThread {
  messages: ChatMessage[]
  /** True while the server is working on a reply. Drives polling. */
  pending: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function getThread(signal?: AbortSignal) {
  return api.get<ChatThread>('/api/assistant/history', {
    signal,
    parse: (raw): ChatThread => {
      const root = (raw ?? {}) as { messages?: unknown; pending?: unknown }
      const list = Array.isArray(root.messages) ? root.messages : []
      return {
        pending: root.pending === true,
        messages: list.flatMap((item): ChatMessage[] => {
          const m = (item ?? {}) as Record<string, unknown>
          const id = typeof m.id === 'number' ? m.id : null
          if (id === null) return []
          return [{
            id,
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: typeof m.content === 'string' ? m.content : '',
            status: str(m.status) ?? 'done',
            tools: Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === 'string') : [],
            elapsedMs: typeof m.elapsed_ms === 'number' ? m.elapsed_ms : null,
            createdAt: str(m.created_at),
          }]
        }),
      }
    },
  })
}

export interface Tools {
  available: boolean
  model: string
  toolCount: number
}

export function getTools(signal?: AbortSignal) {
  return api.get<Tools>('/api/assistant/tools', {
    signal,
    parse: (raw): Tools => {
      const r = (raw ?? {}) as Record<string, unknown>
      return {
        available: r.available === true,
        model: str(r.model) ?? 'unknown',
        toolCount: Array.isArray(r.tools) ? r.tools.length : 0,
      }
    },
  })
}

export interface AskAccepted {
  replyId: number | null
}

/**
 * Queue a question.
 *
 * 409 means a question is already in flight for this account — the backend refuses a
 * second one. That is a real answer, not a failure to report as an error: the UI should
 * say "still working on the last one".
 */
export function ask(
  question: string,
  image: { b64: string; type: string } | null,
  signal?: AbortSignal,
) {
  return api.post<AskAccepted>(
    '/api/assistant/ask',
    {
      question,
      ...(image ? { image_b64: image.b64, image_type: image.type } : {}),
    },
    {
      signal,
      // Only queueing; the model's own time is spent server-side.
      timeoutMs: 20_000,
      parse: (raw): AskAccepted => {
        const id = (raw as { reply_id?: unknown })?.reply_id
        return { replyId: typeof id === 'number' ? id : null }
      },
    },
  )
}

export const clearThread = (signal?: AbortSignal) =>
  api.post<{ status?: string }>('/api/assistant/clear', undefined, { signal })

/* ── Facts ─────────────────────────────────────────────────────────────────────
 * Shared across the squad, not per-user: anyone can add one, and `mine` says whether
 * this account is allowed to delete it. The server enforces that; the UI only avoids
 * offering a button that would 403.
 */

export interface Fact {
  id: string
  subject: string
  text: string
  author: string
  createdAt: string | null
  mine: boolean
}

export interface FactsResponse {
  facts: Fact[]
  /** Existing subjects, so "Zubi" and "zubi" do not become two people. */
  suggestions: string[]
}

export function getFacts(signal?: AbortSignal) {
  return api.get<FactsResponse>('/api/assistant/facts', {
    signal,
    parse: (raw): FactsResponse => {
      const root = (raw ?? {}) as { facts?: unknown; suggestions?: unknown }
      const list = Array.isArray(root.facts) ? root.facts : []
      return {
        suggestions: Array.isArray(root.suggestions)
          ? root.suggestions.filter((s): s is string => typeof s === 'string')
          : [],
        facts: list.flatMap((item): Fact[] => {
          const f = (item ?? {}) as Record<string, unknown>
          const id = f.id
          const text = str(f.text)
          if (id === undefined || id === null || !text) return []
          return [{
            id: String(id),
            text,
            subject: str(f.subject) ?? '',
            author: str(f.author) ?? 'someone',
            createdAt: str(f.created_at),
            mine: f.mine === true,
          }]
        }),
      }
    },
  })
}

export const addFact = (subject: string, text: string, signal?: AbortSignal) =>
  api.post<{ status?: string }>('/api/assistant/facts', { subject, text }, { signal })

export const deleteFact = (id: string, signal?: AbortSignal) =>
  api.post<{ status?: string }>('/api/assistant/facts/delete', { id }, { signal })
