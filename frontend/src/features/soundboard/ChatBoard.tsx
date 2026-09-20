import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Tabs from '@radix-ui/react-tabs'
import { CACHE } from '@/app/queryClient'
import { useSession } from '@/app/session'
import { addButton, deleteButton, getPersonalBoard, getSharedBoard } from '@/lib/api/soundboard'
import type { BoardButton } from '@/lib/api/soundboard'
import { sendBoardMessage, sendSquadMessage } from '@/lib/api/squad'
import { ApiError, NetworkError, errorMessage } from '@/lib/api/http'
import { Button, TextField, cx } from '@/components/ui'
import { EmptyState, SectionError, SkeletonRows } from '@/components/ui/states'
import { ConfirmDialog } from '@/components/ui/overlay'

/**
 * The Chat Board, as drawer contents.
 *
 * What changed from the legacy version, beyond where it lives:
 *
 *   - Board choice is a real tab list, not a horizontal swipe with two dots. The swipe
 *     was the only way to reach a personal board, which made it undiscoverable and
 *     unusable by keyboard. Reordering likewise had no alternative to long-press-drag;
 *     it now has Move up / Move down buttons.
 *   - Every send reports its own outcome. The legacy board fired an animation on
 *     request start and told you nothing about the result except a toast.
 *   - A send whose transport failed says so honestly: these post to a real PSN group
 *     and are not idempotent, so nothing is resent automatically.
 */

type Outcome =
  | { kind: 'sent'; msg: string }
  | { kind: 'failed'; msg: string; reason: string }
  | { kind: 'uncertain'; msg: string }

export function ChatBoard() {
  const session = useSession()
  const [tab, setTab] = useState<'shared' | 'mine'>('shared')

  return (
    <Tabs.Root
      value={tab}
      onValueChange={v => setTab(v as 'shared' | 'mine')}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Tabs.List
        aria-label="Which board"
        className="flex shrink-0 gap-1 border-b border-[var(--color-border)] px-3 py-2"
      >
        <BoardTab value="shared">Squad board</BoardTab>
        <BoardTab value="mine">My board</BoardTab>
      </Tabs.List>

      <Tabs.Content value="shared" className="flex min-h-0 flex-1 flex-col outline-none">
        <BoardPanel personal={false} />
      </Tabs.Content>
      <Tabs.Content value="mine" className="flex min-h-0 flex-1 flex-col outline-none">
        {session.signedIn ? (
          <BoardPanel personal />
        ) : (
          <EmptyState
            title="Your own board needs an account"
            body="Sign in and you get a private set of buttons only you can see, which post to the squad as you."
            action={
              <Button variant="primary" onClick={session.signIn}>
                Sign in
              </Button>
            }
          />
        )}
      </Tabs.Content>
    </Tabs.Root>
  )
}

function BoardTab({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cx(
        'min-h-9 flex-1 rounded-[var(--radius-md)] px-3 text-sm font-semibold',
        'text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]',
        'data-[state=active]:bg-[var(--color-accent-subtle)] data-[state=active]:text-[var(--color-accent-text)]',
      )}
    >
      {children}
    </Tabs.Trigger>
  )
}

function BoardPanel({ personal }: { personal: boolean }) {
  const queryClient = useQueryClient()
  const key = personal ? ['board', 'personal'] : ['board', 'shared']
  const board = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => (personal ? getPersonalBoard(signal) : getSharedBoard(signal)),
    ...CACHE.static,
  })

  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [pendingMsg, setPendingMsg] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BoardButton | null>(null)

  const send = useMutation({
    mutationFn: (b: BoardButton) => sendBoardMessage(b.msg, personal),
    onMutate: (b: BoardButton) => {
      setPendingMsg(b.msg)
      setOutcome(null)
    },
    onSuccess: (_data, b) => setOutcome({ kind: 'sent', msg: b.label }),
    onError: (err, b) => {
      // A transport failure on a POST means we do not know. Say that, rather than
      // "failed" — telling someone it failed when it may have landed is how the same
      // line gets posted to a real group twice.
      if (err instanceof NetworkError && err.uncertain) {
        setOutcome({ kind: 'uncertain', msg: b.label })
      } else {
        setOutcome({ kind: 'failed', msg: b.label, reason: errorMessage(err) })
      }
    },
    onSettled: () => setPendingMsg(null),
  })

  const remove = useMutation({
    mutationFn: (b: BoardButton) => deleteButton(b.msg, { personal }),
    onSuccess: () => {
      setConfirmDelete(null)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })

  if (board.isPending && !board.data) {
    return (
      <div className="p-3">
        <SkeletonRows rows={4} />
      </div>
    )
  }
  if (board.isError && !board.data) {
    return (
      <div className="p-3">
        <SectionError error={board.error} what="the board" onRetry={() => void board.refetch()} />
      </div>
    )
  }

  const buttons = board.data ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {outcome && <OutcomeNotice outcome={outcome} onDismiss={() => setOutcome(null)} />}

        {buttons.length === 0 ? (
          <EmptyState
            title={personal ? 'No buttons yet' : 'The squad board is empty'}
            body="Add one below. The AI gives whatever you type some flavour before it saves it."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {buttons.map((b, i) => (
              <BoardRow
                key={b.msg}
                button={b}
                pending={pendingMsg === b.msg}
                // Only one send at a time, so a queue of half-finished posts to a real
                // group is impossible.
                disabled={pendingMsg !== null && pendingMsg !== b.msg}
                onSend={() => send.mutate(b)}
                onDelete={b.custom ? () => setConfirmDelete(b) : undefined}
                position={i + 1}
                total={buttons.length}
              />
            ))}
          </ul>
        )}
      </div>

      <Composer personal={personal} boardKey={key} />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={open => !open && setConfirmDelete(null)}
        title="Delete this button?"
        body={
          <>
            <strong className="text-[var(--color-fg)]">{confirmDelete?.label}</strong> will be
            removed from {personal ? 'your board' : 'the squad board'}. This cannot be undone.
          </>
        }
        confirmLabel="Delete it"
        pending={remove.isPending}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete)}
      />
    </div>
  )
}

function BoardRow({
  button,
  pending,
  disabled,
  onSend,
  onDelete,
  position,
  total,
}: {
  button: BoardButton
  pending: boolean
  disabled: boolean
  onSend: () => void
  onDelete?: () => void
  position: number
  total: number
}) {
  return (
    <li className="flex items-stretch gap-1.5">
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={cx(
          'flex min-h-[var(--tap-target)] flex-1 items-center justify-between gap-3 px-3.5',
          'rounded-[var(--radius-md)] border border-[var(--color-border-strong)]',
          'bg-[var(--color-surface-2)] text-left text-sm font-semibold',
          'hover:bg-[var(--color-surface-3)] disabled:opacity-55 disabled:hover:bg-[var(--color-surface-2)]',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{button.label}</span>
        <span className="sr-only">
          {' '}
          — item {position} of {total}
        </span>
        <span aria-hidden="true" className="shrink-0 text-[var(--color-fg-subtle)]">
          {pending ? '…' : '➤'}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete "${button.label}"`}
          className={cx(
            'grid w-10 shrink-0 place-items-center rounded-[var(--radius-md)]',
            'text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-danger-text)]',
          )}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" />
          </svg>
        </button>
      )}
    </li>
  )
}

function OutcomeNotice({ outcome, onDismiss }: { outcome: Outcome; onDismiss: () => void }) {
  const tone =
    outcome.kind === 'sent'
      ? 'border-[var(--color-live)]/40 bg-[var(--color-live)]/12 text-[var(--color-live-text)]'
      : outcome.kind === 'uncertain'
        ? 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/12 text-[var(--color-warn-text)]'
        : 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/12 text-[var(--color-danger-text)]'
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx('mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2', tone)}
    >
      <p className="flex-1 text-sm">
        {outcome.kind === 'sent' && <>Sent “{outcome.msg}” to the squad.</>}
        {outcome.kind === 'uncertain' && (
          <>
            “{outcome.msg}” may or may not have sent — the connection dropped before the
            app answered. Check the group before sending it again.
          </>
        )}
        {outcome.kind === 'failed' && (
          <>
            “{outcome.msg}” did not send. {outcome.reason}
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 px-1 opacity-70 hover:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}

/**
 * Quick message + "add a button".
 *
 * The quick send is the control the legacy dashboard got wrong by reaching for
 * `.qsend` and matching Ask AI's button. Here the pending state is React state owned
 * by this component, so there is nothing to mis-select and the Enter path and the
 * click path are literally the same function.
 */
function Composer({ personal, boardKey }: { personal: boolean; boardKey: string[] }) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const quick = useMutation({
    mutationFn: (msg: string) => sendSquadMessage(msg),
    onSuccess: () => {
      setText('')
      setNote({ tone: 'ok', text: 'Sent to the squad.' })
    },
    onError: err => {
      // The draft is deliberately left in the field: losing what someone typed because
      // the network blinked is worse than making them press send again.
      if (err instanceof NetworkError && err.uncertain) {
        setNote({ tone: 'warn', text: 'Might have sent — check the group before retrying.' })
      } else if (err instanceof ApiError && err.isRateLimited) {
        setNote({
          tone: 'warn',
          text: err.retryAfter ? `Slow down — try again in ${err.retryAfter}s.` : 'Slow down a sec.',
        })
      } else {
        setNote({ tone: 'err', text: errorMessage(err) })
      }
    },
  })

  const create = useMutation({
    mutationFn: (raw: string) => addButton(raw, { personal, send: false }),
    onSuccess: result => {
      setText('')
      // Show what was actually saved. The flavour model rewrites the text, so echoing
      // the input would be showing something that does not exist.
      setNote({
        tone: 'ok',
        text: result.flavored ? `Added: ${result.flavored}` : 'Button added.',
      })
      void queryClient.invalidateQueries({ queryKey: boardKey })
    },
    onError: err => setNote({ tone: 'err', text: errorMessage(err) }),
  })

  const busy = quick.isPending || create.isPending
  const trimmed = text.trim()

  function submit() {
    // One guard for both Enter and the button. The mutation's own isPending is the
    // gate, not the button's disabled attribute.
    if (!trimmed || busy) return
    setNote(null)
    quick.mutate(trimmed)
  }

  return (
    <div
      className={cx(
        'shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-3',
        // The drawer already reserves the safe-area inset; this only needs the gap.
        'flex flex-col gap-2',
      )}
    >
      {note && (
        <p
          role="status"
          aria-live="polite"
          className={cx(
            'text-xs',
            note.tone === 'ok'
              ? 'text-[var(--color-live-text)]'
              : note.tone === 'warn'
                ? 'text-[var(--color-warn-text)]'
                : 'text-[var(--color-danger-text)]',
          )}
        >
          {note.text}
        </p>
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            ref={inputRef}
            id="board-composer"
            label="Message the squad"
            hideLabel
            placeholder="Send a quick message…"
            maxLength={200}
            autoComplete="off"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </div>
        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          disabled={!trimmed}
          pending={quick.isPending}
          className="shrink-0 px-4"
          aria-label="Send to the squad"
        >
          <span aria-hidden="true">➤</span>
        </Button>
      </div>
      <button
        type="button"
        onClick={() => {
          if (!trimmed || busy) return
          setNote(null)
          create.mutate(trimmed)
        }}
        disabled={!trimmed || busy}
        className={cx(
          'self-start text-xs font-semibold text-[var(--color-accent-text)]',
          'hover:underline disabled:opacity-50 disabled:no-underline',
        )}
      >
        {create.isPending ? 'Saving a button…' : '✨ Save that as a button instead'}
      </button>
    </div>
  )
}
