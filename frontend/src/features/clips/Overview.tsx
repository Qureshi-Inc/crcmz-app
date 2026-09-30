// PS-2 Overview: My reels (CL-07–11), This month / Montage / Clips this month
// (CL-03–05, DS-CL-MO) and Your uploads (CL-27). Sections fold, and remember it.
import { useMemo, useState, type ReactNode } from 'react'
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ErrorStrip, SkeletonRows, SlowLoad, StaleMarker, useNow, useStale } from '../../components/states'
import { toast } from '../../components/toast'
import { ApiError, request } from '../../lib/http'
import { readLocal, useDesktop, writeLocal } from '../../lib/media'
import {
  fmtAgo, fmtCountdown, fmtDuration, pipeText, PIPE_TONE, PIPELINE_MS, reelFrame, reelSource, useReels, useUploads, whenTs,
  type PipelineStatus, type Reel, type ReelsResponse, type Upload,
} from '../../lib/clips'
import { ClipSheet, ConfirmDialog } from './ClipSheet'
import { SendVideoCard } from './SendVideo'

const STUDIO_HREF = '/?p=pipeline'
const PORTAL_HREF = '/portal'

export function Overview({ status, focusUpload, onFocused, onSendVideo }: {
  status: UseQueryResult<PipelineStatus>; focusUpload: boolean; onFocused: () => void; onSendVideo: () => void
}) {
  const desktop = useDesktop()
  return (
    <div className="clips-overview">
      <div className="clips-col clips-col-reels"><ReelsSection /></div>
      <div className="clips-col clips-col-month">
        <ThisMonth q={status} />
        <MontageCard q={status} />
        <Manifest q={status} />
      </div>
      <div className="clips-col clips-col-uploads">
        {desktop && <SendVideoCard focus={focusUpload} onFocused={onFocused} />}
        <UploadsSection onSendVideo={onSendVideo} />
      </div>
    </div>
  )
}

// ── Folding section with a persisted open state (CL-02) ───────────────────────
function Fold({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  const key = `clips.fold.${id}`
  const [open, setOpen] = useState(() => readLocal<boolean>(key, true))
  return (
    <details className="glass fold" open={open} onToggle={(e) => { const v = e.currentTarget.open; setOpen(v); writeLocal(key, v) }}>
      <summary className="fold-head">
        <h2 className="section-h2">{title}</h2>
        {count !== undefined && <span className="fold-count num">{count}</span>}
        <span className="fold-chev" aria-hidden="true" />
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  )
}

// ── My reels ─────────────────────────────────────────────────────────────────
type ReelFilter = 'all' | 'noreview' | 'rendered' | 'vetoed'
const FILTERS: [ReelFilter, string][] = [['all', 'All'], ['noreview', 'Needs review'], ['rendered', 'Rendered'], ['vetoed', '🛑 Vetoed']]
const matches = (f: ReelFilter, c: Reel) =>
  f === 'vetoed' ? Boolean(c.vetoed) : f === 'noreview' ? !c.vetoed && !c.override : f === 'rendered' ? Boolean(c.has_render) : true

function ReelsSection() {
  const desktop = useDesktop()
  const [all, setAll] = useState(false)
  const [filter, setFilter] = useState<ReelFilter>('all')
  const [limit, setLimit] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const q = useReels(all)
  const qc = useQueryClient()
  const d = q.data
  const clips = d?.clips ?? []
  const page = desktop ? 24 : 12
  const items = clips.filter((c) => matches(filter, c))
  const shown = items.slice(0, limit || page)
  const open = clips.find((c) => c.clip_id === openId) ?? null

  async function sync() {
    if (syncing) return
    setSyncing(true)
    try {
      await request('/api/reels/sync', { method: 'POST', body: {}, timeoutMs: 60_000 })
      await qc.invalidateQueries({ queryKey: ['reels'] })
      toast('Synced.', 'success')
    } catch {
      toast("Sync didn't finish. Reel review may be busy — try again.", 'error')
    } finally {
      setSyncing(false)
    }
  }

  const title = d?.scope === 'all' ? 'All reels' : 'My reels'
  return (
    <Fold id="reels" title={title} count={d && !d.needs_psn_link ? clips.length : undefined}>
      {q.isPending ? (
        <><SkeletonRows n={4} height={84} /><SlowLoad onRetry={() => q.refetch()} /></>
      ) : !d ? (
        <ErrorStrip text={reelsError(q.error)} onRetry={() => q.refetch()} />
      ) : d.needs_psn_link ? (
        <div className="empty">
          <p style={{ margin: 0 }}>Link your PlayStation account — reels are matched to you by PSN ID.</p>
          <a className="btn btn-secondary" href={PORTAL_HREF}>Link PSN</a>
        </div>
      ) : (
        <>
          <div className="reel-tools">
            {d.me?.admin && (
              <button type="button" className="btn btn-secondary" aria-pressed={all} onClick={() => { setAll(!all); setLimit(0) }}>
                {all ? 'Mine' : "Everyone's"}
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={sync} aria-busy={syncing || undefined} aria-disabled={syncing || undefined}>
              {syncing ? 'Syncing…' : '↻ Sync'}
            </button>
          </div>
          <div className="chips" role="group" aria-label="Filter reels">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => { setFilter(k); setLimit(0) }}>
                {label} <span className="num chip-n">{clips.filter((c) => matches(k, c)).length}</span>
              </button>
            ))}
          </div>
          {clips.length === 0 ? (
            <div className="empty"><p style={{ margin: 0 }}>Post a clip in the PSN group, then ↻ Sync</p></div>
          ) : items.length === 0 ? (
            <div className="empty"><p style={{ margin: 0 }}>No reels match this filter.</p></div>
          ) : (
            <ul className="reel-grid">
              {shown.map((c) => (
                <li key={c.clip_id}><ReelCard reel={c} scope={d.scope} onOpen={() => setOpenId(c.clip_id)} /></li>
              ))}
            </ul>
          )}
          {items.length > shown.length && (
            <button type="button" className="btn btn-secondary show-more" onClick={() => setLimit((limit || page) * 2)}>
              Show more · {items.length - shown.length} left
            </button>
          )}
        </>
      )}
      <ReelSheet reel={open} scope={d?.scope ?? 'mine'} onClose={() => setOpenId(null)} />
    </Fold>
  )
}

function reelsError(e: unknown): string {
  if (e instanceof ApiError && (e.status === 502 || e.status === 503)) return 'Reel review is unreachable'
  return "Reels didn't load"
}

const reelTitle = (c: Reel, scope: ReelsResponse['scope']) =>
  `${scope === 'all' ? c.sender || '?' : c.game || c.sender || 'Clip'} · ${fmtDuration(c.duration)}`

function Badges({ c }: { c: Reel }) {
  const p = c.pipeline
  const msg = c.message || ''
  return (
    <span className="badges">
      {p?.state && <span className="badge" data-tone={PIPE_TONE[p.state] ?? 'dim'}>{pipeText(p)}</span>}
      {c.has_render && <span className="badge" data-tone="cyan">Rendered</span>}
      {Boolean(c.override) && <span className="badge" data-tone="live">Approved</span>}
      {c.vetoed && p?.state !== 'vetoed' && <span className="badge" data-tone="warn">🛑 Vetoed</span>}
      {msg.includes('🔥') && p?.state !== 'fire' && <span className="badge" data-tone="accent">🔥 fire</span>}
    </span>
  )
}

function ReelCard({ reel: c, scope, onOpen }: { reel: Reel; scope: ReelsResponse['scope']; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const ts = whenTs(c.when)
  return (
    <button type="button" className="reel-card" onClick={onOpen}>
      <span className="reel-thumb">
        {!broken && <img src={reelFrame(c)} alt="" loading="lazy" onError={() => setBroken(true)} />}
        <span className="reel-dur num">{fmtDuration(c.duration)}</span>
      </span>
      <span className="reel-info">
        <span className="reel-t">{reelTitle(c, scope)}</span>
        <span className="meta">{[ts ? fmtAgo(ts) : '', c.message ? c.message.slice(0, 40) : ''].filter(Boolean).join(' · ')}</span>
        <Badges c={c} />
      </span>
    </button>
  )
}

function ReelSheet({ reel, scope, onClose }: { reel: Reel | null; scope: ReelsResponse['scope']; onClose: () => void }) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState<Reel | null>(reel)
  if (reel && reel !== shown) { setShown(reel); setFailed(false) }
  const c = reel ?? shown
  const title = c ? reelTitle(c, scope) : ''

  async function veto(on: boolean) {
    if (!c || busy) return
    setBusy(true)
    try {
      await request(`/api/reels/clips/${encodeURIComponent(c.clip_id)}/veto`, on ? { method: 'POST', body: { reason: '' } } : { method: 'DELETE' })
      await qc.invalidateQueries({ queryKey: ['reels'] })
      toast(on ? 'Vetoed. It stays out of the montage.' : 'Veto lifted.', 'success')
    } catch {
      toast(on ? "The veto didn't save. Try again." : "The veto wasn't lifted. Try again.", 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ClipSheet open={reel !== null} onOpenChange={(v) => { if (!v) onClose() }} title={title}>
      {c && (
        <div className="clip-detail">
          {failed ? (
            <div className="player-gone"><p style={{ margin: 0 }}>Video unavailable</p></div>
          ) : (
            <video className="player" key={c.clip_id} src={reelSource(c)} poster={reelFrame(c)} controls playsInline preload="metadata" onError={() => setFailed(true)} />
          )}
          <Badges c={c} />
          {c.message && <p style={{ margin: 0 }}>{c.message}</p>}
          <div className="detail-actions">
            <a className="btn btn-primary" href={STUDIO_HREF}>Edit in the Studio</a>
            {c.vetoed ? (
              <button type="button" className="btn btn-secondary" onClick={() => veto(false)} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Lift veto'}</button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)} aria-busy={busy || undefined}>{busy ? 'Saving…' : '🛑 Veto'}</button>
            )}
          </div>
          <p className="meta" style={{ margin: 0 }}>The Studio opens in the classic app, under My reels.</p>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Veto this reel?"
        body={<p style={{ margin: 0 }}>Veto '{title}'? It won't be included in the montage.</p>}
        action="Veto"
        onConfirm={() => veto(true)}
      />
    </ClipSheet>
  )
}

// ── This month · Montage · Clips this month (DS-CL-MO) ───────────────────────
export function useCountdown(ts: number | null | undefined) {
  const now = useNow(30_000)
  return fmtCountdown(ts, now)
}

function ThisMonth({ q }: { q: UseQueryResult<PipelineStatus> }) {
  const { stale, minutes } = useStale(q, PIPELINE_MS)
  const s = q.data
  const left = useCountdown(s?.next_build_ts)
  return (
    <section className="glass month-card" aria-labelledby="month-h">
      <div className="card-head">
        <h2 id="month-h" className="section-h2">This month</h2>
        {stale && <StaleMarker minutes={minutes} onRetry={() => q.refetch()} />}
      </div>
      <div className="month-body">
        {q.isPending ? (
          <div className="skeleton" style={{ height: 48, width: '50%' }} aria-hidden="true" />
        ) : !s ? (
          <ErrorStrip text="Month stats didn't load" onRetry={() => q.refetch()} />
        ) : (
          <>
            <div className="month-kpi">
              <span className="month-num num">{s.clips_this_month}</span>
              <span className="meta">clips this month</span>
            </div>
            {s.clips_this_month === 0 && <p style={{ margin: 0 }}>No clips yet this month. The montage builds {s.next_build_label}</p>}
            <p className="month-build">
              {left ? <>Build in <b className="gold num">{left}</b></> : 'Building now'}
              {s.next_build_label && <span className="meta"> · {s.next_build_label}</span>}
            </p>
            {s.last_clip_at && <p className="meta" style={{ margin: 0 }}>Latest: {s.last_clip_sender || 'someone'} · {fmtAgo(s.last_clip_at)}</p>}
          </>
        )}
      </div>
    </section>
  )
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function MontageCard({ q }: { q: UseQueryResult<PipelineStatus> }) {
  const s = q.data
  if (!s) return null // This month carries loading and error
  const m = s.last_montage
  return (
    <section className="glass month-card" aria-labelledby="montage-h">
      <div className="card-head"><h2 id="montage-h" className="section-h2">Montage</h2></div>
      <div className="month-body">
        {!m ? (
          <p style={{ margin: 0 }}>No montage yet — build scheduled for {s.next_build_label}</p>
        ) : (
          <>
            <p className="meta" style={{ margin: 0 }}>Last montage · {MONTHS[m.month - 1] ?? ''} {m.year}</p>
            <p className="montage-line num">
              <b>v{m.version}</b> · <b>{m.clips}</b> clips · <b>{fmtDuration(m.duration)}</b>
            </p>
            <p style={{ margin: 0 }}>{m.sent ? <span className="live">✓ Sent</span> : <span className="dim">Pending</span>}</p>
          </>
        )}
      </div>
    </section>
  )
}

function Manifest({ q }: { q: UseQueryResult<PipelineStatus> }) {
  const [all, setAll] = useState(false)
  const rows = q.data?.clips ?? []
  if (!q.data) return null
  const shown = all ? rows : rows.slice(0, 10)
  return (
    <Fold id="manifest" title="Clips this month" count={rows.length}>
      {rows.length === 0 ? (
        <div className="empty"><p className="dim" style={{ margin: 0 }}>Nothing in the manifest yet.</p></div>
      ) : (
        <>
          <ul className="rows">
            {shown.map((c) => (
              <li key={c.uid} className="manifest-row">
                <span className="initial" aria-hidden="true">{(c.sender || '?').slice(0, 1).toUpperCase()}</span>
                <span className="manifest-who">{c.sender || 'Unknown'}</span>
                <span className="num meta">{fmtDuration(c.duration)}</span>
                <span className="manifest-state" data-included={c.included === true ? 'yes' : c.included === false ? 'no' : undefined}>
                  <span className="dot" aria-hidden="true" />
                  {c.included === true ? 'In' : c.included === false ? (c.reason || 'Left out') : 'Not built yet'}
                </span>
              </li>
            ))}
          </ul>
          {rows.length > shown.length && (
            <button type="button" className="btn btn-ghost show-more" onClick={() => setAll(true)}>Show all {rows.length}</button>
          )}
        </>
      )}
    </Fold>
  )
}

// ── Your uploads (CL-27) ─────────────────────────────────────────────────────
const UPLOAD_STATE: Record<string, string> = { queued: 'Queued', posted: 'Posted', skipped: 'Skipped' }
const PLATFORM: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' }

function UploadsSection({ onSendVideo }: { onSendVideo: () => void }) {
  const q = useUploads()
  const list = q.data?.uploads ?? []
  const forbidden = q.error instanceof ApiError && q.error.status === 403
  return (
    <Fold id="uploads" title="Your uploads" count={q.data ? list.length : undefined}>
      {q.isPending ? (
        <SkeletonRows n={2} />
      ) : forbidden ? (
        <div className="empty">
          <p style={{ margin: 0 }}>Link your PlayStation account — uploads are credited to your PSN ID.</p>
          <a className="btn btn-secondary" href={PORTAL_HREF}>Link PSN</a>
        </div>
      ) : !q.data ? (
        <ErrorStrip text="Uploads didn't load" onRetry={() => q.refetch()} />
      ) : list.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing sent yet</p>
          <button type="button" className="btn btn-secondary" onClick={onSendVideo}>Send a video</button>
        </div>
      ) : (
        <ul className="rows">{list.map((u) => <UploadRow key={u.video_post_id} u={u} />)}</ul>
      )}
    </Fold>
  )
}

function UploadRow({ u }: { u: Upload }) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const links = useMemo(() => Object.entries(u.platforms || {}).filter((e): e is [string, { url: string }] => Boolean(e[1]?.url)), [u.platforms])
  // Withdraw only before any platform has it (the server enforces the same).
  const canWithdraw = u.status === 'queued' && !Object.values(u.platforms || {}).some(Boolean)
  const name = u.caption || u.filename || 'this video'

  async function withdraw() {
    if (busy) return
    setBusy(true)
    try {
      await request('/api/video-uploads/withdraw', { body: { video_post_id: u.video_post_id } })
      await qc.invalidateQueries({ queryKey: ['uploads'] })
      toast("Withdrawn. It won't be posted.", 'success')
    } catch (e) {
      const posting = e instanceof ApiError && e.status === 409
      toast(posting ? "Too late — it's already being posted." : "The withdraw didn't go through. Try again.", 'error')
      if (posting) void qc.invalidateQueries({ queryKey: ['uploads'] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="upload-row">
      <div className="upload-main">
        <span className="upload-title">{u.caption || u.filename || 'Video'}</span>
        <span className="meta">{fmtAgo(u.uploaded_at)}{u.duration_seconds ? ` · ${fmtDuration(u.duration_seconds)}` : ''}</span>
        {u.status === 'skipped' && u.skip_reason && <span className="meta">{u.skip_reason}</span>}
        {links.length > 0 && (
          <span className="upload-links">
            {links.map(([p, v]) => <a key={p} href={v.url} target="_blank" rel="noreferrer">{PLATFORM[p] ?? p} ↗</a>)}
          </span>
        )}
        {canWithdraw && (
          <button type="button" className="btn btn-ghost upload-wd" onClick={() => setConfirm(true)} aria-busy={busy || undefined}>
            {busy ? 'Withdrawing…' : 'Withdraw'}
          </button>
        )}
      </div>
      <span className="badge" data-tone={u.status === 'posted' ? 'live' : u.status === 'queued' ? 'gold' : 'dim'}>{UPLOAD_STATE[u.status] ?? u.status}</span>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Withdraw this video?"
        body={<p style={{ margin: 0 }}>Withdraw '{name}'? It won't be posted.</p>}
        action="Withdraw"
        onConfirm={withdraw}
      />
    </li>
  )
}
