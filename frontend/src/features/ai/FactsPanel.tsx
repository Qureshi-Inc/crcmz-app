import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CACHE } from '@/app/queryClient'
import { addFact, deleteFact, getFacts } from '@/lib/api/assistant'
import { errorMessage } from '@/lib/api/http'
import { Button, Card, SectionHeading, TextField, cx } from '@/components/ui'
import { EmptyState, RelativeTime, SectionError } from '@/components/ui/states'

/**
 * Squad facts.
 *
 * Shared, not per-user: anything added here goes into every future answer for everyone,
 * which the heading says out loud because the legacy UI did not and it is the one thing
 * someone might not expect.
 *
 * Deletion is offered only where the server allows it (`mine`). That is a
 * discoverability decision — the endpoint enforces it regardless.
 *
 * The subject box has a datalist of existing subjects. That is not decoration: typing
 * "Zubi" when every other fact says "zubair221b" silently splits what the model knows
 * about one person.
 */
export function FactsPanel() {
  const queryClient = useQueryClient()
  const subjectListId = useId()
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const facts = useQuery({
    queryKey: ['assistant', 'facts'],
    queryFn: ({ signal }) => getFacts(signal),
    ...CACHE.conversation,
  })

  const add = useMutation({
    mutationFn: () => addFact(subject.trim(), text.trim()),
    onSuccess: () => {
      setText('')
      setError(null)
      // Subject deliberately kept: adding three facts about one person is the common case.
      void queryClient.invalidateQueries({ queryKey: ['assistant', 'facts'] })
    },
    onError: err => setError(errorMessage(err)),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteFact(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['assistant', 'facts'] }),
    onError: err => setError(errorMessage(err)),
  })

  const rows = facts.data?.facts ?? []
  const canAdd = text.trim().length > 0 && !add.isPending

  return (
    <section aria-labelledby="facts">
      <SectionHeading level={2} hint="everyone sees these, and so does every answer">
        <span id="facts">Squad facts</span>
      </SectionHeading>

      <Card className="mb-3 p-3.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-[210px]">
            <TextField
              id="fact-subject"
              label="About who?"
              placeholder="optional"
              list={subjectListId}
              value={subject}
              onChange={e => setSubject(e.target.value)}
              autoComplete="off"
            />
            <datalist id={subjectListId}>
              {(facts.data?.suggestions ?? []).map(s => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="flex-1">
            <TextField
              id="fact-text"
              label="The fact"
              placeholder="e.g. always plays support, never uses a mic"
              maxLength={300}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && canAdd) {
                  e.preventDefault()
                  add.mutate()
                }
              }}
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            disabled={!canAdd}
            pending={add.isPending}
            pendingLabel="Saving…"
            onClick={() => add.mutate()}
          >
            Add
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-[var(--color-danger-text)]">
            {error}
          </p>
        )}
      </Card>

      {facts.isPending && !facts.data ? (
        <div className="skeleton h-24" />
      ) : facts.isError && !facts.data ? (
        <SectionError error={facts.error} what="squad facts" onRetry={() => void facts.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No facts yet"
            body="Tell the assistant something it cannot work out from the data — a nickname, a habit, an in-joke."
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map(f => (
            <Card as="li" key={f.id} className="flex items-start gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {f.subject && (
                    <span className="font-bold text-[var(--color-accent-text)]">{f.subject}: </span>
                  )}
                  {f.text}
                </p>
                <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                  {f.author}
                  {f.createdAt && (
                    <>
                      {' · '}
                      <RelativeTime at={f.createdAt} />
                    </>
                  )}
                </p>
              </div>
              {f.mine && (
                <button
                  type="button"
                  onClick={() => remove.mutate(f.id)}
                  disabled={remove.isPending}
                  aria-label={`Delete the fact: ${f.text}`}
                  className={cx(
                    'grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)]',
                    'text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-danger-text)]',
                    'disabled:opacity-50',
                  )}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" />
                  </svg>
                </button>
              )}
            </Card>
          ))}
        </ul>
      )}
    </section>
  )
}
