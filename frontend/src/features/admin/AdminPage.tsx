import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CACHE } from '@/app/queryClient'
import { getUsers, resetUserPassword } from '@/lib/api/account'
import { getPipelineStatus } from '@/lib/api/clips'
import type { ServiceHealth } from '@/lib/api/clips'
import { errorMessage } from '@/lib/api/http'
import { Badge, Button, Card, SectionHeading, TextField, cx } from '@/components/ui'
import { EmptyState, Freshness, RelativeTime, SectionError } from '@/components/ui/states'
import { Modal } from '@/components/ui/overlay'
import { PageTitle } from '@/components/PageTitle'

/**
 * Operations and user management.
 *
 * This is where the service-health table went. The legacy Clips tab opened with it —
 * versions, last ping, queue depths — so the first thing a member saw when they wanted to
 * watch a clip was infrastructure. Members now get a plain "this is affected" message on
 * the screen that is affected; the detail lives here.
 *
 * Reaching this route needs `is_admin` from the session probe, but that is only about
 * discoverability. Every endpoint below re-checks the caller's Zitadel role server-side,
 * so someone who typed the URL gets 403s and an empty screen rather than anything real.
 */
export function AdminPage() {
  return (
    <div className="mx-auto w-full max-w-[var(--content-width)]">
      <PageTitle title="Admin" subtitle="Service health and accounts." />
      <div className="flex flex-col gap-8">
        <PipelineSection />
        <UsersSection />
      </div>
    </div>
  )
}

function PipelineSection() {
  const pipeline = useQuery({
    queryKey: ['pipeline'],
    queryFn: ({ signal }) => getPipelineStatus(signal),
    ...CACHE.diagnostics,
  })

  return (
    <section aria-labelledby="adm-pipeline">
      <SectionHeading
        level={2}
        hint={<Freshness at={pipeline.dataUpdatedAt || null} stale={pipeline.isError && Boolean(pipeline.data)} />}
      >
        <span id="adm-pipeline">Pipeline</span>
      </SectionHeading>
      {pipeline.isPending && !pipeline.data ? (
        <div className="skeleton h-28" />
      ) : pipeline.isError && !pipeline.data ? (
        <SectionError error={pipeline.error} what="pipeline status" onRetry={() => void pipeline.refetch()} />
      ) : (pipeline.data?.services ?? []).length === 0 ? (
        <Card>
          <EmptyState title="No services reported" />
        </Card>
      ) : (
        <ul className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
          {(pipeline.data?.services ?? []).map(s => (
            <ServiceCard key={s.name} service={s} />
          ))}
        </ul>
      )}

      {pipeline.data && (
        <Card className="mt-3 flex flex-wrap gap-x-8 gap-y-3 px-4 py-3.5">
          <Metric label="Clips this month" value={pipeline.data.clipsThisMonth ?? '—'} />
          <Metric
            label="Last clip"
            value={pipeline.data.lastClipAt ? <RelativeTime at={pipeline.data.lastClipAt * 1000} /> : '—'}
          />
          <Metric label="Next montage" value={pipeline.data.nextBuildLabel ?? pipeline.data.nextBuildMonth ?? '—'} />
          <Metric label="Last montage" value={pipeline.data.lastMontage?.status ?? '—'} />
        </Card>
      )}
    </section>
  )
}

function ServiceCard({ service }: { service: ServiceHealth }) {
  const ok = /^(ok|up|healthy)$/i.test(service.status)
  return (
    <Card as="li" className="px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-[family-name:var(--font-mono)] text-sm font-semibold">
          {service.name}
        </p>
        <Badge tone={ok ? 'live' : 'danger'}>{service.status}</Badge>
      </div>
      <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
        {service.version && <>v{service.version}</>}
        {service.at && (
          <>
            {service.version ? ' · ' : ''}
            <RelativeTime at={service.at * 1000} />
          </>
        )}
        {!service.version && !service.at && 'no detail reported'}
      </p>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  )
}

function UsersSection() {
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: ({ signal }) => getUsers(signal),
    ...CACHE.static,
  })
  const [resetting, setResetting] = useState<{ id: string; label: string } | null>(null)

  return (
    <section aria-labelledby="adm-users">
      <SectionHeading level={2} hint={users.data ? `${users.data.length} accounts` : undefined}>
        <span id="adm-users">Accounts</span>
      </SectionHeading>
      {users.isPending && !users.data ? (
        <div className="skeleton h-40" />
      ) : users.isError && !users.data ? (
        <SectionError error={users.error} what="the account list" onRetry={() => void users.refetch()} />
      ) : (users.data ?? []).length === 0 ? (
        <Card>
          <EmptyState title="No accounts returned" body="Zitadel may not be configured on this instance." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul>
            {(users.data ?? []).map(u => {
              const active = u.state === 'USER_STATE_ACTIVE'
              return (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] px-3.5 py-2.5 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {u.displayName || u.email || u.id}
                    </p>
                    {u.email && u.displayName && (
                      <p className="truncate text-xs text-[var(--color-fg-subtle)]">
                        {u.email}
                      </p>
                    )}
                  </div>
                  {!active && u.state && (
                    <Badge tone="warn">{u.state.replace('USER_STATE_', '').toLowerCase()}</Badge>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setResetting({ id: u.id, label: u.displayName || u.email || u.id })}
                  >
                    Reset password
                  </Button>
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {resetting && (
        <ResetPasswordDialog
          userId={resetting.id}
          label={resetting.label}
          onClose={() => setResetting(null)}
        />
      )}
    </section>
  )
}

/**
 * Admin password reset.
 *
 * Typed twice and shown as a plain field, because an admin setting someone else's
 * password needs to be able to read what they are about to hand over. The server enforces
 * the 8-character minimum; it is checked here too so the error arrives before the
 * request.
 */
function ResetPasswordDialog({
  userId,
  label,
  onClose,
}: {
  userId: string
  label: string
  onClose: () => void
}) {
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const tooShort = pw.length > 0 && pw.length < 8
  const mismatch = again.length > 0 && pw !== again
  const canSubmit = pw.length >= 8 && pw === again

  const reset = useMutation({
    mutationFn: () => resetUserPassword(userId, pw),
    onSuccess: () => {
      setNote({ tone: 'ok', text: `Password set for ${label}. Pass it on securely.` })
      setPw('')
      setAgain('')
    },
    onError: err => setNote({ tone: 'err', text: errorMessage(err) }),
  })

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title="Reset password"
      description={`For ${label}`}
      width="sm"
      footer={
        <Button
          variant="primary"
          disabled={!canSubmit}
          pending={reset.isPending}
          pendingLabel="Setting…"
          onClick={() => {
            setNote(null)
            reset.mutate()
          }}
        >
          Set the password
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          id="adm-pw"
          label="New password"
          type="text"
          autoComplete="off"
          hint="At least 8 characters. Shown in plain text so you can copy it accurately."
          error={tooShort ? 'That is shorter than 8 characters.' : null}
          value={pw}
          onChange={e => setPw(e.target.value)}
        />
        <TextField
          id="adm-pw-again"
          label="Type it again"
          type="text"
          autoComplete="off"
          error={mismatch ? 'These do not match.' : null}
          value={again}
          onChange={e => setAgain(e.target.value)}
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
      </div>
    </Modal>
  )
}
