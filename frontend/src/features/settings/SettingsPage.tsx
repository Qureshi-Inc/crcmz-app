import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CACHE } from '@/app/queryClient'
import { useSession } from '@/app/session'
import {
  claimPsn,
  deletePasskey,
  getMattermostStatus,
  getMcpStatus,
  getPasskeys,
  getPsnStatus,
  revokeMcp,
  setPassword,
  unlinkMattermost,
} from '@/lib/api/account'
import { errorMessage } from '@/lib/api/http'
import { Badge, Button, Card, SectionHeading, TextField, cx } from '@/components/ui'
import { EmptyState, RelativeTime, SectionError } from '@/components/ui/states'
import { ConfirmDialog } from '@/components/ui/overlay'
import { PageTitle } from '@/components/PageTitle'

/**
 * Account settings, as a page rather than a modal.
 *
 * The legacy version was a plain div with a click-to-close handler: no dialog role, no
 * focus trap, no Escape, no focus restoration, and the background stayed interactive. A
 * route is simpler and better here — it is a page's worth of content, it deep-links, and
 * Back does the obvious thing.
 *
 * Each section reads independently so one unavailable integration does not hide the
 * others, which matters because Mattermost and MCP both depend on services that can be
 * down without the app being down.
 */
export function SettingsPage() {
  const session = useSession()

  if (!session.signedIn && !session.loading) {
    return (
      <div className="mx-auto w-full max-w-[var(--content-width-read)]">
        <PageTitle title="Settings" />
        <Card>
          <EmptyState
            title="Sign in to manage your account"
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
      <PageTitle title="Settings" subtitle="Connections, sign-in and access." />
      <div className="flex flex-col gap-8">
        <PsnSection />
        <MattermostSection />
        <McpSection />
        <PasskeySection />
        <PasswordSection />
      </div>
    </div>
  )
}

function PsnSection() {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const psn = useQuery({
    queryKey: ['account', 'psn'],
    queryFn: ({ signal }) => getPsnStatus(signal),
    ...CACHE.static,
  })

  const claim = useMutation({
    mutationFn: (key: string) => claimPsn(key),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['account', 'psn'] })
      // Home reads presence from the portal records, so it is now wrong too.
      void queryClient.invalidateQueries({ queryKey: ['squad'] })
    },
    onError: err => setError(errorMessage(err)),
  })

  return (
    <section aria-labelledby="set-psn">
      <SectionHeading level={2}>
        <span id="set-psn">PlayStation</span>
      </SectionHeading>
      {psn.isPending && !psn.data ? (
        <div className="skeleton h-20" />
      ) : psn.isError && !psn.data ? (
        <SectionError error={psn.error} what="your PlayStation link" onRetry={() => void psn.refetch()} />
      ) : psn.data?.linked ? (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-4">
          <Badge tone="live">Linked</Badge>
          <span className="flex-1 text-base font-semibold">{psn.data.onlineId}</span>
          <a
            href="/portal"
            className="text-sm font-semibold text-[var(--color-accent-text)] hover:underline"
          >
            Manage in the portal →
          </a>
        </Card>
      ) : (
        <Card className="px-4 py-4">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Link a PlayStation account and you show up on Home with whatever you are
            playing.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-[var(--color-danger-text)]">
              {error}
            </p>
          )}
          {(psn.data?.unclaimed ?? []).length > 0 ? (
            <>
              <p className="mt-3 text-sm font-semibold">
                Is one of these yours?
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {(psn.data?.unclaimed ?? []).map(u => (
                  <li key={u.key}>
                    <Button
                      variant="secondary"
                      size="sm"
                      pending={claim.isPending}
                      onClick={() => claim.mutate(u.key)}
                    >
                      Claim {u.onlineId}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <a
              href="/portal"
              className="mt-3 inline-flex min-h-10 items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
            >
              Link an account
            </a>
          )}
        </Card>
      )}
    </section>
  )
}

function MattermostSection() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const mm = useQuery({
    queryKey: ['account', 'mattermost'],
    queryFn: ({ signal }) => getMattermostStatus(signal),
    ...CACHE.static,
  })
  const unlink = useMutation({
    mutationFn: () => unlinkMattermost(),
    onSuccess: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: ['account', 'mattermost'] })
    },
  })

  return (
    <section aria-labelledby="set-mm">
      <SectionHeading level={2}>
        <span id="set-mm">Mattermost</span>
      </SectionHeading>
      {mm.isPending && !mm.data ? (
        <div className="skeleton h-20" />
      ) : mm.isError && !mm.data ? (
        <SectionError error={mm.error} what="your Mattermost link" onRetry={() => void mm.refetch()} />
      ) : mm.data?.linked ? (
        <Card className="flex flex-wrap items-center gap-3 px-4 py-4">
          <Badge tone="live">Connected</Badge>
          <span className="flex-1 text-base font-semibold">
            {mm.data.username ?? 'your account'}
          </span>
          <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        </Card>
      ) : (
        <Card className="px-4 py-4">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Connect Mattermost so the assistant can send you a DM there.
          </p>
          {/* A real link: this starts an OAuth redirect off-site, which a fetch cannot do. */}
          <a
            href="/auth/settings/mattermost/connect"
            className="mt-3 inline-flex min-h-10 items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 text-sm font-semibold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
          >
            Connect Mattermost
          </a>
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Disconnect Mattermost?"
        body="The assistant will not be able to DM you there any more. You can reconnect later."
        confirmLabel="Disconnect it"
        pending={unlink.isPending}
        onConfirm={() => unlink.mutate()}
      />
    </section>
  )
}

function McpSection() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const mcp = useQuery({
    queryKey: ['account', 'mcp'],
    queryFn: ({ signal }) => getMcpStatus(signal),
    ...CACHE.static,
  })
  const revoke = useMutation({
    mutationFn: () => revokeMcp(),
    onSuccess: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: ['account', 'mcp'] })
    },
  })

  return (
    <section aria-labelledby="set-mcp">
      <SectionHeading level={2} hint="for Claude and other MCP clients">
        <span id="set-mcp">AI tool access</span>
      </SectionHeading>
      {mcp.isPending && !mcp.data ? (
        <div className="skeleton h-20" />
      ) : mcp.isError && !mcp.data ? (
        <SectionError error={mcp.error} what="your MCP access" onRetry={() => void mcp.refetch()} />
      ) : (
        <Card className="px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            {mcp.data?.active ? <Badge tone="live">Active</Badge> : <Badge tone="neutral">Not connected</Badge>}
            <span className="flex-1 text-sm text-[var(--color-fg-muted)]">
              {mcp.data?.active
                ? mcp.data.lastUsedAt
                  ? <>Last used <RelativeTime at={mcp.data.lastUsedAt * 1000} /></>
                  : 'Never used yet'
                : 'No MCP client is connected to your account.'}
            </span>
            {mcp.data?.active && (
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Revoke access
              </Button>
            )}
          </div>
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">
            Connect a client with{' '}
            <code className="font-[family-name:var(--font-mono)] text-xs text-[var(--color-fg)]">
              claude mcp add --transport http crcmz https://app.crcmz.me/mcp
            </code>
            . It will bring you here to sign in and approve it.
          </p>
        </Card>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Revoke AI tool access?"
        body="Every MCP client connected to your account stops working immediately and has to be re-approved."
        confirmLabel="Revoke it"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      />
    </section>
  )
}

/**
 * Passkeys: list and delete here, register in the classic interface.
 *
 * Registration is a WebAuthn ceremony with base64url challenge encoding on both legs. A
 * subtle mistake there produces a credential that silently cannot be used to sign in,
 * which is not something to ship without being able to test it on real hardware. Listing
 * and deleting are ordinary JSON calls and are safe to move.
 */
function PasskeySection() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<{ id: string; name: string } | null>(null)
  const keys = useQuery({
    queryKey: ['account', 'passkeys'],
    queryFn: ({ signal }) => getPasskeys(signal),
    ...CACHE.static,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deletePasskey(id),
    onSuccess: () => {
      setConfirming(null)
      void queryClient.invalidateQueries({ queryKey: ['account', 'passkeys'] })
    },
  })

  return (
    <section aria-labelledby="set-passkeys">
      <SectionHeading level={2}>
        <span id="set-passkeys">Passkeys</span>
      </SectionHeading>
      {keys.isPending && !keys.data ? (
        <div className="skeleton h-20" />
      ) : keys.isError && !keys.data ? (
        <SectionError error={keys.error} what="your passkeys" onRetry={() => void keys.refetch()} />
      ) : (
        <Card className="px-4 py-4">
          {(keys.data ?? []).length === 0 ? (
            <p className="text-sm text-[var(--color-fg-muted)]">
              No passkeys yet. A passkey lets you sign in with Face ID, Touch ID or a
              security key instead of a password.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {(keys.data ?? []).map(k => (
                <li
                  key={k.id}
                  className="flex items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-3 py-2.5"
                >
                  <span aria-hidden="true">🔑</span>
                  <span className="flex-1 text-sm font-semibold">{k.name}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirming({ id: k.id, name: k.name })}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-[var(--color-fg-subtle)]">
            Adding a passkey still happens in the classic interface —{' '}
            <a href="/?p=squad" className="font-semibold text-[var(--color-accent-text)] hover:underline">
              open it there
            </a>
            .
          </p>
        </Card>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={open => !open && setConfirming(null)}
        title="Remove this passkey?"
        body={
          <>
            <strong className="text-[var(--color-fg)]">{confirming?.name}</strong> will no
            longer sign you in. Make sure you have another way in first.
          </>
        }
        confirmLabel="Remove it"
        pending={remove.isPending}
        onConfirm={() => confirming && remove.mutate(confirming.id)}
      />
    </section>
  )
}

function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const mismatch = confirm.length > 0 && next !== confirm
  const tooShort = next.length > 0 && next.length < 8
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm

  const change = useMutation({
    mutationFn: () => setPassword(current, next),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirm('')
      setNote({ tone: 'ok', text: 'Password changed.' })
    },
    onError: err => setNote({ tone: 'err', text: errorMessage(err) }),
  })

  return (
    <section aria-labelledby="set-password">
      <SectionHeading level={2}>
        <span id="set-password">Password</span>
      </SectionHeading>
      <Card className="px-4 py-4">
        {/* A real form, so password managers recognise it and Enter submits. */}
        <form
          onSubmit={e => {
            e.preventDefault()
            if (canSubmit && !change.isPending) {
              setNote(null)
              change.mutate()
            }
          }}
          className="flex flex-col gap-3"
        >
          <TextField
            id="pw-current"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={e => setCurrent(e.target.value)}
          />
          <TextField
            id="pw-new"
            label="New password"
            type="password"
            autoComplete="new-password"
            hint="At least 8 characters."
            error={tooShort ? 'That is shorter than 8 characters.' : null}
            value={next}
            onChange={e => setNext(e.target.value)}
          />
          <TextField
            id="pw-confirm"
            label="New password again"
            type="password"
            autoComplete="new-password"
            error={mismatch ? 'These do not match.' : null}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
          {note && (
            <p
              role="status"
              aria-live="polite"
              className={cx(
                'text-sm',
                note.tone === 'ok' ? 'text-[var(--color-live-text)]' : 'text-[var(--color-danger-text)]',
              )}
            >
              {note.text}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            className="self-start"
            disabled={!canSubmit}
            pending={change.isPending}
            pendingLabel="Changing…"
          >
            Change password
          </Button>
        </form>
      </Card>
    </section>
  )
}
