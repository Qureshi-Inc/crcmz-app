// The notification centre: every alert the app raised for you, newest first, with
// where they go (push lives in Settings; WhatsApp and Mattermost DMs live here).
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
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

export function NotificationsPage() {
  useTitle('Notifications')
  const [source, setSource] = useState('')
  const q = useInbox(source)
  const qc = useQueryClient()
  const navigate = useNavigate()
  useNow(60_000) // keeps "3m" honest
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const unread = q.data?.pages[0]?.unread ?? 0

  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] })
  async function readAll() {
    try { await markRead('all'); await refresh() } catch { toast("Couldn't mark them read", 'error') }
  }
  function open(n: Notice) {
    if (!n.read) markRead([n.id]).then(refresh).catch(() => {})
    navigate(n.url.replace(/^\/app/, '') || '/')
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
        : !items.length ? (
          <p className="notif-empty dim">
            {source === 'slap' ? 'No one has @mentioned you yet. Tag someone in a Slap comment and it shows up for them here.'
              : 'Nothing here yet. Rallies, Watch Parties, Huddles, giveaways, clips and @mentions all land here.'}
          </p>
        ) : (
          <ul className="rows notif-rows">
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" className="notif-row" data-read={n.read} data-personal={n.personal} onClick={() => open(n)}>
                  <span className="notif-icon" aria-hidden="true"><Icon name={ICONS[n.source] ?? 'megaphone'} /></span>
                  <span className="notif-text">
                    <span className="notif-title">{n.title}</span>
                    {n.body && <span className="notif-body">{n.body}</span>}
                  </span>
                  <span className="notif-when meta num"><time dateTime={new Date(n.at).toISOString()}>{ago(n.at)}</time></span>
                  {!n.read && <><span className="notif-dot" aria-hidden="true" /><span className="sr-only">, unread</span></>}
                </button>
              </li>
            ))}
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

/** Where a personal alert goes besides this inbox. */
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
      <p className="dim">Everything lands here. When someone @mentions you, you can also get a DM:</p>
      {ch.isPending ? <SkeletonRows n={2} />
        : ch.isError ? <ErrorStrip text="Couldn't load these" onRetry={() => ch.refetch()} />
        : (
          <fieldset className="push-cats" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="sr-only">Direct messages for @mentions</legend>
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
