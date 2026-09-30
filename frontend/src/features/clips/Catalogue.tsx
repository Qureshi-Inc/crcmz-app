// PS-2 All clips: the catalogue with month / sender / status filters kept in the
// URL (CL-14–17), the clip sheet with the player (CL-18, B-1) and the admin-only
// re-send to WhatsApp (CL-20, B-3, F-0: one request, never retried).
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorStrip, SkeletonRows, SlowLoad } from '../../components/states'
import { toast } from '../../components/toast'
import { sendOnce, UNKNOWN_INLINE } from '../../lib/send'
import {
  CLIP_STATUS, clipMedia, fmtBytes, fmtDate, fmtDuration, useClipCatalogue, useClipDetail,
  type Clip, type ClipFilters,
} from '../../lib/clips'
import { ClipSheet, ConfirmDialog } from './ClipSheet'

const STATUSES = ['delivered', 'archived', 'discovered', 'failed']

function lastMonths(n: number): { value: string; label: string }[] {
  const out = []
  const d = new Date()
  d.setDate(1)
  for (let i = 0; i < n; i++) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push({ value, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) })
    d.setMonth(d.getMonth() - 1)
  }
  return out
}

const clipTitle = (c: Clip) => `${c.sender_online_id || 'Unknown'} · ${fmtDuration(c.duration_seconds)}`

export function Catalogue({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams()
  const f: ClipFilters = { month: params.get('month') ?? '', sender: params.get('sender') ?? '', status: params.get('status') ?? '' }
  const q = useClipCatalogue(f)
  const months = useMemo(() => lastMonths(12), [])
  const [openUid, setOpenUid] = useState<string | null>(null)
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.clips) ?? [], [q.data])
  // The sender list comes from what is loaded; the one in the URL always stays selectable.
  const senders = useMemo(() => {
    const s = new Set(rows.map((r) => r.sender_online_id).filter((x): x is string => Boolean(x)))
    if (f.sender) s.add(f.sender)
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [rows, f.sender])
  const filtered = Boolean(f.month || f.sender || f.status)

  function set(key: keyof ClipFilters, value: string) {
    setParams((p) => {
      const n = new URLSearchParams(p)
      if (value) n.set(key, value); else n.delete(key)
      return n
    }, { replace: true })
  }
  function clear() {
    setParams((p) => {
      const n = new URLSearchParams(p)
      n.delete('month'); n.delete('sender'); n.delete('status')
      return n
    }, { replace: true })
  }

  return (
    <section className="glass catalogue" aria-label="All clips">
      <div className="cat-filters">
        <label className="cat-filter">
          <span className="meta">Month</span>
          <select className="input" value={f.month} onChange={(e) => set('month', e.target.value)}>
            <option value="">Any month</option>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label className="cat-filter">
          <span className="meta">Sender</span>
          <select className="input" value={f.sender} onChange={(e) => set('sender', e.target.value)}>
            <option value="">Anyone</option>
            {senders.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="cat-filter">
          <span className="meta">Status</span>
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{CLIP_STATUS[s]}</option>)}
          </select>
        </label>
      </div>
      {q.isPending ? (
        <div style={{ padding: 'var(--space-3) var(--space-4)' }}><SkeletonRows n={6} /><SlowLoad onRetry={() => q.refetch()} /></div>
      ) : q.isError && rows.length === 0 ? (
        <div style={{ padding: 'var(--space-3) var(--space-4)' }}><ErrorStrip text="Clips didn't load" onRetry={() => q.refetch()} /></div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p className="empty-title">{filtered ? 'No clips match' : 'No clips yet'}</p>
          {filtered && <button type="button" className="btn btn-secondary" onClick={clear}>Clear filters</button>}
        </div>
      ) : (
        <>
          <ul className="rows" aria-busy={q.isFetching || undefined}>
            {rows.map((c) => (
              <li key={c.message_uid}>
                <button type="button" className="clip-row" onClick={() => setOpenUid(c.message_uid)}>
                  <span className="clip-row-main">
                    <span className="clip-row-t">{clipTitle(c)}</span>
                    <span className="meta">{[fmtDate(c.psn_created_at), c.game_name].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="badge" data-tone={statusTone(c.status)}>{CLIP_STATUS[c.status] ?? c.status}</span>
                </button>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
              <button type="button" className="btn btn-secondary show-more" onClick={() => q.fetchNextPage()} aria-busy={q.isFetchingNextPage || undefined}>
                {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
      <ClipDetail uid={openUid} row={rows.find((r) => r.message_uid === openUid) ?? null} isAdmin={isAdmin} onClose={() => setOpenUid(null)} />
    </section>
  )
}

const statusTone = (s: string) => (s === 'delivered' ? 'live' : s === 'failed' ? 'accent' : s === 'archived' ? 'cyan' : 'dim')

function ClipDetail({ uid, row, isAdmin, onClose }: { uid: string | null; row: Clip | null; isAdmin: boolean; onClose: () => void }) {
  const d = useClipDetail(uid)
  const [last, setLast] = useState<Clip | null>(row)
  if (row && row !== last) setLast(row)
  const c = d.data ?? row ?? last
  const [broken, setBroken] = useState<string | null>(null)
  const archived = c?.archive_status
  return (
    <ClipSheet open={uid !== null} onOpenChange={(v) => { if (!v) onClose() }} title={c ? clipTitle(c) : 'Clip'}>
      {c && (
        <div className="clip-detail">
          {archived === 'purged' ? (
            <div className="player-gone"><p style={{ margin: 0 }}>Media cleared after the 14-day retention.</p></div>
          ) : archived && archived !== 'archived' ? (
            <div className="player-gone"><p style={{ margin: 0 }}>This clip isn't archived yet, so there's nothing to play.</p></div>
          ) : broken === c.message_uid ? (
            <div className="player-gone"><p style={{ margin: 0 }}>Couldn't load this clip.</p></div>
          ) : (
            <video
              className="player" key={c.message_uid} src={clipMedia(c.message_uid)}
              controls playsInline preload="metadata" onError={() => setBroken(c.message_uid)}
            />
          )}
          <dl className="meta-list">
            <dt>Status</dt><dd>{CLIP_STATUS[c.status] ?? c.status}</dd>
            <dt>Posted</dt><dd>{fmtDate(c.psn_created_at)}</dd>
            {c.game_name && <><dt>Game</dt><dd>{c.game_name}</dd></>}
            <dt>Length</dt><dd className="num">{fmtDuration(c.duration_seconds)}</dd>
            {c.width && c.height && <><dt>Size</dt><dd className="num">{c.width}×{c.height} · {fmtBytes(c.file_size)}</dd></>}
            {c.whatsapp_delivered_at && <><dt>WhatsApp</dt><dd>Sent {fmtDate(c.whatsapp_delivered_at)}</dd></>}
            {c.body && <><dt>Message</dt><dd>{c.body}</dd></>}
            {c.last_error && c.status === 'failed' && <><dt>Error</dt><dd>{c.last_error}</dd></>}
          </dl>
          {isAdmin && <Resend clip={c} />}
        </div>
      )}
    </ClipSheet>
  )
}

type ResendState = { kind: 'idle' | 'sending' | 'sent' | 'hidden' | 'gone' } | { kind: 'error' | 'unknown'; text: string }

function Resend({ clip }: { clip: Clip }) {
  const [confirm, setConfirm] = useState(false)
  const [st, setSt] = useState<ResendState>({ kind: 'idle' })
  const [forUid, setForUid] = useState(clip.message_uid)
  if (forUid !== clip.message_uid) { setForUid(clip.message_uid); setSt({ kind: 'idle' }) }
  const title = clipTitle(clip)
  if (st.kind === 'hidden') return <p className="meta" style={{ margin: 0 }}>Admins only.</p>

  async function go() {
    setSt({ kind: 'sending' })
    const r = await sendOnce(`/api/clips/${encodeURIComponent(clip.message_uid)}/resend`, {}, 190_000)
    if (r.kind === 'sent') { setSt({ kind: 'sent' }); toast('Re-sent to WhatsApp.', 'success'); return }
    if (r.kind === 'unknown') { setSt({ kind: 'unknown', text: UNKNOWN_INLINE }); return }
    if (r.kind === 'slow') { setSt({ kind: 'error', text: `Slow down — try again in ${r.seconds}s.` }); return }
    if (r.status === 403) { setSt({ kind: 'hidden' }); toast('Admins only.', 'error'); return }
    if (r.status === 410) { setSt({ kind: 'gone' }); return }
    const text =
      r.status === 409 ? "This clip isn't archived yet, so there's nothing to send."
        : r.status === 503 ? "The WhatsApp bridge isn't set up right now."
          : r.status === 404 ? 'This clip is no longer in the catalogue.'
            : r.reason ? `Didn't go. ${r.reason}` : "Didn't go."
    setSt({ kind: 'error', text })
  }

  const sending = st.kind === 'sending'
  const gone = st.kind === 'gone' || clip.archive_status === 'purged'
  return (
    <div className="resend">
      <button
        type="button" className="btn btn-secondary"
        aria-disabled={sending || gone || undefined} aria-busy={sending || undefined}
        onClick={() => { if (!sending && !gone) setConfirm(true) }}
      >
        {sending ? 'Re-sending…' : st.kind === 'sent' ? 'Sent ✓ · Re-send again' : 'Re-send to WhatsApp'}
      </button>
      <p className="meta resend-msg" role="status" data-tone={st.kind}>
        {gone ? 'The archived clip is gone from storage.'
          : sending ? 'This can take up to 3 minutes. Keep this open.'
            : st.kind === 'error' || st.kind === 'unknown' ? st.text : ''}
      </p>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Re-send to WhatsApp?"
        body={<p style={{ margin: 0 }}>Re-send '{title}' to the Goopers group? It will appear again even if it was already sent. The send can take up to 3 minutes.</p>}
        action="Re-send"
        onConfirm={go}
      />
    </div>
  )
}
