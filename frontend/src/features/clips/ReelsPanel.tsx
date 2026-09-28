import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { CACHE } from '@/app/queryClient'
import { to } from '@/app/routes'
import {
  getReels,
  getRender,
  renderVideoUrl,
  saveOverride,
  sourceVideoUrl,
  startRender,
  unvetoClip,
  vetoClip,
} from '@/lib/api/reels'
import type { CropMode, ReelClip, RenderRequest } from '@/lib/api/reels'
import { errorMessage } from '@/lib/api/http'
import { Badge, Button, Card, SectionHeading, cx } from '@/components/ui'
import { EmptyState, RelativeTime, SectionError, SkeletonRows } from '@/components/ui/states'
import { ConfirmDialog } from '@/components/ui/overlay'

/**
 * Your highlight-eligible clips, as the reel pipeline will cut them.
 *
 * Only the signed-in person's clips come back (the server matches the Zitadel account's
 * PSN id to the clip sender). Admins get a toggle for everyone's. Vetoes and saved
 * overrides are read by the pipeline on its next poll, so the copy says "next run"
 * rather than implying the change is instant.
 */
export function ReelsPanel({ showAll, onShowAll }: { showAll: boolean; onShowAll: (v: boolean) => void }) {
  const reels = useQuery({
    queryKey: ['reels', showAll],
    queryFn: ({ signal }) => getReels(showAll, signal),
    ...CACHE.clips,
  })

  const data = reels.data
  const rows = data?.clips ?? []

  return (
    <section aria-labelledby="my-reels">
      <SectionHeading
        level={2}
        hint={data?.source === 'mirror' ? 'Pipeline roster not received yet — showing a best-effort list' : undefined}
        action={
          data?.me.admin && (
            <Button variant="ghost" size="sm" onClick={() => onShowAll(!showAll)}>
              {showAll ? 'Only mine' : 'Everyone’s (admin)'}
            </Button>
          )
        }
      >
        <span id="my-reels">{showAll ? 'All reels' : 'Your reels'}</span>
      </SectionHeading>

      {reels.isPending && !data ? (
        <SkeletonRows rows={3} />
      ) : reels.isError && !data ? (
        <SectionError error={reels.error} what="your reels" onRetry={() => void reels.refetch()} />
      ) : data?.needsPsnLink ? (
        <Card>
          <EmptyState
            title="Link your PlayStation account"
            body="Reels are matched to you by PSN ID. Link it in Settings and your clips show up here."
            action={<Link className="font-semibold underline" to={to('settings')}>Open Settings</Link>}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No reels waiting"
            body={
              <>
                Clips you share in the PSN group that are 60 seconds or shorter show up here
                before they go into highlights{data?.me.psnId ? <> (matched to <strong>{data.me.psnId}</strong>)</> : null}.
              </>
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {rows.map(c => (
            <ReelCard key={c.clipId} clip={c} showSender={showAll} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ReelCard({ clip, showSender }: { clip: ReelClip; showSender: boolean }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [confirmVeto, setConfirmVeto] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [pendingRid, setPendingRid] = useState<string | null>(null)
  const [shownRid, setShownRid] = useState<string | null>(clip.latestRenderId)

  useEffect(() => {
    if (!pendingRid) setShownRid(clip.latestRenderId)
  }, [clip.latestRenderId, pendingRid])

  const base = clip.override
  const [form, setForm] = useState<RenderRequest>(() => ({
    windowStart: base?.windowStart ?? clip.analysisWindow?.[0] ?? null,
    windowEnd: base?.windowEnd ?? clip.analysisWindow?.[1] ?? null,
    cropMode: base?.cropMode ?? 'ai',
    label: base?.label ?? clip.featuredLabel ?? null,
  }))

  const refresh = () => qc.invalidateQueries({ queryKey: ['reels'] })

  const job = useQuery({
    queryKey: ['reel-render', pendingRid],
    queryFn: ({ signal }) => getRender(pendingRid as string, signal),
    enabled: Boolean(pendingRid),
    refetchInterval: q => (q.state.data && ['done', 'error'].includes(q.state.data.status) ? false : 3_000),
    staleTime: 0,
  })

  useEffect(() => {
    const j = job.data
    if (!pendingRid || !j || j.id !== pendingRid) return
    if (j.status === 'done') {
      setShownRid(j.id)
      setShowOriginal(false)
      setPendingRid(null)
      setNote({ tone: 'ok', text: 'New cut is ready.' })
      void refresh()
    } else if (j.status === 'error') {
      setPendingRid(null)
      setNote({ tone: 'err', text: `Render failed${j.error ? `: ${j.error}` : ''}` })
    }
  }, [job.data, pendingRid])

  const render = useMutation({
    mutationFn: (req: RenderRequest) => startRender(clip.clipId, req),
    onSuccess: r => {
      setNote(null)
      if (r?.render_id) setPendingRid(r.render_id)
    },
    onError: err => setNote({ tone: 'err', text: errorMessage(err) }),
  })

  const save = useMutation({
    mutationFn: () => saveOverride(clip.clipId, form),
    onSuccess: () => {
      setNote({ tone: 'ok', text: 'Saved. The pipeline uses these settings on its next run.' })
      void refresh()
    },
    onError: err => setNote({ tone: 'err', text: errorMessage(err) }),
  })

  const veto = useMutation({
    mutationFn: () => (clip.vetoed ? unvetoClip(clip.clipId) : vetoClip(clip.clipId, '')),
    onSuccess: () => {
      setConfirmVeto(false)
      setNote({
        tone: 'ok',
        text: clip.vetoed ? 'Back in the running for highlights.' : 'Vetoed. It will not appear in any highlight reel.',
      })
      void refresh()
    },
    onError: err => {
      setConfirmVeto(false)
      setNote({ tone: 'err', text: errorMessage(err) })
    },
  })

  const rendering = render.isPending || Boolean(pendingRid)
  const videoSrc = showOriginal || !shownRid ? sourceVideoUrl(clip.clipId) : renderVideoUrl(shownRid)
  const windowInvalid =
    form.windowStart !== null && form.windowEnd !== null && form.windowEnd <= form.windowStart

  return (
    <Card as="li" className={cx('flex flex-col gap-3 px-3.5 py-3', clip.vetoed && 'opacity-70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-bold">
            {showSender ? clip.sender : clip.game ?? 'Clip'}
          </p>
          <p className="text-xs text-[var(--color-fg-subtle)]">
            {clip.when ? <RelativeTime at={clip.when} /> : 'time unknown'}
            {clip.duration !== null && <> · {Math.round(clip.duration)}s</>}
            {showSender && clip.game && <> · {clip.game}</>}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {clip.vetoed && <Badge tone="danger">Vetoed</Badge>}
          {clip.override && <Badge tone="accent">Your edit</Badge>}
          {clip.hasAnalysis ? <Badge tone="live">AI ready</Badge> : <Badge tone="neutral">No AI yet</Badge>}
        </div>
      </div>

      {clip.message && <p className="line-clamp-2 text-sm text-[var(--color-fg-muted)]">{clip.message}</p>}

      <div className="relative mx-auto w-full max-w-[260px] overflow-hidden rounded-[var(--radius-md)] bg-black">
        <video
          key={videoSrc}
          src={videoSrc}
          controls
          playsInline
          preload="metadata"
          className={cx('w-full', showOriginal || !shownRid ? 'aspect-video' : 'aspect-[9/16]')}
        />
        {rendering && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-black/65 px-4 text-center text-sm text-white"
          >
            Cutting your reel… this takes 1–3 minutes.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {shownRid ? (
          <button type="button" className="underline" onClick={() => setShowOriginal(v => !v)}>
            {showOriginal ? 'Show the reel cut' : 'Show the original'}
          </button>
        ) : (
          <span className="text-[var(--color-fg-subtle)]">No reel cut yet — showing the original.</span>
        )}
      </div>

      {editing && (
        <div className="grid grid-cols-2 gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-3">
          <NumberField
            id={`ws-${clip.clipId}`}
            label="Start (s)"
            value={form.windowStart}
            onChange={v => setForm(f => ({ ...f, windowStart: v }))}
          />
          <NumberField
            id={`we-${clip.clipId}`}
            label="End (s)"
            value={form.windowEnd}
            onChange={v => setForm(f => ({ ...f, windowEnd: v }))}
          />
          <div className="col-span-2 flex flex-col gap-1">
            <label htmlFor={`crop-${clip.clipId}`} className="text-xs font-semibold text-[var(--color-fg-subtle)]">
              Crop
            </label>
            <select
              id={`crop-${clip.clipId}`}
              value={form.cropMode}
              onChange={e => setForm(f => ({ ...f, cropMode: e.target.value as CropMode }))}
              className="min-h-9 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface-1)] px-2 text-sm"
            >
              <option value="ai">Follow the action (AI)</option>
              <option value="center">Fixed center</option>
            </select>
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <label htmlFor={`label-${clip.clipId}`} className="text-xs font-semibold text-[var(--color-fg-subtle)]">
              Player label
            </label>
            <input
              id={`label-${clip.clipId}`}
              value={form.label ?? ''}
              maxLength={60}
              onChange={e => setForm(f => ({ ...f, label: e.target.value || null }))}
              className="min-h-9 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface-1)] px-2 text-sm"
            />
          </div>
          {clip.analysisWindow && (
            <p className="col-span-2 text-2xs text-[var(--color-fg-subtle)]">
              AI picked {clip.analysisWindow[0].toFixed(1)}s–{clip.analysisWindow[1].toFixed(1)}s.
            </p>
          )}
          {windowInvalid && (
            <p className="col-span-2 text-xs text-[var(--color-danger-text)]">End has to be after start.</p>
          )}
          <div className="col-span-2 flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={windowInvalid || rendering}
              pending={render.isPending}
              onClick={() => render.mutate(form)}
            >
              Preview cut
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={windowInvalid}
              pending={save.isPending}
              pendingLabel="Saving…"
              onClick={() => save.mutate()}
            >
              Use for highlights
            </Button>
          </div>
        </div>
      )}

      {note && (
        <p
          role="status"
          aria-live="polite"
          className={cx('text-xs', note.tone === 'ok' ? 'text-[var(--color-live-text)]' : 'text-[var(--color-danger-text)]')}
        >
          {note.text}
        </p>
      )}

      <div className="mt-auto flex flex-wrap justify-end gap-2 pt-1">
        {!shownRid && !editing && (
          <Button size="sm" variant="secondary" pending={rendering} disabled={rendering} onClick={() => render.mutate(form)}>
            Make the AI cut
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing(v => !v)} aria-expanded={editing}>
          {editing ? 'Done adjusting' : 'Adjust'}
        </Button>
        <Button
          size="sm"
          variant={clip.vetoed ? 'secondary' : 'danger'}
          pending={veto.isPending}
          onClick={() => (clip.vetoed ? veto.mutate() : setConfirmVeto(true))}
        >
          {clip.vetoed ? 'Undo veto' : 'Veto'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmVeto}
        onOpenChange={setConfirmVeto}
        title="Keep this clip out of highlights?"
        body="It won’t be used in the fire, fail, or daily reels. You can undo this until the pipeline’s next run."
        confirmLabel="Veto it"
        pending={veto.isPending}
        onConfirm={() => veto.mutate()}
      />
    </Card>
  )
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: number | null
  onChange: (v: number | null) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold text-[var(--color-fg-subtle)]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={0.1}
        value={value ?? ''}
        onChange={e => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
        className="min-h-9 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface-1)] px-2 text-sm"
      />
    </div>
  )
}
