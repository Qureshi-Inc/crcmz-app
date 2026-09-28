import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { CACHE } from '@/app/queryClient'
import { getClips, getPipelineStatus, resendClip } from '@/lib/api/clips'
import type { Clip, PipelineStatus } from '@/lib/api/clips'
import { NetworkError, errorMessage } from '@/lib/api/http'
import { Badge, Button, Card, SectionHeading, cx } from '@/components/ui'
import {
  EmptyState,
  Freshness,
  RelativeTime,
  SectionError,
  SkeletonRows,
  StaleNotice,
} from '@/components/ui/states'
import { ConfirmDialog } from '@/components/ui/overlay'
import { PageTitle } from '@/components/PageTitle'

/**
 * Clips and montages.
 *
 * The legacy Clips tab opened with a table of service versions and last-ping times.
 * Clips come first here; the service table moved to Admin, and members get the montage
 * summary instead — which is the part that affects them.
 *
 * On playback: there is no endpoint that serves clip bytes or a thumbnail (see the note
 * at the top of lib/api/clips.ts). Rather than render a player against a URL that does
 * not exist, this screen says so once and shows the metadata that is real.
 *
 * Filters live in the URL, so a filtered view is shareable, survives a refresh, and
 * Back returns to the previous filter rather than the previous page.
 */
export function ClipsPage() {
  const [params, setParams] = useSearchParams()
  const month = params.get('month') ?? ''
  const sender = params.get('sender') ?? ''
  const status = params.get('status') ?? ''

  const filters = useMemo(
    () => ({
      ...(month ? { month } : {}),
      ...(sender ? { sender } : {}),
      ...(status ? { status } : {}),
      limit: 60,
    }),
    [month, sender, status],
  )

  const clips = useQuery({
    // The filters are part of the key, so a response for an old filter can never be
    // written into the current view — the cache is keyed by what was asked for.
    queryKey: ['clips', filters],
    queryFn: ({ signal }) => getClips(filters, signal),
    ...CACHE.clips,
  })

  const pipeline = useQuery({
    queryKey: ['pipeline'],
    queryFn: ({ signal }) => getPipelineStatus(signal),
    ...CACHE.clips,
  })

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    // replace: tweaking a filter should not fill history with one entry per keystroke.
    setParams(next, { replace: true })
  }

  const rows = clips.data?.clips ?? []
  const stale = clips.isError && Boolean(clips.data)

  // Senders and months for the filter menus, from what is actually loaded. Not a
  // separate endpoint: there is not one, and inventing the options would let the user
  // pick a filter that returns nothing.
  const senders = useMemo(
    () => [...new Set(rows.map(c => c.sender))].sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  return (
    <div className="mx-auto w-full max-w-[var(--content-width-wide)]">
      <PageTitle
        title="Clips"
        subtitle={clips.data ? `${clips.data.count} clip${clips.data.count === 1 ? '' : 's'}` : undefined}
        meta={<Freshness at={clips.dataUpdatedAt || null} stale={stale} />}
      />

      {stale && <div className="mb-4"><StaleNotice onRetry={() => void clips.refetch()} /></div>}

      {/* ── Montage ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="montage" className="mb-7">
        <SectionHeading level={2}>
          <span id="montage">Montage</span>
        </SectionHeading>
        {pipeline.isPending && !pipeline.data ? (
          <div className="skeleton h-[96px]" />
        ) : pipeline.isError && !pipeline.data ? (
          // A secondary section failing must not take the clip list with it.
          <SectionError error={pipeline.error} what="the montage status" onRetry={() => void pipeline.refetch()} />
        ) : (
          <MontageCard data={pipeline.data} />
        )}
      </section>

      {/* ── Filters ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="clip-list">
        <SectionHeading level={2}>
          <span id="clip-list">Every clip</span>
        </SectionHeading>

        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Select
            id="filter-month"
            label="Month"
            value={month}
            onChange={v => setFilter('month', v)}
            options={[{ value: '', label: 'Any month' }, ...monthOptions()]}
          />
          <Select
            id="filter-sender"
            label="Sender"
            value={sender}
            onChange={v => setFilter('sender', v)}
            options={[
              { value: '', label: 'Anyone' },
              ...senders.map(s => ({ value: s, label: s })),
            ]}
          />
          <Select
            id="filter-status"
            label="Status"
            value={status}
            onChange={v => setFilter('status', v)}
            options={[
              { value: '', label: 'Any status' },
              { value: 'sent', label: 'Sent' },
              { value: 'discovered', label: 'Discovered' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
          {(month || sender || status) && (
            <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </Button>
          )}
        </div>

        <NoPlaybackNotice />

        {clips.isPending && !clips.data ? (
          <SkeletonRows rows={6} />
        ) : clips.isError && !clips.data ? (
          <SectionError error={clips.error} what="clips" onRetry={() => void clips.refetch()} />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              title={month || sender || status ? 'Nothing matches those filters' : 'No clips yet'}
              body={
                month || sender || status
                  ? 'Try widening the filters — there may be clips outside this month or from someone else.'
                  : 'Clips appear here automatically when someone shares one in the PSN group.'
              }
              action={
                (month || sender || status) && (
                  <Button variant="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                    Clear filters
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <ul className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(330px,1fr))]">
            {rows.map(c => (
              <ClipCard key={c.uid} clip={c} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * Said once, plainly, instead of six broken video elements.
 *
 * This is a real gap, not a design choice, so it names the missing piece — otherwise the
 * next person to read the screen assumes playback was dropped on purpose.
 */
function NoPlaybackNotice() {
  return (
    <div
      className={cx(
        'mb-4 rounded-[var(--radius-md)] border border-[var(--color-border-strong)]',
        'bg-[var(--color-surface-1)] px-3.5 py-2.5 text-sm text-[var(--color-fg-muted)]',
      )}
    >
      <strong className="font-semibold text-[var(--color-fg)]">Clips are not playable here.</strong>{' '}
      The app stores every clip in S3 and forwards it to WhatsApp, but it has no endpoint
      that serves the video or a thumbnail to a browser. Watch them in the group chat;
      this page is for finding them and re-sending one.
    </div>
  )
}

function MontageCard({ data }: { data: PipelineStatus | undefined }) {
  if (!data) return null
  const lm = data.lastMontage
  return (
    <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 px-4 py-4">
      <Stat label="Clips this month" value={data.clipsThisMonth === null ? '—' : String(data.clipsThisMonth)} />
      <Stat
        label="Latest clip"
        value={data.lastClipAt ? '' : '—'}
        detail={
          data.lastClipAt ? (
            <>
              <RelativeTime at={data.lastClipAt * 1000} />
              {data.lastClipSender && <> · {data.lastClipSender}</>}
            </>
          ) : null
        }
      />
      <Stat
        label="Last montage"
        value={lm?.month ?? '—'}
        detail={lm?.status ? <>{lm.status}{lm.duration ? ` · ${formatDuration(lm.duration)}` : ''}</> : null}
      />
      <Stat
        label="Next build"
        value={data.nextBuildLabel ?? data.nextBuildMonth ?? '—'}
        detail={data.nextBuildTs ? <RelativeTime at={data.nextBuildTs * 1000} /> : null}
      />
    </Card>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </p>
      {value && <p className="numeral text-lg">{value}</p>}
      {detail && <p className="text-sm text-[var(--color-fg-muted)]">{detail}</p>}
    </div>
  )
}

function ClipCard({ clip }: { clip: Clip }) {
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  const resend = useMutation({
    mutationFn: () => resendClip(clip.uid),
    onSuccess: () => {
      setConfirming(false)
      setNote({ tone: 'ok', text: 'Queued for re-sending to WhatsApp.' })
    },
    onError: err => {
      setConfirming(false)
      if (err instanceof NetworkError && err.uncertain) {
        // Re-sending posts a video to a real group. "Might have worked" has to be said,
        // because the obvious response to "failed" is to press it again.
        setNote({ tone: 'warn', text: 'Might have been queued — check the group before re-sending.' })
      } else {
        setNote({ tone: 'err', text: errorMessage(err) })
      }
    },
  })

  return (
    <Card as="li" className="flex flex-col gap-2.5 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-bold">{clip.sender}</p>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            {clip.createdAt ? <RelativeTime at={clip.createdAt * 1000} /> : 'time unknown'}
            {clip.durationSeconds !== null && <> · {formatDuration(clip.durationSeconds)}</>}
            {clip.width && clip.height && <> · {clip.width}×{clip.height}</>}
          </p>
        </div>
        <StatusBadge clip={clip} />
      </div>

      {clip.body && (
        <p className="line-clamp-2 text-sm text-[var(--color-fg-muted)]">{clip.body}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {clip.montageId ? (
          <Badge tone="accent">In a montage</Badge>
        ) : clip.montageEligible ? (
          <Badge tone="neutral">Montage eligible</Badge>
        ) : (
          <Badge tone="neutral">Not in the montage</Badge>
        )}
        {clip.whatsappDeliveredAt && <Badge tone="live">Sent to WhatsApp</Badge>}
        {clip.fileSize && (
          <span className="text-xs text-[var(--color-fg-subtle)]">
            {formatBytes(clip.fileSize)}
          </span>
        )}
      </div>

      {clip.lastError && (
        <p className="text-xs text-[var(--color-danger-text)]">
          Last error: {clip.lastError}
        </p>
      )}

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

      <div className="mt-auto flex justify-end pt-1">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setConfirming(true)}
          pending={resend.isPending}
          pendingLabel="Queuing…"
        >
          Re-send to WhatsApp
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Re-send this clip?"
        body={
          <>
            The group will get {clip.sender}&rsquo;s clip again. There is no way to unsend
            it.
          </>
        }
        confirmLabel="Re-send it"
        pending={resend.isPending}
        onConfirm={() => resend.mutate()}
      />
    </Card>
  )
}

function StatusBadge({ clip }: { clip: Clip }) {
  const tone = clip.status === 'sent' ? 'live' : clip.status === 'failed' ? 'danger' : 'neutral'
  return <Badge tone={tone}>{clip.status}</Badge>
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-[var(--color-fg-subtle)]">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={cx(
          'min-h-10 rounded-[var(--radius-md)] border border-[var(--color-border-strong)]',
          'bg-[var(--color-surface-2)] px-3 pr-8 text-sm text-[var(--color-fg)]',
        )}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/** The last 12 months, newest first, as the backend's 'YYYY-MM'. */
function monthOptions() {
  const out: { value: string; label: string }[] = []
  const d = new Date()
  for (let i = 0; i < 12; i++) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push({ value, label: d.toLocaleString(undefined, { month: 'long', year: 'numeric' }) })
    d.setMonth(d.getMonth() - 1)
  }
  return out
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
