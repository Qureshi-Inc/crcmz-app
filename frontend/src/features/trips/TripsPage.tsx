// Trips: plan one with the squad (who's going), then its Split and Moments. Only the
// people invited see a trip; whoever made it changes who's invited or deletes it.
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { HelpLink } from '../../components/HelpLink'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { initial, tripDates, tripsApi, useTripPeople, useTrips, type Trip, type TripMember } from '../../lib/trips'
import { Sheet, errText } from '../tourney/Report'
import { SplitTab } from './SplitTab'
import { MomentsTab } from './MomentsTab'
import '../../styles/tourney.css'
import '../../styles/trips.css'

export function TripsPage() {
  useTitle('Trips')
  const q = useTrips()
  const [creating, setCreating] = useState(false)
  const list = q.data?.trips ?? []
  const today = new Date().toISOString().slice(0, 10)
  const upcoming = list.filter((t) => !t.end || t.end >= today)
  const past = list.filter((t) => t.end && t.end < today)
  return (
    <div className="page tn tr">
      <div className="tn-top">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Trips <HelpLink id="trips" /></h1>
          <p className="dim tn-sub">Who's going, who paid for what, and what happened. Only the people on a trip see it.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" className="btn-ico" />New trip</button>
      </div>
      {q.isError && <ErrorStrip text="Couldn't load your trips" onRetry={() => q.refetch()} />}
      {q.isLoading && <SkeletonRows n={2} height={96} />}
      {q.data && !list.length && (
        <div className="empty glass">
          <p className="empty-title">No trips yet</p>
          <p className="dim">Make one, invite the squad, and the Split and Moments are ready for when you land.</p>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New trip</button>
        </div>
      )}
      <TripGroup title="Coming up" items={upcoming} />
      <TripGroup title="Been" items={past} />
      <Sheet open={creating} onOpenChange={setCreating} title="New trip">
        {creating && <TripForm canLink={Boolean(q.data?.can_link)} onDone={() => setCreating(false)} />}
      </Sheet>
    </div>
  )
}

function TripGroup({ title, items }: { title: string; items: Trip[] }) {
  if (!items.length) return null
  return (
    <section className="tn-group" aria-label={title}>
      <h2 className="eyebrow">{title}</h2>
      <ul className="tn-cards">
        {items.map((t) => (
          <li key={t.id}>
            <Link to={`/trips/${t.id}`} className="tn-card glass tr-card-link">
              <span className="tn-card-top">
                <span className="tn-card-game">{tripDates(t) || 'Dates to come'}</span>
                {t.linked && <span className="pill">trip.crcmz.me</span>}
              </span>
              <span className="tn-card-name">{t.name}</span>
              {t.place && <span className="meta">{t.place}</span>}
              <Faces members={t.members} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Faces({ members }: { members: TripMember[] }) {
  const shown = members.slice(0, 6)
  return (
    <span className="tr-faces" aria-label={`${members.length} going: ${members.map((m) => m.name).join(', ')}`}>
      {shown.map((m) => <span key={m.sub} className="tr-av" aria-hidden="true" title={m.name}>{initial(m.name)}</span>)}
      {members.length > shown.length && <span className="meta" aria-hidden="true">+{members.length - shown.length}</span>}
    </span>
  )
}

/** New trip, or editing one: name, place, dates, currency, and who's invited. */
function TripForm({ trip, canLink = false, onDone }: { trip?: Trip; canLink?: boolean; onDone: (t?: Trip) => void }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const people = useTripPeople()
  const [name, setName] = useState(trip?.name || '')
  const [place, setPlace] = useState(trip?.place || '')
  const [start, setStart] = useState(trip?.start || '')
  const [end, setEnd] = useState(trip?.end || '')
  const [currency, setCurrency] = useState(trip?.currency || 'CAD')
  const [members, setMembers] = useState<string[]>(trip?.members.map((m) => m.sub) || [])
  const [link, setLink] = useState(false)
  const [find, setFind] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const all = useMemo(() => {
    const byId = new Map<string, TripMember>()
    for (const p of people.data?.people ?? []) byId.set(p.sub, p)
    for (const m of trip?.members ?? []) if (!byId.has(m.sub)) byId.set(m.sub, m)
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [people.data, trip])
  const shown = all.filter((p) => !find.trim() || p.name.toLowerCase().includes(find.trim().toLowerCase()))
  const toggle = (sub: string) => setMembers((xs) => (xs.includes(sub) ? xs.filter((x) => x !== sub) : [...xs, sub]))

  async function save() {
    if (!name.trim()) { setErr('Give the trip a name.'); return }
    if (start && end && end < start) { setErr('The trip ends before it starts.'); return }
    setBusy(true); setErr('')
    try {
      const body = { name: name.trim(), place: place.trim(), start, end, members }
      const t = trip ? await tripsApi.update(trip.id, body) : await tripsApi.create({ ...body, currency, ...(link ? { link: true } : {}) })
      await qc.invalidateQueries({ queryKey: ['trips'] })
      toast(trip ? 'Trip saved' : 'Trip made', 'success')
      onDone(t)
      if (!trip) nav(`/trips/${t.id}`)
    } catch (e) { setErr(errText(e)); setBusy(false) }
  }

  return (
    <form className="sheet-body tr-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <div>
        <label className="field-label" htmlFor="tr-name">Name</label>
        <input id="tr-name" className="input" maxLength={60} placeholder="Calgary 2026" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div>
        <label className="field-label" htmlFor="tr-place">Where</label>
        <input id="tr-place" className="input" maxLength={80} placeholder="Calgary, AB" value={place} onChange={(e) => setPlace(e.target.value)} />
      </div>
      <div className="tr-two">
        <div>
          <label className="field-label" htmlFor="tr-start">From</label>
          <input id="tr-start" className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="tr-end">To</label>
          <input id="tr-end" className="input" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      {!trip && (
        <div>
          <label className="field-label" htmlFor="tr-cur">Money in</label>
          <select id="tr-cur" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {['CAD', 'USD', 'GBP', 'EUR', 'PKR', 'AED', 'MXN'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <p className="field-hint">The Split keeps everyone's balance in this. Other currencies convert at the day's rate.</p>
        </div>
      )}
      <div>
        <span className="field-label" id="tr-who">Who's going</span>
        <p className="field-hint" style={{ marginTop: 0 }}>You're in it. Only the people you pick see the trip.</p>
        <input className="input" type="search" placeholder="Find someone" aria-label="Find someone to invite" value={find} onChange={(e) => setFind(e.target.value)} />
        {people.isError && <p className="field-err">Couldn't load the squad. <button type="button" className="btn btn-ghost" onClick={() => people.refetch()}>Retry</button></p>}
        <div className="tr-chips tr-chips-wrap" role="group" aria-labelledby="tr-who">
          {shown.map((p) => (
            <button key={p.sub} type="button" className="chip tr-chip" aria-pressed={members.includes(p.sub)} onClick={() => toggle(p.sub)}>
              <span className="tr-av" aria-hidden="true">{initial(p.name)}</span>{p.name}
            </button>
          ))}
          {people.data && !shown.length && <span className="meta">Nobody by that name.</span>}
        </div>
        <p className="meta">{members.length} invited</p>
      </div>
      {!trip && canLink && (
        <label className="check-row">
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
          This is the trip.crcmz.me trip (use its Split and Moments)
        </label>
      )}
      {err && <p className="field-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary tr-wide" disabled={busy}>{busy ? 'Saving…' : trip ? 'Save trip' : 'Make the trip'}</button>
    </form>
  )
}

type Tab = 'split' | 'moments'

export function TripPage() {
  const { id = '' } = useParams()
  const q = useTrips()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'moments' ? 'moments' : 'split'
  const [managing, setManaging] = useState(false)
  const nav = useNavigate()
  const qc = useQueryClient()
  const t = q.data?.trips.find((x) => x.id === id)
  useTitle(t?.name ?? 'Trip')

  if (q.isError && !q.data) return <div className="page tn tr"><BackLink /><ErrorStrip text="Couldn't load this trip" onRetry={() => q.refetch()} /></div>
  if (!q.data) return <div className="page tn tr"><BackLink /><SkeletonRows n={4} height={84} /></div>
  if (!t) {
    return (
      <div className="page tn tr">
        <BackLink />
        <div className="empty glass">
          <p className="empty-title">That trip isn't here</p>
          <p className="dim">It was deleted, or you're not on it. Ask whoever made it to invite you.</p>
        </div>
      </div>
    )
  }

  async function remove() {
    if (!t || !window.confirm(`Delete ${t.name} for everyone?${t.linked ? ' trip.crcmz.me keeps its own Split and Moments.' : ' Its Split and Moments go with it.'}`)) return
    try {
      await tripsApi.remove(t.id)
      await qc.invalidateQueries({ queryKey: ['trips'] })
      toast('Trip deleted')
      nav('/trips')
    } catch (e) { toast(e instanceof ApiError ? errText(e) : 'Could not delete it', 'error') }
  }

  return (
    <div className="page tn tr">
      <BackLink />
      <header className="tn-head tr-head">
        <span className="tn-head-game">{[tripDates(t), t.place].filter(Boolean).join(' · ') || 'Dates to come'}</span>
        <h1 className="page-h1" tabIndex={-1}>{t.name}</h1>
        <div className="tn-head-row">
          <Faces members={t.members} />
          {t.linked && t.site_url && <a className="btn btn-ghost" href={t.site_url} target="_blank" rel="noreferrer">Also on trip.crcmz.me</a>}
          {t.can_manage && <button type="button" className="btn btn-secondary" onClick={() => setManaging(true)}><Icon name="edit" className="btn-ico" />Edit trip</button>}
        </div>
      </header>
      <div className="seg tn-tabs" role="tablist" aria-label="Trip">
        {(['split', 'moments'] as Tab[]).map((k) => (
          <button key={k} type="button" role="tab" className="seg-tab" data-state={tab === k ? 'active' : 'inactive'} aria-selected={tab === k}
            onClick={() => setParams(k === 'split' ? {} : { tab: k }, { replace: true })}>
            {k === 'split' ? 'Split' : 'Moments'}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'split' ? <SplitTab trip={t} /> : <MomentsTab trip={t} />}
      </div>
      <Sheet open={managing} onOpenChange={setManaging} title="Edit trip">
        {managing && (
          <>
            <TripForm trip={t} onDone={() => setManaging(false)} />
            <button type="button" className="btn btn-danger tr-wide" style={{ marginBottom: 'var(--space-4)' }} onClick={() => void remove()}>
              <Icon name="trash" className="btn-ico" />Delete trip
            </button>
          </>
        )}
      </Sheet>
    </div>
  )
}

function BackLink() {
  return <Link to="/trips" className="btn btn-ghost tn-back"><Icon name="left" className="btn-ico" />Trips</Link>
}
