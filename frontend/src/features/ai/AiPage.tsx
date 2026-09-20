import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CACHE } from '@/app/queryClient'
import { useSession } from '@/app/session'
import { ask, clearThread, getThread, getTools } from '@/lib/api/assistant'
import type { ChatMessage } from '@/lib/api/assistant'
import { ApiError, NetworkError, errorMessage } from '@/lib/api/http'
import { Badge, Button, Card, cx } from '@/components/ui'
import { EmptyState, RelativeTime, SectionError } from '@/components/ui/states'
import { ConfirmDialog } from '@/components/ui/overlay'
import { PageTitle } from '@/components/PageTitle'
import { FactsPanel } from './FactsPanel'

/**
 * Ask AI.
 *
 * The thread is server state, so this component holds almost nothing: it renders
 * /api/assistant/history and polls while that endpoint reports `pending`. That is what
 * makes a refresh, a closed tab or a locked phone survivable — the question is already
 * queued server-side, and coming back just reads it.
 *
 * Polling stops the moment nothing is pending. The legacy version left an interval
 * running for the life of the page.
 *
 * No streaming, no progress bar: the backend has neither, and a fake percentage is worse
 * than "working on it".
 */
export function AiPage() {
  const session = useSession()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<{ tone: 'warn' | 'err'; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const tools = useQuery({
    queryKey: ['assistant', 'tools'],
    queryFn: ({ signal }) => getTools(signal),
    ...CACHE.static,
    enabled: session.signedIn,
  })

  const thread = useQuery({
    queryKey: ['assistant', 'thread'],
    queryFn: ({ signal }) => getThread(signal),
    ...CACHE.conversation,
    enabled: session.signedIn,
    // Poll only while the server says it is working. `query.state.data` rather than a
    // captured variable, so this re-evaluates on every result instead of freezing at
    // whatever was true when the component mounted.
    refetchInterval: query => (query.state.data?.pending ? 2_000 : false),
  })

  const messages = thread.data?.messages ?? []
  const pending = thread.data?.pending ?? false

  const submit = useMutation({
    mutationFn: (question: string) => ask(question, null),
    onSuccess: () => {
      // Clear the box only once the server has accepted the question. Clearing on click
      // and then failing is how people lose what they typed.
      setDraft('')
      setNote(null)
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'thread'] })
    },
    onError: err => {
      if (err instanceof ApiError && err.status === 409) {
        setNote({ tone: 'warn', text: 'Still working on your last question — give it a moment.' })
        void queryClient.invalidateQueries({ queryKey: ['assistant', 'thread'] })
        return
      }
      if (err instanceof NetworkError && err.uncertain) {
        setNote({
          tone: 'warn',
          text: 'Not sure that was queued. Your question is still here — check the thread before sending it again.',
        })
        void queryClient.invalidateQueries({ queryKey: ['assistant', 'thread'] })
        return
      }
      setNote({ tone: 'err', text: errorMessage(err) })
    },
  })

  const clear = useMutation({
    mutationFn: () => clearThread(),
    onSuccess: () => {
      setConfirmClear(false)
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'thread'] })
    },
  })

  // Keep the newest message in view, but only when the user is already near the bottom.
  // Yanking someone back down while they are reading history is the classic chat bug.
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length, pending])

  if (!session.signedIn && !session.loading) {
    return (
      <div className="mx-auto w-full max-w-[var(--content-width-read)]">
        <PageTitle title="Ask AI" />
        <Card>
          <EmptyState
            title="Sign in to ask"
            body="The assistant answers from the squad's own data, so it needs to know who is asking."
            action={
              <Button variant="primary" onClick={session.signIn}>
                Sign in
              </Button>
            }
          />
        </Card>
      </div>
    )
  }

  const canSend = draft.trim().length > 0 && !submit.isPending && !pending

  return (
    <div className="mx-auto w-full max-w-[var(--content-width-read)]">
      <PageTitle
        title="Ask AI"
        subtitle="Answers come from the squad's own clips, games and chat history."
        meta={
          tools.data?.available ? (
            <span className="text-xs text-[var(--color-fg-subtle)]">
              {tools.data.model} · {tools.data.toolCount} tools
            </span>
          ) : null
        }
        action={
          messages.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
              Clear chat
            </Button>
          ) : null
        }
      />

      {tools.data && !tools.data.available && (
        <div
          role="alert"
          className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/12 px-3.5 py-2.5 text-sm text-[var(--color-warn-text)]"
        >
          No model is configured on the server, so asking will not work right now.
        </div>
      )}

      {/* ── Thread ───────────────────────────────────────────────────────── */}
      {thread.isError && !thread.data ? (
        <SectionError error={thread.error} what="the conversation" onRetry={() => void thread.refetch()} />
      ) : (
        <div
          ref={listRef}
          className="mb-3 max-h-[min(58dvh,560px)] overflow-y-auto"
          // The thread updates in the background. polite, so a reply does not interrupt
          // whatever the user is doing, and it is a log so only additions are read.
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {thread.isPending && !thread.data ? (
            <div className="flex flex-col gap-2">
              <div className="skeleton h-16" />
              <div className="skeleton h-24" />
            </div>
          ) : messages.length === 0 ? (
            <Card>
              <EmptyState
                title="Nothing asked yet"
                body="Try one of these, or type your own."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => {
                          setDraft(s)
                          inputRef.current?.focus()
                        }}
                        className="min-h-9 rounded-[var(--radius-full)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 text-sm hover:bg-[var(--color-surface-3)]"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                }
              />
            </Card>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {messages.map(m => (
                <Bubble key={m.id} message={m} />
              ))}
            </ol>
          )}
        </div>
      )}

      {/* ── Composer ─────────────────────────────────────────────────────── */}
      <Card className="p-3">
        {note && (
          <p
            role="status"
            aria-live="polite"
            className={cx(
              'mb-2 text-sm',
              note.tone === 'warn' ? 'text-[var(--color-warn-text)]' : 'text-[var(--color-danger-text)]',
            )}
          >
            {note.text}
          </p>
        )}
        {pending && (
          <p className="mb-2 text-sm text-[var(--color-fg-muted)]">
            Working on your question. You can leave this page — the answer will be here
            when you come back.
          </p>
        )}
        <label htmlFor="ai-question" className="sr-only">
          Your question
        </label>
        <textarea
          ref={inputRef}
          id="ai-question"
          rows={2}
          maxLength={1000}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Enter sends, Shift+Enter is a newline. One path, guarded by the same
            // condition the button uses.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) submit.mutate(draft.trim())
            }
          }}
          placeholder="Ask about the squad — who plays what, who yaps most, last month's clips…"
          className={cx(
            'w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border-strong)]',
            'bg-[var(--color-surface-2)] px-3.5 py-2.5 text-base text-[var(--color-fg)]',
            'placeholder:text-[var(--color-fg-subtle)]',
          )}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            {draft.length}/1000 · Enter sends, Shift+Enter for a new line
          </span>
          <Button
            variant="primary"
            onClick={() => canSend && submit.mutate(draft.trim())}
            disabled={!canSend}
            pending={submit.isPending}
            pendingLabel="Sending…"
          >
            Ask
          </Button>
        </div>
      </Card>

      <div className="mt-8">
        <FactsPanel />
      </div>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear this conversation?"
        body="Your whole thread with the assistant is deleted from the server. Squad facts are kept."
        confirmLabel="Clear it"
        pending={clear.isPending}
        onConfirm={() => clear.mutate()}
      />
    </div>
  )
}

const SUGGESTIONS = [
  'Who yaps the most?',
  'What did we play last week?',
  'Whose clips made the last montage?',
]

function Bubble({ message }: { message: ChatMessage }) {
  const mine = message.role === 'user'
  const working = message.status === 'pending'
  return (
    <li className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cx(
          'max-w-[86%] rounded-[var(--radius-lg)] px-3.5 py-2.5',
          mine
            ? 'bg-[var(--color-accent-subtle)] text-[var(--color-fg)]'
            : 'border border-[var(--color-border)] bg-[var(--color-surface-1)]',
        )}
      >
        <p className="mb-1 flex items-center gap-2 text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
          {mine ? 'You' : 'Assistant'}
          {message.createdAt && (
            <span className="normal-case tracking-normal">
              <RelativeTime at={message.createdAt} />
            </span>
          )}
        </p>
        {working ? (
          <p className="text-sm text-[var(--color-fg-muted)]">Thinking…</p>
        ) : (
          // Plain text, deliberately. The reply is model output; rendering it as HTML or
          // markdown-with-innerHTML is how an injection gets in.
          <p className="whitespace-pre-wrap text-base">{message.content}</p>
        )}
        {message.tools.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.tools.map(t => (
              <Badge key={t} tone="neutral">
                {t}
              </Badge>
            ))}
          </div>
        )}
        {message.elapsedMs !== null && !working && (
          <p className="mt-1.5 text-2xs text-[var(--color-fg-subtle)]">
            {(message.elapsedMs / 1000).toFixed(1)}s
          </p>
        )}
      </div>
    </li>
  )
}
