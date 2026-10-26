// The notification centre: every alert the app raised for you, newest first.
// Personal alerts (DMs, @mentions, movies) always show individually.
// Broadcast alerts (clips, watch, huddle, etc.) are grouped by category.
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { routerPath } from '../../app/nav'
import { useTitle } from '../../app/title'
import { HelpLink } from '../../components/HelpLink'
import { Icon, type IconName } from '../../components/Icon'
import { ErrorStrip, SkeletonRows, useNow } from '../../components/states'
import { toast } from '../../components/toast'
import { ago, markRead, saveChannels, testDm, useChannels, useInbox, type Notice } from '../../lib/notifications'

const FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'slap', label: 'Mentions' },
  { id: 'squad', label: 'Squad' },
  { id: 'watch', label: 'Watch' },
  { id: 'huddle', label: 'Huddle' },
  { id: 'giveaway', label: 'Giveaway' },
  { id: 'clips', label: 'Clips' },
]
const ICONS: Record<string, IconName> = {
  slap: 'slap', squad: 'squad', watch: 'watch', huddle: 'huddle', giveaway: 'giveaway', clips: 'clips',
}

// ── Grouping ─────────────────────────────────────────────────────────────────
// Personal items (DMs, @mentions, movie alerts) and mentions/notes are never
// grouped — they're user-to-user and need to stand alone. Everything else
// (clips, watch calls, huddle pings, giveaway, squad broadcasts, music) is
// collapsed into one row per category with a count badge.
const GROUPABLE = new Set(['clips', 'watch', 'huddle', 'giveaway', 'music', 'together', 'squad'])
const neverGroup = (n: Notice) => n.personal || n.category === 'mentions' || n.category === 'notes'

const GROUP_TITLE: Record<string, (n: number) => string> = {
  clips:    (n) => `${n} new clip${n > 1 ? 's' : ''} added`,
  watch:    (n) => `${n} Watch Party alert${n > 1 ? 's' : ''}`,
  huddle:   (n) => `${n} Huddle alert${n > 1 ? 's' : ''}`,
  giveaway: (n) => `${n} giveaway update${n > 1 ? 's' : ''}`,
  music:    (n) => `${n} Listen Together update${n > 1 ? 's' : ''}`,
  together: (n) => `${n} Listen Together update${n > 1 ? 's' : ''}`,
  squad:    (n) => `${n} squad update${n > 1 ? 's' : ''}`,
}

type SingleItem = { kind: 'single'; notice: Notice }
type GroupItem  = { kind: 'group';  category: string; source: string; items: Notice[]; latestAt: number }
type DisplayItem = SingleItem | GroupItem

function groupNotifications(notices: Notice[]): DisplayItem[] {
  const categoryBuckets = new Map<string, Notice[]>()
  const singles: Notice[] = []

  for (const n of notices) {
    if (neverGroup(n) || !GROUPABLE.has(n.category)) {
      singles.push(n)
    } else {
      const bucket = categoryBuckets.get(n.category) ?? []
      bucket.push(n)
      categoryBuckets.set(n.category, bucket)
    }
  }

  const result: DisplayItem[] = singles.map((n) => ({ kind: 'single', notice: n }))

  for (const [category, items] of categoryBuckets) {
    const latestAt = Math.max(...items.map((i) => i.at))
    if (items.length === 1) {
      result.push({ kind: 'single', notice: items[0]! })
    } else {
      result.push({ kind: 'group', category, source: items[0]!.source, items, latestAt })
    }
  }

  return result.sort((a, b) => {
    const aT = a.kind === 'single' ? a.notice.at : a.latestAt
    const bT = b.kind === 'single' ? b.notice.at : b.latestAt
    return bT - aT
  })
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function NotificationsPage() {
  useTitle('Notifications')
  const [source, setSource] = useState('')
  const q = useInbox(source)
  const qc = useQueryClient()
  const navigate = useNavigate()
  useNow(60_000)

  const rawItems = q.data?.pages.flatMap((p) => p.items) ?? []
  // Only group when showing "All" — filtered views keep the same grouping logic
  const displayItems = groupNotifications(rawItems)
  const unread = q.data?.pages[0]?.unread ?? 0

  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] })
  async function readAll() {
    try { await markRead('all'); await refresh() } catch { toast("Couldn't mark them read", 'error') }
  }
  function openNotice(n: Notice) {
    if (!n.read) markRead([n.id]).then(refresh).catch(() => {})
    navigate(routerPath(n.url))
  }
  function openGroup(items: Notice[]) {
    const unreadIds = items.filter((n) => !n.read).map((n) => n.id)
    if (unreadIds.length) markRead(unreadIds).then(refresh).catch(() => {})
    // Navigate to the first item's URL
    const first = items[0]
    if (first) navigate(routerPath(first.url))
  }

  return (
    <div className="page notif-page">
      <div className="notif-head">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Notifications<HelpLink id="notifications" /></h1>
          <p className="meta" aria-live="polite">{q.isSuccess ? (unread ? `${unread} unread` : 'All caught up') : ' '}</p>
        </div>
        {unread > 0 && <button type="button" className="btn btn-secondary" onClick={readAll}>Mark all read</button>}
      </div>

      <div className="chips notif-chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id || 'all'} type="button" className="chip" aria-pressed={source === f.id} onClick={() => setSource(f.id)}>{f.label}</button>
        ))}
      </div>

      {q.isPending ? <SkeletonRows n={5} height={64} />
        : q.isError ? <ErrorStrip text="Couldn't load your notifications" onRetry={() => q.refetch()} />
        : !displayItems.length ? (
          <p className="notif-empty dim">
            {source === 'slap' ? 'No one has @mentioned you yet. Tag someone in a Slap comment and it shows up for them here.'
              : 'Nothing here yet. Rallies, Watch Parties, Huddles, giveaways, clips, @mentions and new movies all land here.'}
          </p>
        ) : (
          <ul className="rows notif-rows">
            {displayItems.map((item, i) =>
              item.kind === 'single'
                ? <SingleRow key={item.notice.id} notice={item.notice} onOpen={openNotice} />
                : <GroupRow key={`${item.category}-${i}`} group={item} onOpen={openGroup} />
            )}
          </ul>
        )}
      {q.hasNextPage && (
        <button type="button" className="btn btn-ghost" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
        </button>
      )}

      <Delivery />
    </div>
  )
}

// ── Single notification row ───────────────────────────────────────────────────
function SingleRow({ notice: n, onOpen, indent = false }: { notice: Notice; onOpen: (n: Notice) => void; indent?: boolean }) {
  return (
    <li>
      <button
        type="button"
        className={`notif-row${indent ? ' notif-row-indent' : ''}`}
        data-read={n.read}
        data-personal={n.personal}
        onClick={() => onOpen(n)}
      >
        <span className="notif-icon" aria-hidden="true"><Icon name={ICONS[n.source] ?? 'megaphone'} /></span>
        <span className="notif-text">
          <span className="notif-title">{n.title}</span>
          {n.body && <span className="notif-body">{n.body}</span>}
        </span>
        <span className="notif-when meta num"><time dateTime={new Date(n.at).toISOString()}>{ago(n.at)}</time></span>
        {!n.read && <><span className="notif-dot" aria-hidden="true" /><span className="sr-only">, unread</span></>}
      </button>
    </li>
  )
}

// ── Grouped notification row ──────────────────────────────────────────────────
function GroupRow({ group, onOpen }: { group: GroupItem; onOpen: (items: Notice[]) => void }) {
  const [expanded, setExpanded] = useState(false)
  const anyUnread = group.items.some((n) => !n.read)
  const title = GROUP_TITLE[group.category]?.(group.items.length) ?? `${group.items.length} ${group.category} updates`
  const preview = group.items[0]?.body ?? ''

  function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    setExpanded((v) => !v)
  }

  return (
    <li>
      <div className={`notif-group${expanded ? ' notif-group-open' : ''}`} data-unread={anyUnread}>
        <button type="button" className="notif-row notif-group-row" data-read={!anyUnread} onClick={() => onOpen(group.items)}>
          <span className="notif-icon notif-group-icon" aria-hidden="true">
            <Icon name={ICONS[group.source] ?? 'megaphone'} />
            <span className="notif-group-count" aria-hidden="true">{group.items.length}</span>
          </span>
          <span className="notif-text">
            <span className="notif-title">{title}</span>
            {preview && <span className="notif-body">{preview}</span>}
          </span>
          <span className="notif-when meta num"><time dateTime={new Date(group.latestAt).toISOString()}>{ago(group.latestAt)}</time></span>
          {anyUnread && <><span className="notif-dot" aria-hidden="true" /><span className="sr-only">, unread</span></>}
        </button>
        <button
          type="button"
          className="notif-expand-btn"
          onClick={toggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse group' : `Show ${group.items.length} items`}
        >
          <Icon name={expanded ? 'up' : 'down'} />
        </button>
      </div>
      {expanded && (
        <ul className="notif-group-items">
          {group.items.map((n) => (
            <SingleRow key={n.id} notice={n} onOpen={onOpen.bind(null, [n])} indent />
          ))}
        </ul>
      )}
    </li>
  )
}

// ── Delivery settings ─────────────────────────────────────────────────────────
function Delivery() {
  const ch = useChannels()
  const qc = useQueryClient()
  const [testing, setTesting] = useState(false)
  async function test() {
    setTesting(true)
    try {
      const r = await testDm()
      const sent = Object.entries(r).filter(([, v]) => v === true).map(([k]) => (k === 'whatsapp' ? 'WhatsApp' : 'Mattermost'))
      const failed = Object.entries(r).filter(([, v]) => v === false).map(([k]) => (k === 'whatsapp' ? 'WhatsApp' : 'Mattermost'))
      if (failed.length) toast(`${failed.join(' and ')} didn't go through${sent.length ? `; ${sent.join(' and ')} did` : ''}`, 'error')
      else if (sent.length) toast(`Sent. Check ${sent.join(' and ')}.`, 'success')
      else toast('Nothing to send to: both are off or not linked', 'info')
    } catch { toast("Couldn't send a test", 'error') } finally { setTesting(false) }
  }
  async function set(id: string, on: boolean) {
    qc.setQueryData(['notifications', 'channels'], (d: typeof ch.data) => (d ? { ...d, prefs: { ...d.prefs, [id]: on } } : d))
    try { await saveChannels({ [id]: on }) } catch {
      toast("Couldn't save that", 'error')
      void qc.invalidateQueries({ queryKey: ['notifications', 'channels'] })
    }
  }
  return (
    <section className="glass settings-card notif-delivery" aria-labelledby="notif-where-h">
      <h2 className="section-h2" id="notif-where-h">Where they reach you</h2>
      <p className="dim">Everything lands here. When someone @mentions you, or a movie is added or ready to watch, you can also get a DM:</p>
      {ch.isPending ? <SkeletonRows n={2} />
        : ch.isError ? <ErrorStrip text="Couldn't load these" onRetry={() => ch.refetch()} />
        : (
          <fieldset className="push-cats" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="sr-only">Direct messages for @mentions and movies</legend>
            {ch.data.channels.map((c) => (
              <label key={c.id} className="check-row">
                <input type="checkbox" checked={ch.data.prefs[c.id] !== false} onChange={(e) => { void set(c.id, e.target.checked) }} />
                <span>
                  {c.label}
                  {!ch.data.reachable[c.id] && (
                    <span className="meta notif-unreachable"> · {c.id === 'whatsapp' ? 'no WhatsApp number on your account yet' : 'no Mattermost account linked yet'}</span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        )}
      <div className="notif-delivery-acts">
        <button type="button" className="btn btn-secondary" onClick={() => { void test() }} disabled={testing || ch.isPending}>
          {testing ? 'Sending…' : 'Send me a test DM'}
        </button>
        <Link className="btn btn-ghost" to="/settings/app">Phone and desktop pop-ups</Link>
      </div>
    </section>
  )
}
