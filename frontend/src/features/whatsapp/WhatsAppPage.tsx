import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { CACHE } from '@/app/queryClient'
import {
  RANGES,
  customRangeError,
  exportUrl,
  getAwards,
  getCanImport,
  getEmojis,
  getMembers,
  getStats,
  importChat,
  importSizeError,
} from '@/lib/api/whatsapp'
import type { Range, RangeValue } from '@/lib/api/whatsapp'
import { errorMessage } from '@/lib/api/http'
import { Badge, Card, SectionHeading, TextField, cx } from '@/components/ui'
import { EmptyState, SectionError, SkeletonRows, SkeletonTiles } from '@/components/ui/states'
import { PageTitle } from '@/components/PageTitle'

/**
 * WhatsApp analytics.
 *
 * The range is the whole screen's state and it lives in the URL, so a view is shareable
 * and Back returns to the previous range instead of the previous page.
 *
 * Each section is its own query, keyed by range. That is what fixes the legacy race:
 * there, all nine requests were one `Promise.all` writing into one `innerHTML`, so
 * "all time" — nine aggregates over ~10k rows — could finish after a quicker range
 * picked later and overwrite it. Here a response can only ever be written into the cache
 * entry for the range that asked for it, so a stale one is inert.
 */
export function WhatsAppPage() {
  const [params, setParams] = useSearchParams()

  const rangeParam = params.get('range')
  const range: RangeValue = RANGES.some(r => r.value === rangeParam)
    ? (rangeParam as RangeValue)
    : 'all_time'
  const start = params.get('start') ?? ''
  const end = params.get('end') ?? ''

  // A custom range with a missing or backwards pair is not sent at all — the backend
  // would silently widen it to everything, which looks like the filter being ignored.
  const customError = range === 'custom' ? customRangeError(start, end) : null
  const active: Range = { range, ...(range === 'custom' ? { start, end } : {}) }
  const enabled = customError === null

  const stats = useQuery({
    queryKey: ['wa', 'stats', active],
    queryFn: ({ signal }) => getStats(active, signal),
    ...CACHE.analytics,
    enabled,
  })
  const members = useQuery({
    queryKey: ['wa', 'members', active],
    queryFn: ({ signal }) => getMembers(active, signal),
    ...CACHE.analytics,
    enabled,
  })
  const awards = useQuery({
    queryKey: ['wa', 'awards', active],
    queryFn: ({ signal }) => getAwards(active, signal),
    ...CACHE.analytics,
    enabled,
  })
  const emojis = useQuery({
    queryKey: ['wa', 'emojis', active],
    queryFn: ({ signal }) => getEmojis(active, signal),
    ...CACHE.analytics,
    enabled,
  })
  const canImport = useQuery({
    queryKey: ['wa', 'can-import'],
    queryFn: ({ signal }) => getCanImport(signal),
    ...CACHE.static,
  })

  function setRange(next: RangeValue) {
    const p = new URLSearchParams(params)
    p.set('range', next)
    if (next !== 'custom') {
      p.delete('start')
      p.delete('end')
    }
    setParams(p, { replace: true })
  }

  function setBound(which: 'start' | 'end', value: string) {
    const p = new URLSearchParams(params)
    p.set('range', 'custom')
    if (value) p.set(which, value)
    else p.delete(which)
    setParams(p, { replace: true })
  }

  const noData = stats.data !== undefined && stats.data.totalMessages === 0

  return (
    <div className="mx-auto w-full max-w-[var(--content-width)]">
      <PageTitle
        title="WhatsApp"
        subtitle="What the group chat has been up to."
        action={
          enabled && !noData ? (
            // A download, so a real link: fetching it into memory to re-offer it as a
            // blob would break on a large export for no benefit.
            <a
              href={exportUrl(active)}
              download
              className="inline-flex min-h-10 items-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-4 text-sm font-semibold hover:bg-[var(--color-surface-3)]"
            >
              Export to Excel
            </a>
          ) : null
        }
      />

      {/* ── Range ────────────────────────────────────────────────────────── */}
      <fieldset className="mb-5">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-subtle)]">
          Time range
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map(r => (
            <button
              key={r.value}
              type="button"
              // aria-pressed, so a screen reader knows which one is chosen. The legacy
              // version signalled it with a CSS class only.
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
              className={cx(
                'min-h-9 rounded-[var(--radius-full)] border px-3.5 text-sm font-semibold',
                range === r.value
                  ? 'border-[var(--color-accent)]/60 bg-[var(--color-accent-subtle)] text-[var(--color-accent-text)]'
                  : 'border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-3)]',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        {range === 'custom' && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div className="w-[170px]">
              <TextField
                id="wa-start"
                label="From"
                type="date"
                value={start}
                onChange={e => setBound('start', e.target.value)}
              />
            </div>
            <div className="w-[170px]">
              <TextField
                id="wa-end"
                label="To"
                type="date"
                value={end}
                onChange={e => setBound('end', e.target.value)}
                error={customError}
              />
            </div>
          </div>
        )}
      </fieldset>

      {!enabled ? (
        <Card>
          <EmptyState title="Pick a date range" body={customError ?? undefined} />
        </Card>
      ) : (
        <>
          {/* ── Totals ───────────────────────────────────────────────────── */}
          <section aria-labelledby="wa-totals" className="mb-7">
            <SectionHeading level={2}>
              <span id="wa-totals">Totals</span>
            </SectionHeading>
            {stats.isPending && !stats.data ? (
              <SkeletonTiles count={5} />
            ) : stats.isError && !stats.data ? (
              <SectionError error={stats.error} what="the totals" onRetry={() => void stats.refetch()} />
            ) : noData ? (
              <Card>
                <EmptyState
                  title="No messages in this range"
                  body={
                    canImport.data?.canImport
                      ? 'Import a chat export below, or pick a wider range.'
                      : 'Pick a wider range, or ask an admin to import the chat history.'
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]">
                <Tile label="Messages" value={compact(stats.data?.totalMessages ?? 0)} />
                <Tile label="People" value={String(stats.data?.totalMembers ?? 0)} />
                <Tile label="Videos" value={compact(stats.data?.totalVideos ?? 0)} />
                <Tile label="Photos" value={compact(stats.data?.totalPhotos ?? 0)} />
                <Tile label="Days talking" value={compact(stats.data?.conversationDays ?? 0)} />
              </div>
            )}
          </section>

          {!noData && (
            <>
              {/* ── Awards ───────────────────────────────────────────────── */}
              <section aria-labelledby="wa-awards" className="mb-7">
                <SectionHeading level={2}>
                  <span id="wa-awards">Awards</span>
                </SectionHeading>
                {awards.isPending && !awards.data ? (
                  <SkeletonTiles count={6} />
                ) : awards.isError && !awards.data ? (
                  // Independent failure: the members table below still renders.
                  <SectionError error={awards.error} what="the awards" onRetry={() => void awards.refetch()} />
                ) : (awards.data ?? []).length === 0 ? (
                  <Card>
                    <EmptyState title="Not enough messages in this range to hand out awards" />
                  </Card>
                ) : (
                  <ul className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
                    {(awards.data ?? []).map(a => (
                      <Card as="li" key={a.key} className="px-3.5 py-3">
                        <p className="text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
                          {a.title}
                        </p>
                        <p className="mt-0.5 truncate text-base font-bold">{a.winner}</p>
                        {a.detail && (
                          <p className="text-xs text-[var(--color-fg-muted)]">{a.detail}</p>
                        )}
                      </Card>
                    ))}
                  </ul>
                )}
              </section>

              {/* ── Who talks ────────────────────────────────────────────── */}
              <section aria-labelledby="wa-members" className="mb-7">
                <SectionHeading level={2}>
                  <span id="wa-members">Who talks</span>
                </SectionHeading>
                {members.isPending && !members.data ? (
                  <SkeletonRows rows={5} />
                ) : members.isError && !members.data ? (
                  <SectionError error={members.error} what="member activity" onRetry={() => void members.refetch()} />
                ) : (
                  <MemberTable rows={members.data ?? []} />
                )}
              </section>

              {/* ── Emoji ────────────────────────────────────────────────── */}
              {(emojis.data ?? []).length > 0 && (
                <section aria-labelledby="wa-emoji" className="mb-7">
                  <SectionHeading level={2}>
                    <span id="wa-emoji">Emoji</span>
                  </SectionHeading>
                  <ul className="flex flex-wrap gap-2">
                    {(emojis.data ?? []).slice(0, 14).map(e => (
                      <Card as="li" key={e.emoji} className="flex items-center gap-2 px-3 py-2">
                        <span className="text-xl" aria-hidden="true">
                          {e.emoji}
                        </span>
                        <span className="numeral text-sm text-[var(--color-warn-text)]">
                          {compact(e.count)}
                        </span>
                      </Card>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </>
      )}

      {/* ── Import ───────────────────────────────────────────────────────── */}
      {canImport.data?.canImport && <ImportSection />}
    </div>
  )
}

function MemberTable({ rows }: { rows: import('@/lib/api/whatsapp').MemberRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title="Nobody said anything in this range" />
      </Card>
    )
  }
  const max = Math.max(...rows.map(r => r.messages), 1)
  return (
    <Card className="overflow-hidden">
      {/* A real table: the relationship between a name and its numbers is data, and a
          screen reader needs the headers to read a cell usefully.
          tabIndex + a label on the scroll container, because on a phone this scrolls
          sideways and without them a keyboard user cannot reach the right-hand columns
          at all (WCAG 2.1.1; axe calls it scrollable-region-focusable). */}
      <div
        className="overflow-x-auto focus-visible:outline-2"
        tabIndex={0}
        role="group"
        aria-label="Member activity table, scrolls sideways"
      >
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <caption className="sr-only">Messages, words and average words per message, per person</caption>
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th scope="col" className="px-3.5 py-2.5 font-semibold text-[var(--color-fg-subtle)]">
                Person
              </th>
              <th scope="col" className="px-3.5 py-2.5 text-right font-semibold text-[var(--color-fg-subtle)]">
                Messages
              </th>
              <th scope="col" className="px-3.5 py-2.5 text-right font-semibold text-[var(--color-fg-subtle)]">
                Words
              </th>
              <th scope="col" className="px-3.5 py-2.5 text-right font-semibold text-[var(--color-fg-subtle)]">
                Avg / msg
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name} className="border-b border-[var(--color-border)] last:border-0">
                <th scope="row" className="px-3.5 py-2.5 text-left font-semibold">
                  <span className="mr-2 text-[var(--color-fg-subtle)]">{i + 1}</span>
                  {r.name}
                  <span
                    aria-hidden="true"
                    className="mt-1 block h-1 rounded-[var(--radius-full)] bg-[var(--color-accent)]"
                    style={{ width: `${Math.round((r.messages / max) * 100)}%` }}
                  />
                </th>
                <td className="numeral px-3.5 py-2.5 text-right">{compact(r.messages)}</td>
                <td className="numeral px-3.5 py-2.5 text-right text-[var(--color-fg-muted)]">
                  {compact(r.totalWords)}
                </td>
                <td className="numeral px-3.5 py-2.5 text-right text-[var(--color-fg-muted)]">
                  {r.avgWordsPerMsg}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/**
 * Chat history import.
 *
 * Only rendered when /api/whatsapp/can-import says so — which checks a Zitadel role
 * server-side. The endpoint enforces it regardless; this just avoids offering a control
 * that would 403.
 *
 * The size check happens before upload because the interesting failure is invisible
 * otherwise: an export "with media" is hundreds of megabytes, Cloudflare rejects it at
 * the edge with an HTML page, and the app never sees the request at all. Saying "over
 * 100 MB, export without media" beats surfacing a parse error.
 */
function ImportSection() {
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  const upload = useMutation({
    mutationFn: (file: File) => importChat(file),
    onSuccess: result => {
      setNote({
        tone: 'ok',
        text:
          result.status === 'already_imported'
            ? `Already imported — ${result.messageCount} messages on file.`
            : `Imported ${result.messageCount} messages (${result.duplicateCount} duplicates skipped).`,
      })
      // Every range's aggregates are now wrong.
      void queryClient.invalidateQueries({ queryKey: ['wa'] })
    },
    onError: err => setNote({ tone: 'err', text: errorMessage(err) }),
    onSettled: () => {
      // Reset, or picking the same file again fires no change event.
      if (fileRef.current) fileRef.current.value = ''
    },
  })

  return (
    <section aria-labelledby="wa-import" className="mb-4">
      <SectionHeading level={2} action={<Badge tone="accent">Admin</Badge>}>
        <span id="wa-import">Import chat history</span>
      </SectionHeading>
      <Card className="px-4 py-4">
        <p className="text-sm text-[var(--color-fg-muted)]">
          Export the group in WhatsApp with <strong>Without media</strong> and upload the{' '}
          <code className="font-[family-name:var(--font-mono)]">.txt</code> or{' '}
          <code className="font-[family-name:var(--font-mono)]">.zip</code>. Messages
          already on file are skipped, so re-importing is safe.
        </p>
        <label
          className={cx(
            'mt-3 inline-flex min-h-[var(--tap-target)] cursor-pointer items-center rounded-[var(--radius-md)]',
            'border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-4',
            'text-sm font-semibold hover:bg-[var(--color-surface-3)]',
            upload.isPending && 'pointer-events-none opacity-60',
          )}
        >
          {upload.isPending ? 'Uploading…' : 'Choose export file'}
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.zip,text/plain,application/zip"
            className="sr-only"
            disabled={upload.isPending}
            onChange={e => {
              const file = e.target.files?.[0]
              if (!file) return
              setNote(null)
              const sizeError = importSizeError(file.size)
              if (sizeError) {
                setNote({ tone: 'err', text: sizeError })
                if (fileRef.current) fileRef.current.value = ''
                return
              }
              upload.mutate(file)
            }}
          />
        </label>
        {note && (
          <p
            role="status"
            aria-live="polite"
            className={cx(
              'mt-2.5 text-sm',
              note.tone === 'ok' ? 'text-[var(--color-live-text)]' : 'text-[var(--color-danger-text)]',
            )}
          >
            {note.text}
          </p>
        )}
      </Card>
    </section>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-3.5 py-3 text-center">
      <p className="numeral text-xl">{value}</p>
      <p className="mt-0.5 text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </p>
    </Card>
  )
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
