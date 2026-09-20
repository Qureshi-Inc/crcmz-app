import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CACHE } from '@/app/queryClient'
import { useSession } from '@/app/session'
import {
  addEntry,
  closeGiveaway,
  createGiveaway,
  drawWinner,
  getGiveaway,
  getHistory,
  lockGiveaway,
  publishGiveaway,
  redrawWinner,
  removeEntry,
  revealWinner,
} from '@/lib/api/giveaway'
import type { Giveaway, GiveawayState, Rotation } from '@/lib/api/giveaway'
import { errorMessage } from '@/lib/api/http'
import { Badge, Button, Card, SectionHeading, TextField, cx } from '@/components/ui'
import { EmptyState, RelativeTime, SectionError } from '@/components/ui/states'
import { ConfirmDialog } from '@/components/ui/overlay'
import { PageTitle } from '@/components/PageTitle'

/**
 * Giveaways.
 *
 * The one rule this screen exists to keep: **rendering never mutates.** Every transition
 * is behind a button, and every irreversible one is behind a confirmation that names what
 * will happen. The legacy version drew and revealed a winner from inside its data loader
 * whenever an admin happened to open the tab after the scheduled time — see the header
 * comment in lib/api/giveaway.ts.
 *
 * The consequence is documented rather than papered over: a scheduled reveal now waits
 * for an admin to press Reveal. Restoring automatic timing needs an idempotent backend
 * job, which is tracked as a blocker.
 */
export function GiveawaysPage() {
  const session = useSession()
  const state = useQuery({
    queryKey: ['giveaway'],
    queryFn: ({ signal }) => getGiveaway(signal),
    // No refetchInterval. Polling a screen whose buttons draw real winners buys nothing
    // and the endpoint is a Zitadel round trip plus a portal scan.
    ...CACHE.conversation,
    enabled: session.signedIn,
  })
  const history = useQuery({
    queryKey: ['giveaway', 'history'],
    queryFn: ({ signal }) => getHistory(signal),
    ...CACHE.conversation,
    enabled: session.signedIn,
  })

  if (!session.signedIn && !session.loading) {
    return (
      <div className="mx-auto w-full max-w-[var(--content-width-read)]">
        <PageTitle title="Giveaways" />
        <Card>
          <EmptyState
            title="Sign in to see the giveaway"
            body="Eligibility is per account, so this needs to know who you are."
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

  return (
    <div className="mx-auto w-full max-w-[var(--content-width-read)]">
      <PageTitle title="Giveaways" subtitle="Everyone wins once per cycle." />

      {state.isPending && !state.data ? (
        <div className="flex flex-col gap-3">
          <div className="skeleton h-40" />
          <div className="skeleton h-24" />
        </div>
      ) : state.isError && !state.data ? (
        <SectionError error={state.error} what="the giveaway" onRetry={() => void state.refetch()} />
      ) : (
        <>
          <ActiveGiveaway state={state.data!} />
          {state.data?.rotation && <RotationCard rotation={state.data.rotation} />}
          {state.data?.isAdmin && <AdminPanel state={state.data} />}
        </>
      )}

      <section aria-labelledby="gw-history" className="mt-8">
        <SectionHeading level={2}>
          <span id="gw-history">Past giveaways</span>
        </SectionHeading>
        {history.isPending && !history.data ? (
          <div className="skeleton h-20" />
        ) : history.isError && !history.data ? (
          <SectionError error={history.error} what="the history" onRetry={() => void history.refetch()} />
        ) : (history.data ?? []).length === 0 ? (
          <Card>
            <EmptyState title="No giveaways have finished yet" />
          </Card>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(history.data ?? []).map(h => (
              <Card as="li" key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                <span className="flex-1 text-sm font-semibold">{h.title || 'Giveaway'}</span>
                {h.prize && (
                  <span className="text-sm text-[var(--color-fg-muted)]">{h.prize}</span>
                )}
                {h.winnerName && <Badge tone="accent">🏆 {h.winnerName}</Badge>}
                {h.closedAt && (
                  <span className="text-xs text-[var(--color-fg-subtle)]">
                    <RelativeTime at={h.closedAt} />
                  </span>
                )}
              </Card>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ActiveGiveaway({ state }: { state: GiveawayState }) {
  const g = state.giveaway
  if (!g) {
    return (
      <Card>
        <EmptyState
          title="No giveaway running"
          body={
            state.isAdmin
              ? 'Create one below when you are ready.'
              : 'There is nothing to enter right now. One will turn up.'
          }
        />
      </Card>
    )
  }

  const revealed = g.status === 'revealed' || g.status === 'closed'
  const winner = g.activeDraw?.winnerName ?? null

  return (
    <Card className="mb-4 px-5 py-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold">{g.title || 'Giveaway'}</h2>
          {g.prize && (
            <p className="text-base text-[var(--color-accent-text)]">🎁 {g.prize}</p>
          )}
        </div>
        <StatusBadge status={g.status} />
      </div>

      {revealed && winner ? (
        <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] px-4 py-5 text-center">
          <p className="text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
            Winner
          </p>
          <p className="mt-1 text-2xl font-extrabold text-[var(--color-accent-text)]">
            {winner}
          </p>
        </div>
      ) : g.status === 'drawn' ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          The winner has been drawn but not revealed yet
          {g.revealAt && (
            <>
              {' '}
              — reveal is set for{' '}
              <time dateTime={g.revealAt}>{new Date(g.revealAt).toLocaleString()}</time>
            </>
          )}
          .
        </p>
      ) : (
        <>
          {g.revealAt && (
            <p className="text-sm text-[var(--color-fg-muted)]">
              Reveal <time dateTime={g.revealAt}>{new Date(g.revealAt).toLocaleString()}</time>
            </p>
          )}
          <div className="mt-3">
            {state.userEligible ? (
              <Badge tone="live">✅ You&rsquo;re in this draw</Badge>
            ) : state.userWonThisCycle ? (
              <Badge tone="accent">🏆 You won this cycle — you rejoin next time</Badge>
            ) : (
              <Badge tone="neutral">⏸ You&rsquo;re not in this draw</Badge>
            )}
          </div>
        </>
      )}

      <p className="mt-4 text-xs text-[var(--color-fg-subtle)]">
        {g.entries.length} {g.entries.length === 1 ? 'entry' : 'entries'}
      </p>
    </Card>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'revealed' || status === 'closed' ? 'accent' : status === 'open' ? 'live' : 'neutral'
  return <Badge tone={tone}>{status}</Badge>
}

function RotationCard({ rotation }: { rotation: Rotation }) {
  const pct =
    rotation.totalMembers > 0 ? Math.round((rotation.wonCount / rotation.totalMembers) * 100) : 0
  return (
    <Card className="mb-4 px-4 py-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">Cycle {rotation.cycle}</p>
        <p className="text-sm text-[var(--color-fg-muted)]">
          {rotation.wonCount} of {rotation.totalMembers} have won · {rotation.eligibleCount} still
          eligible
        </p>
      </div>
      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="How far through the cycle the squad is"
        className="h-2 overflow-hidden rounded-[var(--radius-full)] bg-[var(--color-surface-3)]"
      >
        <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
      </div>
      {rotation.wonMembers.length > 0 && (
        <p className="mt-2.5 text-xs text-[var(--color-fg-subtle)]">
          Already won: {rotation.wonMembers.map(m => m.name).join(', ')}
        </p>
      )}
    </Card>
  )
}

/**
 * Admin controls.
 *
 * Every action is a named button; the destructive ones are behind a confirmation whose
 * label says what happens ("Draw the winner", not "OK"). Only the transitions the current
 * status actually permits are offered, so a refused transition is rare rather than the
 * normal way to discover the state machine.
 */
function AdminPanel({ state }: { state: GiveawayState }) {
  const queryClient = useQueryClient()
  const g = state.giveaway
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    label: string
    run: () => Promise<unknown>
  } | null>(null)

  const act = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setConfirm(null)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['giveaway'] })
    },
    onError: err => {
      setConfirm(null)
      setError(errorMessage(err))
    },
  })

  function ask(title: string, body: string, label: string, run: () => Promise<unknown>) {
    setError(null)
    setConfirm({ title, body, label, run })
  }

  return (
    <section aria-labelledby="gw-admin" className="mb-4">
      <SectionHeading level={2} action={<Badge tone="accent">Admin</Badge>}>
        <span id="gw-admin">Run the giveaway</span>
      </SectionHeading>

      {error && (
        <p
          role="alert"
          className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/12 px-3.5 py-2.5 text-sm text-[var(--color-danger-text)]"
        >
          {error}
        </p>
      )}

      {!g ? (
        <CreateForm
          onDone={() => void queryClient.invalidateQueries({ queryKey: ['giveaway'] })}
          onError={setError}
        />
      ) : (
        <Card className="flex flex-wrap gap-2 px-4 py-4">
          {g.status === 'draft' && (
            <Button
              variant="primary"
              pending={act.isPending}
              onClick={() =>
                ask(
                  'Publish this giveaway?',
                  'Everyone eligible will be able to see it and will be entered.',
                  'Publish it',
                  () => publishGiveaway(g.id),
                )
              }
            >
              Publish
            </Button>
          )}
          {g.status === 'open' && (
            <Button
              variant="secondary"
              pending={act.isPending}
              onClick={() =>
                ask(
                  'Lock the entries?',
                  'No more entries can be added or removed after this.',
                  'Lock it',
                  () => lockGiveaway(g.id),
                )
              }
            >
              Lock entries
            </Button>
          )}
          {(g.status === 'open' || g.status === 'locked') && (
            <Button
              variant="primary"
              pending={act.isPending}
              disabled={g.entries.length === 0}
              onClick={() =>
                ask(
                  'Draw the winner?',
                  `One of the ${g.entries.length} entries will be picked at random. This is recorded and counts towards the cycle.`,
                  'Draw the winner',
                  () => drawWinner(g.id),
                )
              }
            >
              Draw a winner
            </Button>
          )}
          {g.status === 'drawn' && (
            <>
              <Button
                variant="primary"
                pending={act.isPending}
                onClick={() =>
                  ask(
                    'Reveal the winner?',
                    'Everyone will see who won. There is no way to un-reveal it.',
                    'Reveal it',
                    () => revealWinner(g.id),
                  )
                }
              >
                Reveal the winner
              </Button>
              <Button
                variant="danger"
                pending={act.isPending}
                onClick={() =>
                  ask(
                    'Draw again?',
                    'The current drawn winner is discarded and a new one is picked. Only do this if the draw was wrong.',
                    'Discard and redraw',
                    () => redrawWinner(g.id),
                  )
                }
              >
                Redraw
              </Button>
            </>
          )}
          {g.status === 'revealed' && (
            <Button
              variant="secondary"
              pending={act.isPending}
              onClick={() =>
                ask(
                  'Close this giveaway?',
                  'It moves into the history and the winner is counted in this cycle.',
                  'Close it',
                  () => closeGiveaway(g.id),
                )
              }
            >
              Close it
            </Button>
          )}
          <p className="w-full text-xs text-[var(--color-fg-subtle)]">
            Scheduled reveals are not automatic: this page will never draw or reveal on its
            own, so a reveal happens when you press the button.
          </p>
        </Card>
      )}

      {g && (g.status === 'draft' || g.status === 'open') && (
        <EntriesEditor
          giveaway={g}
          allMembers={state.rotation?.allMembers ?? []}
          onError={setError}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={open => !open && setConfirm(null)}
        title={confirm?.title ?? ''}
        body={confirm?.body ?? ''}
        confirmLabel={confirm?.label ?? ''}
        pending={act.isPending}
        onConfirm={() => confirm && act.mutate(confirm.run)}
      />
    </section>
  )
}

function CreateForm({
  onDone,
  onError,
}: {
  onDone: () => void
  onError: (msg: string) => void
}) {
  const [title, setTitle] = useState('')
  const [prize, setPrize] = useState('')
  const [revealAt, setRevealAt] = useState('')

  const create = useMutation({
    mutationFn: () =>
      createGiveaway({
        title: title.trim(),
        prize: prize.trim(),
        // The backend defaults draw_at to reveal_at when it is absent, which is the
        // behaviour this form wants: one date, drawn and revealed together.
        drawAt: null,
        revealAt: revealAt ? new Date(revealAt).toISOString() : null,
      }),
    onSuccess: () => {
      setTitle('')
      setPrize('')
      setRevealAt('')
      onDone()
    },
    onError: err => onError(errorMessage(err)),
  })

  return (
    <Card className="flex flex-col gap-3 px-4 py-4">
      <TextField
        id="gw-title"
        label="Title"
        value={title}
        onChange={e => setTitle(e.target.value)}
        maxLength={120}
      />
      <TextField
        id="gw-prize"
        label="Prize"
        value={prize}
        onChange={e => setPrize(e.target.value)}
        maxLength={160}
      />
      <TextField
        id="gw-reveal"
        label="Reveal at"
        type="datetime-local"
        hint="Optional. Nothing happens automatically at this time — it is what the page shows people."
        value={revealAt}
        onChange={e => setRevealAt(e.target.value)}
      />
      <Button
        variant="primary"
        className="self-start"
        disabled={!title.trim()}
        pending={create.isPending}
        pendingLabel="Creating…"
        onClick={() => create.mutate()}
      >
        Create it as a draft
      </Button>
    </Card>
  )
}

function EntriesEditor({
  giveaway,
  allMembers,
  onError,
}: {
  giveaway: Giveaway
  allMembers: { memberId: string; name: string }[]
  onError: (msg: string) => void
}) {
  const queryClient = useQueryClient()
  const entered = new Set(giveaway.entries.map(e => e.memberId))
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['giveaway'] })

  const add = useMutation({
    mutationFn: (m: { memberId: string; name: string }) =>
      addEntry(giveaway.id, m.memberId, m.name),
    onSuccess: invalidate,
    onError: err => onError(errorMessage(err)),
  })
  const drop = useMutation({
    mutationFn: (memberId: string) => removeEntry(giveaway.id, memberId),
    onSuccess: invalidate,
    onError: err => onError(errorMessage(err)),
  })

  if (allMembers.length === 0) return null

  return (
    <Card className="mt-3 px-4 py-4">
      <h3 className="mb-2 text-sm font-bold">Who is in</h3>
      <ul className="flex flex-wrap gap-2">
        {allMembers.map(m => {
          const isIn = entered.has(m.memberId)
          const busy = add.isPending || drop.isPending
          return (
            <li key={m.memberId}>
              <button
                type="button"
                disabled={busy}
                aria-pressed={isIn}
                onClick={() => (isIn ? drop.mutate(m.memberId) : add.mutate(m))}
                className={cx(
                  'min-h-9 rounded-[var(--radius-full)] border px-3.5 text-sm font-semibold',
                  'disabled:opacity-55',
                  isIn
                    ? 'border-[var(--color-live)]/50 bg-[var(--color-live)]/12 text-[var(--color-live-text)]'
                    : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)]',
                )}
              >
                {isIn ? '✓ ' : '+ '}
                {m.name}
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
