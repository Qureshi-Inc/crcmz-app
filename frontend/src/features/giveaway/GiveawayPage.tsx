// PS-5 · Giveaway: am I in, when is the reveal, who won (J9). Admins run the
// month's lifecycle in context below the member view. Rendering never mutates:
// when the reveal time passes, the page only re-fetches.
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { ErrorStrip, StaleMarker, useNow, useStale } from '../../components/states'
import { useAccount } from '../../lib/api'
import { getJSON } from '../../lib/http'
import { readLocal, useDesktop, useReducedMotion, writeLocal } from '../../lib/media'
import {
  countdownLabel, fmtWhen, memberSees, parseWhen, PENDING, revealMs as revealAt, splitMs, type Giveaway, type GwData,
} from '../../lib/giveaway'
import { AdminTools } from './AdminTools'
import { HelpLink } from '../../components/HelpLink'

const POLL_MS = 60_000
/** After the reveal time: 5 s, 15 s, 60 s, then every 60 s until the status moves (F-6). */
const BACKOFF = [5_000, 15_000, 60_000]

export function useGiveaway() {
  return useQuery({ queryKey: ['giveaway'], queryFn: ({ signal }) => getJSON<GwData>('/api/giveaway', signal), refetchInterval: POLL_MS })
}

export function GiveawayPage() {
  useTitle('Giveaway')
  const q = useGiveaway()
  const hist = useQuery({ queryKey: ['giveaway', 'history'], queryFn: ({ signal }) => getJSON<Giveaway[]>('/api/giveaway/history', signal) })
  const desktop = useDesktop()
  const d = q.data
  const admin = Boolean(d?.is_admin)
  const g = d ? memberSees(d.giveaway, admin) : null
  const revealMs = revealAt(g)
  const overdue = useOverdue(g && PENDING.includes(g.status) ? revealMs : null)
  useBackoff(overdue, q.refetch, `${g?.id}:${g?.status}`)
  const { stale, minutes } = useStale(q, POLL_MS)

  return (
    <div className="page">
      <h1 className="page-h1" tabIndex={-1}>Giveaway<HelpLink id="giveaway" /></h1>
      <div className="gw-layout">
        <div className="gw-main">
          {q.data === undefined && q.isError ? (
            <section className="glass gw-hero"><ErrorStrip text="Didn't load" onRetry={() => q.refetch()} /></section>
          ) : !d ? (
            <section className="glass gw-hero" aria-busy="true">
              <div className="skeleton" style={{ height: 22, width: '55%' }} />
              <div className="skeleton" style={{ height: 64, marginTop: 16 }} />
            </section>
          ) : (
            <>
              {stale && <StaleMarker minutes={minutes} onRetry={() => q.refetch()} />}
              <Hero d={d} g={g} revealMs={revealMs} overdue={overdue} />
              {g && <Eligibility d={d} g={g} />}
            </>
          )}
        </div>
        <aside className="gw-side" aria-label="Rotation and past winners">
          {d && <RotationCard r={d.rotation} />}
          <PastWinners q={hist} defaultOpen={desktop} />
        </aside>
      </div>
      {admin && d && <AdminTools d={d} overdue={overdue} defaultOpen={desktop} />}
    </div>
  )
}

/** True once `ms` is in the past; flips on time without re-rendering every second. */
function useOverdue(ms: number | null): boolean {
  const [over, setOver] = useState(() => ms != null && ms <= Date.now())
  useEffect(() => {
    if (ms == null) { setOver(false); return }
    const left = ms - Date.now()
    if (left <= 0) { setOver(true); return }
    setOver(false)
    const t = window.setTimeout(() => setOver(true), Math.min(left, 2 ** 31 - 1))
    return () => window.clearTimeout(t)
  }, [ms])
  return over
}

function useBackoff(on: boolean, refetch: () => unknown, key: string) {
  useEffect(() => {
    if (!on) return
    let i = 0
    let t = 0
    const tick = () => {
      t = window.setTimeout(() => { void refetch(); i += 1; tick() }, BACKOFF[Math.min(i, BACKOFF.length - 1)])
    }
    tick()
    return () => window.clearTimeout(t)
  }, [on, refetch, key])
}

function Hero({ d, g, revealMs, overdue }: { d: GwData; g: Giveaway | null; revealMs: number | null; overdue: boolean }) {
  if (!g) {
    return (
      <section className="glass gw-hero" aria-labelledby="gw-h">
        <h2 className="gw-title" id="gw-h">No giveaway running right now.</h2>
        <p className="dim">The next one shows up here.</p>
        {d.is_admin && <p className="meta">Start one from Admin tools below.</p>}
      </section>
    )
  }
  if (g.status === 'revealed' || g.status === 'closed') {
    const winner = g.active_draw?.winner_name
    return (
      <section className="glass gw-hero gw-hero-won" aria-labelledby="gw-h">
        <p className="gw-kicker">{g.title || 'Giveaway'}{g.status === 'closed' ? ' · Closed' : ''}</p>
        <h2 className="gw-title gw-winner" id="gw-h"><span aria-hidden="true">🏆 </span>{winner || 'Winner'}</h2>
        <p className="gw-prize"><span aria-hidden="true">🎁 </span>{g.prize || 'Prize TBD'}</p>
        {g.revealed_at && <p className="meta">Revealed {fmtWhen(parseWhen(g.revealed_at))}</p>}
        {g.status === 'revealed' && <Confetti id={g.id} />}
      </section>
    )
  }
  const lead = g.status === 'drawn' ? 'Winner reveal in' : 'Reveal in'
  return (
    <section className="glass gw-hero" aria-labelledby="gw-h">
      <h2 className="gw-title" id="gw-h">{g.title || 'Giveaway'}</h2>
      <p className="gw-prize"><span aria-hidden="true">🎁 </span>{g.prize || 'Prize TBD'}</p>
      {g.status === 'draft' && <p className="settings-note" role="note">Draft. Members can't see this until it's published.</p>}
      {revealMs == null ? (
        <p className="dim">Reveal date to be announced.</p>
      ) : overdue ? (
        <p className="gw-due" role="status">Revealing the winner…</p>
      ) : (
        <>
          <p className="gw-lead">{lead}</p>
          <Countdown to={revealMs} lead={lead} />
          <p className="meta">{fmtWhen(revealMs, true)}</p>
        </>
      )}
    </section>
  )
}

function Countdown({ to, lead }: { to: number; lead: string }) {
  const now = useNow(1000)
  const p = splitMs(to - now)
  // The ticker is silent; the label only changes once a minute.
  const label = countdownLabel(lead, p)
  const cells: [number, string][] = [[p.d, 'Days'], [p.h, 'Hours'], [p.m, 'Min'], [p.s, 'Sec']]
  return (
    <div className="gw-count" role="timer" aria-live="off" aria-label={label}>
      {cells.map(([n, l]) => (
        <span key={l} className="gw-count-cell" aria-hidden="true">
          <span className="gw-count-num num">{String(n).padStart(2, '0')}</span>
          <span className="gw-count-unit">{l}</span>
        </span>
      ))}
    </div>
  )
}

function Eligibility({ d, g }: { d: GwData; g: Giveaway }) {
  const acct = useAccount()
  const [why, setWhy] = useState(false)
  const me = acct.data?.state === 'signed-in' ? acct.data.onlineId?.toLowerCase() : null
  const won = (g.status === 'revealed' || g.status === 'closed') && me && g.active_draw?.winner_name?.toLowerCase() === me
  const [emoji, text, tone] = won ? ['🏆', 'You won! 🏆', 'gold']
    : d.user_won_this_cycle ? ['🏆', 'You won this cycle — back in next time. One win per rotation cycle.', 'gold']
    : d.user_eligible ? ['✅', "You're in this draw", 'live']
    : ['⏸', "You're not in this draw", 'dim']
  return (
    <section className="glass gw-elig" data-tone={tone} aria-label="Your eligibility">
      <button type="button" className="gw-elig-btn" aria-expanded={why} aria-controls="gw-why" onClick={() => setWhy((v) => !v)}>
        {!won && <span aria-hidden="true">{emoji}</span>}<span>{text}</span>
        <span className="gw-elig-more">{why ? 'Hide the rule' : 'How it works'}</span>
      </button>
      <p id="gw-why" className="dim" hidden={!why}>Everyone wins once before anyone wins twice.</p>
    </section>
  )
}

function RotationCard({ r }: { r: GwData['rotation'] }) {
  const pct = r.total_members ? Math.round((r.won_count / r.total_members) * 100) : 0
  return (
    <section className="glass gw-card" aria-labelledby="gw-rot">
      <h2 className="section-h2" id="gw-rot">Rotation</h2>
      <p className="gw-rot-line">Cycle <b className="num">{r.cycle}</b> · <b className="num">{r.eligible_count}</b> of <b className="num">{r.total_members}</b> still eligible</p>
      <div className="gw-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      {r.won_members.length > 0 && (
        <p className="meta">Won this cycle: {r.won_members.map((m) => m.display_name).join(', ')}</p>
      )}
    </section>
  )
}

function PastWinners({ q, defaultOpen }: { q: ReturnType<typeof useQuery<Giveaway[]>>; defaultOpen: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const shown = open ?? defaultOpen
  const list = useMemo(() => (q.data ?? []).slice(0, 8), [q.data])
  if (q.isSuccess && list.length === 0) return null
  return (
    <section className="glass gw-card" aria-labelledby="gw-past">
      <div className="settings-card-head">
        <h2 className="section-h2" id="gw-past">Past winners</h2>
        {list.length > 0 && (
          <button type="button" className="btn btn-ghost" aria-expanded={shown} aria-controls="gw-past-list" onClick={() => setOpen(!shown)}>
            {shown ? 'Hide past winners' : 'Show past winners'}
          </button>
        )}
      </div>
      {q.isError && q.data === undefined ? <ErrorStrip text="Didn't load" onRetry={() => q.refetch()} />
        : q.isPending ? <div className="skeleton" style={{ height: 40 }} />
        : (
          <ul className="rows acct-rows" id="gw-past-list" hidden={!shown}>
            {list.map((h) => (
              <li key={h.id} className="acct-row">
                <span className="acct-row-text">
                  <span className="acct-row-title"><span aria-hidden="true">🏆 </span>{h.active_draw?.winner_name || '—'}</span>
                  <span className="meta">{h.title || 'Giveaway'}{h.prize ? ` · ${h.prize}` : ''} · {fmtWhen(parseWhen(h.revealed_at || h.closed_at || null), true)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}

/** Once per revealed giveaway (GW-06). Visual only; never with reduced motion. */
function Confetti({ id }: { id: number }) {
  const reduced = useReducedMotion()
  const key = `celebrated_gw_${id}`
  const [show] = useState(() => !reduced && !readLocal(key, false))
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!show) return
    writeLocal(key, true)
    const t = window.setTimeout(() => setDone(true), 4000)
    return () => window.clearTimeout(t)
  }, [show, key])
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    left: `${(i * 37) % 100}%`, delay: `${(i % 9) * 0.12}s`, rot: `${(i * 53) % 360}deg`,
  })), [])
  if (!show || done) return null
  return (
    <div className="gw-confetti" aria-hidden="true">
      {bits.map((b, i) => <span key={i} style={{ left: b.left, animationDelay: b.delay, rotate: b.rot }} />)}
    </div>
  )
}
