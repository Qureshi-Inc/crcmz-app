// PS-8 · AI Coach: your AI read on your clips, plus one drill for next time (J7).
// Everything filters client-side; the payload already carries what the toolbar needs.
// The only writes are your own notify prefs and feedback on your own reports.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { useTitle } from '../../app/title'
import { Bars, DataTable } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { StaleMarker, useStale } from '../../components/states'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { loginUrl } from '../../lib/session'
import { useSwipeDown } from '../../lib/gestures'
import {
  FEEDBACK_TAGS, filterReviews, gradeColor, gradeVal, loadDrafts, momentText, NO_FILTERS, POLL_MS, saveDrafts, savePrefs, sendFeedback, useCoaching,
  type Coaching, type DetailMode, type Feedback, type Filters, type NotifyMode, type Review, type Scope, type Sort,
} from '../../lib/coach'
import { HelpLink } from '../../components/HelpLink'

const when = (ts: number | undefined) => {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const age = Date.now() / 1000 - ts
  if (age < 86_400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (age < 604_800) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const is401 = (e: unknown) => e instanceof ApiError && e.status === 401
const newestFirst = (list: Review[]) => [...list].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
const EMPTY_MINE = <>Send <b>rev</b> in the PSN group within ~5 s of a clip and the coach will grade it.</>

export function CoachPage() {
  useTitle('AI Coach')
  const [sp, setSp] = useSearchParams()
  const scope: Scope = sp.get('scope') === 'squad' ? 'squad' : 'me'
  const q = useCoaching(scope)
  const [signedOut, setSignedOut] = useState(false)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [open, setOpen] = useState<string | null>(null)
  const d = q.data

  function pickScope(s: Scope) {
    if (s === scope) return
    const next = new URLSearchParams(sp)
    if (s === 'squad') next.set('scope', 'squad')
    else next.delete('scope')
    setSp(next, { replace: true })
    setFilters(NO_FILTERS)
    setOpen(null)
  }

  const noAccess = signedOut || is401(q.error)
  return (
    <div className="page co-page">
      <h1 className="page-h1" tabIndex={-1}>AI Coach<HelpLink id="coach" /></h1>
      {noAccess && (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Sign in to see coaching.</span>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      )}
      {d ? (
        <div className="co-body" data-dim={q.isPlaceholderData || undefined}>
          <TopRow d={d} scope={scope} onScope={pickScope} onSignedOut={() => setSignedOut(true)} />
          <Hero d={d} scope={scope} />
          <div className="co-cols">
            <div className="co-left">
              <Charts d={d} />
              <Mistakes d={d} scope={scope} onOpen={(id) => {
                if (!filterReviews(d.reviews, filters).some((r) => r.review_id === id)) setFilters(NO_FILTERS)
                setOpen(id)
                window.setTimeout(() => document.getElementById(`co-r-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
              }} />
              {scope === 'squad' ? <Sightings d={d} /> : <Processing d={d} q={q} />}
            </div>
            <Reports d={d} scope={scope} filters={filters} setFilters={setFilters} open={open} setOpen={setOpen} onSignedOut={() => setSignedOut(true)} />
          </div>
        </div>
      ) : q.isError && !noAccess ? (
        <div className="glass stat-err co-err" role="alert">
          <span>Didn't load</span>
          <button type="button" className="btn btn-secondary" onClick={() => void q.refetch()}>Retry</button>
        </div>
      ) : !noAccess ? <Skeleton /> : null}
    </div>
  )
}

function Skeleton() {
  return (
    <div className="co-skel" aria-busy="true" role="status">
      <span className="sr-only">Loading coaching…</span>
      <div className="glass skeleton co-skel-hero" aria-hidden="true" />
      {[0, 1, 2].map((i) => <div key={i} className="glass skeleton co-skel-card" aria-hidden="true" />)}
    </div>
  )
}

// ── Scope tabs + notify prefs (CO-01, CO-02) ────────────────────────────────
function TopRow({ d, scope, onScope, onSignedOut }: { d: Coaching; scope: Scope; onScope: (s: Scope) => void; onSignedOut: () => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  async function set(patch: { mode: NotifyMode } | { detail: DetailMode }) {
    setBusy(true)
    try {
      const r = await savePrefs(patch)
      for (const s of ['me', 'squad'] as const) {
        qc.setQueryData<Coaching>(['coach', s], (old) => (old ? { ...old, notify_mode: r.notify_mode, detail_mode: r.detail_mode } : old))
      }
    } catch (e) {
      if (is401(e)) onSignedOut()
      else toast("Couldn't save that setting", 'error')
    } finally {
      setBusy(false)
    }
  }
  const c = d.counts
  return (
    <div className="co-top">
      <div className="seg co-scope" role="group" aria-label="Whose reviews">
        {([['me', `Mine (${c.mine})`], ['squad', `Squad (${c.squad})`]] as const).map(([s, label]) => (
          <button key={s} type="button" className="seg-tab" aria-pressed={scope === s} data-state={scope === s ? 'active' : undefined} onClick={() => onScope(s)}>
            {label}
          </button>
        ))}
      </div>
      <div className="co-prefs" aria-busy={busy || undefined}>
        <PrefGroup
          label="Notify me:" value={d.notify_mode} disabled={busy} onPick={(mode) => void set({ mode })}
          options={[['group', 'Group', 'Post in the WhatsApp group'], ['dm', 'DM', 'Direct message me instead'], ['off', 'Off', 'No notification']]}
        />
        {d.notify_mode !== 'off' && (
          <PrefGroup
            label="Reports as:" value={d.detail_mode} disabled={busy} onPick={(detail) => void set({ detail })}
            options={[['full', 'Full report', 'Send the full write-up in the message'], ['link', 'Link only', 'Keep the write-up on the platform']]}
          />
        )}
      </div>
    </div>
  )
}

function PrefGroup<V extends string>({ label, value, options, onPick, disabled }: {
  label: string; value: V; options: [V, string, string][]; onPick: (v: V) => void; disabled: boolean
}) {
  return (
    <div className="co-pref" role="group" aria-label={label.replace(':', '')}>
      <span className="co-pref-l" aria-hidden="true">{label}</span>
      {options.map(([v, text, hint]) => (
        <button key={v} type="button" className="chip" title={hint} aria-pressed={value === v} disabled={disabled} onClick={() => value !== v && onPick(v)}>{text}</button>
      ))}
    </div>
  )
}

// ── Hero: grade + delta, focus, next drill, trajectory, stats (CO-03, CO-04) ─
function Hero({ d, scope }: { d: Coaching; scope: Scope }) {
  const revs = useMemo(() => newestFirst(d.reviews).filter((r) => gradeVal(r.grade) != null && (r.status ?? 'complete') === 'complete'), [d.reviews])
  const latest = revs[0]
  const prev = revs[1]
  const lv = gradeVal(latest?.grade)
  const pv = gradeVal(prev?.grade)
  const delta = lv == null || pv == null ? null : lv > pv ? { s: '▲', t: `up from ${prev!.grade}`, tone: 'up' } : lv < pv ? { s: '▼', t: `down from ${prev!.grade}`, tone: 'down' } : { s: '=', t: `holding ${latest!.grade}`, tone: 'flat' }
  const top = d.charts.mistakes.find((m) => m.count >= 2)
  const tip = latest?.coaching_tips?.[0]
  return (
    <section className="glass co-hero" aria-labelledby="co-hero-h">
      <div className="co-hero-main">
        <h2 className="section-h2" id="co-hero-h">{scope === 'squad' ? 'Squad focus' : 'Your focus'}</h2>
        {!latest ? (
          <p className="co-hero-empty">{scope === 'squad' ? "No one's been graded yet." : EMPTY_MINE}</p>
        ) : (
          <>
            <p className="co-grade-line">
              <span className="co-grade-big" style={{ color: gradeColor(latest.grade) }}>{latest.grade?.toUpperCase()}</span>
              {delta && <span className="co-delta" data-tone={delta.tone}><span aria-hidden="true">{delta.s} </span>{delta.t}</span>}
            </p>
            <p className="co-line"><b>Focus:</b> {top
              ? <>{top.label} <span className="co-times">({top.count}×)</span></>
              : revs.length < 3 ? 'No repeated mistakes yet. Early days, keep the clips coming.' : `No repeated mistakes across ${revs.length} reviews.`}</p>
            {tip && <p className="co-line co-drill"><b>Next time:</b> {tip}</p>}
          </>
        )}
      </div>
      <div className="co-hero-trend">
        <h3 className="co-sub-h">Trajectory</h3>
        <Trend revs={revs} />
      </div>
      <Stats d={d} />
    </section>
  )
}

/** The last 12 graded reviews, oldest → newest, on an S..D grid. */
function Trend({ revs }: { revs: Review[] }) {
  const pts = revs.slice(0, 12).reverse()
  if (pts.length < 2) return <p className="dim co-small">Not enough reviews to plot yet.</p>
  const w = 240, h = 120, padL = 20, padB = 8, padT = 10
  const y = (v: number) => padT + (1 - (v - 0.67) / (5.33 - 0.67)) * (h - padT - padB)
  const x = (i: number) => padL + (i * (w - padL - 10)) / (pts.length - 1)
  return (
    <>
      <svg className="co-trend" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {['S', 'A', 'B', 'C', 'D'].map((g, i) => (
          <g key={g}>
            <line x1={padL} x2={w} y1={y(5 - i)} y2={y(5 - i)} stroke="rgba(255,255,255,.1)" />
            <text x={4} y={y(5 - i) + 3} className="co-trend-l">{g}</text>
          </g>
        ))}
        <polyline fill="none" stroke="var(--neon-cyan)" strokeWidth={1.5} points={pts.map((r, i) => `${x(i)},${y(gradeVal(r.grade)!)}`).join(' ')} />
        {pts.map((r, i) => <circle key={i} cx={x(i)} cy={y(gradeVal(r.grade)!)} r={4.5} fill={gradeColor(r.grade)} stroke="#05030f" strokeWidth={1.5} />)}
      </svg>
      <DataTable label="Grade trajectory" head={['Date', 'Game', 'Grade']} rows={pts.map((r) => [when(r.created_at), r.game || '–', r.grade ?? '–'])} />
    </>
  )
}

function Stats({ d }: { d: Coaching }) {
  const weekAgo = Date.now() / 1000 - 7 * 86_400
  const week = d.reviews.filter((r) => (r.created_at ?? 0) >= weekAgo).length
  const days = d.charts.per_day
  return (
    <dl className="co-stats">
      <div><dt>Reviews</dt><dd>{d.counts.complete}</dd></div>
      <div><dt>This week</dt><dd>{week}</dd></div>
      <div><dt>Processing</dt><dd>{d.counts.processing}</dd></div>
      <div className="co-spark-cell">
        <dt>Last 30 days</dt>
        <dd><Spark rows={days} /><span className="sr-only">{days.reduce((a, r) => a + r.count, 0)} reviews</span></dd>
      </div>
    </dl>
  )
}

/** Reviews per day, with headroom and a zero baseline so 1/day reads as quiet. */
function Spark({ rows }: { rows: { count: number }[] }) {
  if (rows.length < 2) return <span className="dim co-small">–</span>
  const max = Math.max(1, ...rows.map((r) => r.count))
  const w = 100, h = 28, step = w / (rows.length - 1), top = max * 1.25
  return (
    <svg className="co-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1={0} y1={h - 1} x2={w} y2={h - 1} stroke="rgba(255,255,255,.14)" />
      <polyline fill="none" stroke="var(--neon-cyan)" strokeWidth={1.5} vectorEffect="non-scaling-stroke"
        points={rows.map((r, i) => `${(i * step).toFixed(2)},${(h - 3 - (r.count / top) * (h - 7)).toFixed(2)}`).join(' ')} />
    </svg>
  )
}

// ── Left column: grades, themes, mistakes, queue / sightings (CO-05 … CO-08) ─
function Box({ title, sub, children, extra }: { title: string; sub?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="glass stat-panel co-box">
      <div className="stat-h-row"><h2 className="stat-h">{title}</h2>{extra}</div>
      {sub && <p className="meta co-box-sub">{sub}</p>}
      {children}
    </section>
  )
}

function Charts({ d }: { d: Coaching }) {
  const { grades, tags } = d.charts
  return (
    <>
      <Box title="Grades">
        {grades.length ? <Bars label="Grades" head={['Grade', 'Reviews']} rows={grades.map((g) => ({ name: g.label, value: g.count, color: gradeColor(g.label) }))} /> : <p className="dim stat-empty">No grades yet.</p>}
      </Box>
      <Box title="Themes">
        {tags.length ? <Bars label="Themes" head={['Theme', 'Reviews']} color="var(--neon-magenta)" rows={tags.map((t) => ({ name: t.label, value: t.count }))} /> : <p className="dim stat-empty">No themes yet.</p>}
      </Box>
    </>
  )
}

function Mistakes({ d, scope, onOpen }: { d: Coaching; scope: Scope; onOpen: (id: string) => void }) {
  const rows = d.charts.mistakes
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <Box title="Mistake patterns" sub={scope === 'squad' ? 'Shared across the squad. Individual reports stay private.' : '2× or more is a habit. Tap one to open the report.'}>
      {!rows.length ? (
        <p className="dim stat-empty">{scope === 'squad' ? 'No shared patterns yet. One shows up once two or more squad members repeat the same mistake.' : 'No patterns yet.'}</p>
      ) : (
        <ul className="co-mis">
          {rows.map((r) => {
            const id = r.reviews?.[0]
            const body = (
              <>
                <span className="co-mis-n num">{r.count}×</span>
                <span className="co-mis-t">{r.label}</span>
                <span className="co-mis-track" aria-hidden="true"><i style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} /></span>
                {id && <span className="co-mis-go meta">See report<Icon name="right" className="nav-icon" /></span>}
              </>
            )
            return (
              <li key={r.label} data-solo={r.count < 2 || undefined}>
                {id ? <button type="button" className="co-mis-row" onClick={() => onOpen(id)}>{body}</button> : <div className="co-mis-row">{body}</div>}
              </li>
            )
          })}
        </ul>
      )}
    </Box>
  )
}

function Processing({ d, q }: { d: Coaching; q: ReturnType<typeof useCoaching> }) {
  const { stale, minutes } = useStale(q, POLL_MS)
  if (!d.processing.length) return null
  return (
    <Box title="In the queue" extra={stale && d.counts.processing > 0 ? <StaleMarker minutes={minutes} onRetry={() => void q.refetch()} /> : undefined}>
      <ul className="co-proc">
        {d.processing.map((p) => (
          <li key={p.clip_id}>
            <span className="co-proc-dot" aria-hidden="true" />
            <span className="co-proc-t">{p.psn_user} · {p.reason || p.status}</span>
            <span className="meta">{when(p.created_at)}</span>
          </li>
        ))}
      </ul>
    </Box>
  )
}

function Sightings({ d }: { d: Coaching }) {
  const rows = d.sightings ?? []
  return (
    <Box title="Spotted in squad clips" sub="What the AI noticed squadmates doing in each other's clips.">
      {!rows.length ? <p className="dim stat-empty">No sightings yet. They show up when a review mentions a squadmate.</p> : (
        <ul className="co-sight">
          {rows.map((s, i) => (
            <li key={i}>
              <b className="co-sight-who">{s.player || 'Squad'}</b>
              <span>{s.observation}</span>
              <span className="meta">{[s.game, when(s.created_at)].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
    </Box>
  )
}

// ── Reports: toolbar + cards (CO-09, CO-10) ─────────────────────────────────
function Reports({ d, scope, filters, setFilters, open, setOpen, onSignedOut }: {
  d: Coaching; scope: Scope; filters: Filters; setFilters: (f: Filters) => void; open: string | null; setOpen: (id: string | null) => void; onSignedOut: () => void
}) {
  const list = useMemo(() => filterReviews(d.reviews, filters), [d.reviews, filters])
  const total = d.reviews.length
  return (
    <section className="co-reports" aria-labelledby="co-rep-h">
      <h2 className="section-h2" id="co-rep-h">{scope === 'squad' ? 'Squad grades' : 'Reports'}</h2>
      {!total ? (
        <p className="glass co-empty">{scope === 'squad' ? "No one's been graded yet." : EMPTY_MINE}</p>
      ) : (
        <>
          <Toolbar d={d} scope={scope} filters={filters} setFilters={setFilters} shown={list.length} />
          {scope === 'squad' && <p className="meta co-private">Full reports are private. Each member sees only their own under Mine.</p>}
          {!list.length ? (
            <div className="glass co-empty">
              <span>No reports match</span>
              <button type="button" className="btn btn-secondary" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>
            </div>
          ) : scope === 'squad' ? (
            <ul className="glass co-grades">
              {list.map((r, i) => (
                <li key={i}>
                  <span className="co-badge" style={{ color: gradeColor(r.grade), borderColor: gradeColor(r.grade) }}>{r.grade?.toUpperCase() || '–'}</span>
                  <span>{r.game || 'Unknown game'}</span>
                  <span className="meta">{when(r.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="co-cards">
              {list.map((r) => <li key={r.review_id}><ReportCard r={r} open={open === r.review_id} onToggle={() => setOpen(open === r.review_id ? null : r.review_id ?? null)} onSignedOut={onSignedOut} /></li>)}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

const SORTS: [Sort, string][] = [['new', 'Newest'], ['old', 'Oldest'], ['best', 'Best'], ['worst', 'Worst']]

function Toolbar({ d, scope, filters, setFilters, shown }: { d: Coaching; scope: Scope; filters: Filters; setFilters: (f: Filters) => void; shown: number }) {
  const desktop = useDesktop()
  const [sheet, setSheet] = useState(false)
  const swipe = useSwipeDown(() => setSheet(false))
  const total = d.reviews.length
  const games = [...new Set(d.reviews.map((r) => r.game || 'unknown'))]
  const players = scope === 'squad' ? [...new Set(d.reviews.map((r) => r.psn_user || 'unknown'))] : []
  const dirty = filters.q !== '' || filters.game !== 'all' || filters.player !== 'all' || filters.sort !== 'new'
  const picked = (filters.game !== 'all' ? 1 : 0) + (filters.player !== 'all' ? 1 : 0) + (filters.sort !== 'new' ? 1 : 0)
  const groups = (
    <>
      {games.length > 1 && <ChipGroup label="Game" value={filters.game} options={games} onPick={(game) => setFilters({ ...filters, game })} />}
      {players.length > 1 && <ChipGroup label="Player" value={filters.player} options={players} onPick={(player) => setFilters({ ...filters, player })} />}
      <div className="co-chipgroup" role="group" aria-label="Sort">
        <span className="co-pref-l" aria-hidden="true">Sort</span>
        {SORTS.map(([v, t]) => <button key={v} type="button" className="chip" aria-pressed={filters.sort === v} onClick={() => setFilters({ ...filters, sort: v })}>{t}</button>)}
      </div>
    </>
  )
  return (
    <div className="glass co-tools">
      <div className="co-tools-row">
        <label className="sr-only" htmlFor="co-search">Search reports</label>
        <input id="co-search" className="input co-search" type="search" placeholder="Search reports…" value={filters.q} autoComplete="off" onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        {!desktop && (
          <button type="button" className="btn btn-secondary" aria-haspopup="dialog" onClick={() => setSheet(true)}>
            <Icon name="queue" />Filters{picked > 0 && <span className="co-filter-n"> ({picked})</span>}
          </button>
        )}
      </div>
      {desktop && <div className="co-tools-row co-tools-chips">{groups}</div>}
      <div className="co-tools-row co-tools-foot">
        <span className="meta" role="status">{shown === total ? `${total} ${total === 1 ? 'report' : 'reports'}` : `${shown} of ${total}`}</span>
        {dirty && <button type="button" className="btn btn-ghost" onClick={() => setFilters(NO_FILTERS)}>Clear</button>}
      </div>
      {!desktop && (
        <Dialog.Root open={sheet} onOpenChange={setSheet}>
          <Dialog.Portal>
            <Dialog.Overlay className="scrim" />
            <Dialog.Content className="sheet co-sheet" aria-describedby={undefined}>
              <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>
              <div className="sheet-title-row">
                <Dialog.Title className="sheet-title">Filter reports</Dialog.Title>
                <Dialog.Close asChild><button type="button" className="icon-btn" aria-label="Close filters"><Icon name="close" /></button></Dialog.Close>
              </div>
              <div className="co-sheet-body">{groups}</div>
              <div className="co-sheet-foot">
                <button type="button" className="btn btn-secondary" disabled={!dirty} onClick={() => setFilters(NO_FILTERS)}>Clear</button>
                <Dialog.Close asChild><button type="button" className="btn btn-primary">Show {shown === 1 ? '1 report' : `${shown} reports`}</button></Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  )
}

function ChipGroup({ label, value, options, onPick }: { label: string; value: string; options: string[]; onPick: (v: string) => void }) {
  return (
    <div className="co-chipgroup" role="group" aria-label={label}>
      <span className="co-pref-l" aria-hidden="true">{label}</span>
      <button type="button" className="chip" aria-pressed={value === 'all'} onClick={() => onPick('all')}>All</button>
      {options.map((o) => <button key={o} type="button" className="chip" aria-pressed={value === o} onClick={() => onPick(value === o ? 'all' : o)}>{o}</button>)}
    </div>
  )
}

function ReportCard({ r, open, onToggle, onSignedOut }: { r: Review; open: boolean; onToggle: () => void; onSignedOut: () => void }) {
  const id = r.review_id ?? ''
  const done = r.status === 'complete'
  // A failed record can carry "C — duplicate"; a badge on bookkeeping would read as a real mark.
  const g = done ? (r.grade ?? '').toUpperCase() : ''
  const List = ({ title, items, tone }: { title: string; items?: string[]; tone: string }) => (items?.length ? (
    <div className="co-sec" data-tone={tone}><h3>{title}</h3><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
  ) : null)
  return (
    <article className="glass co-card" id={`co-r-${id}`} data-open={open || undefined}>
      <button type="button" className="co-card-head" aria-expanded={open} aria-controls={`co-b-${id}`} onClick={onToggle}>
        {g ? <span className="co-badge" style={{ color: gradeColor(g), borderColor: gradeColor(g) }}>{g}</span> : <span className="co-badge co-badge-none" aria-hidden="true">–</span>}
        <span className="co-card-txt">
          <span className="co-card-title">{r.overall_assessment || r.summary || 'Review'}</span>
          <span className="meta">{[r.psn_user, r.game, when(r.created_at)].filter(Boolean).join(' · ')}{!done && r.status ? <> · <em>{r.status}</em></> : null}</span>
          {!!r.tags?.length && <span className="co-tags">{r.tags.map((t) => <span key={t} className="co-tag">{t}</span>)}</span>}
        </span>
        <Icon name={open ? 'collapse' : 'expand'} className="nav-icon co-caret" />
      </button>
      {open && (
        <div className="co-card-body" id={`co-b-${id}`}>
          {r.summary && <p className="co-sum">{r.summary}</p>}
          <List title="Strengths" items={r.strengths} tone="good" />
          <List title="Mistakes" items={r.mistakes} tone="bad" />
          <List title="Coaching tips" items={r.coaching_tips} tone="tip" />
          {!!r.notable_moments?.length && (
            <div className="co-sec" data-tone="mom">
              <h3>Notable moments</h3>
              <ul>{r.notable_moments.map((m, i) => { const x = momentText(m); return <li key={i}>{x.t && <span className="co-mom-t num">{x.t}</span>} {x.note}</li> })}</ul>
            </div>
          )}
          {r.voice_comms && r.is_mine && (
            <details className="co-sec co-voice">
              <summary>Squad voice</summary>
              <pre>{r.voice_comms}</pre>
            </details>
          )}
          {done && id && <FeedbackForm id={id} initial={r.my_feedback} onSignedOut={onSignedOut} />}
        </div>
      )}
    </article>
  )
}

// Drafts live outside React so they survive a collapse, a re-render and (via
// sessionStorage) a sign-in round trip.
const drafts: Record<string, Feedback & { saved?: boolean }> = loadDrafts()

function FeedbackForm({ id, initial, onSignedOut }: { id: string; initial?: Partial<Feedback> | null; onSignedOut: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState<Feedback & { saved?: boolean }>(() => drafts[id] ?? (initial?.rating
    ? { rating: initial.rating, tags: initial.tags ?? [], comment: initial.comment ?? '', saved: true }
    : { rating: '', tags: [], comment: '' }))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  useEffect(() => {
    drafts[id] = f
    saveDrafts(drafts)
  }, [id, f])
  const edit = (patch: Partial<Feedback>) => { setErr(false); setF({ ...f, ...patch, saved: false }) }
  async function submit() {
    if (!f.rating) return
    setBusy(true)
    setErr(false)
    try {
      await sendFeedback(id, f)
      setF({ ...f, saved: true })
      qc.setQueriesData<Coaching>({ queryKey: ['coach'] }, (old) => (old ? {
        ...old, reviews: old.reviews.map((r) => (r.review_id === id ? { ...r, my_feedback: { rating: f.rating, tags: f.tags, comment: f.comment } } : r)),
      } : old))
    } catch (e) {
      if (is401(e)) onSignedOut()
      setErr(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="co-fb" role="group" aria-label="Feedback on this report">
      <div className="co-fb-row">
        <span className="co-pref-l">Was this right?</span>
        <button type="button" className="chip co-thumb" aria-pressed={f.rating === 'up'} aria-label="Accurate" onClick={() => edit({ rating: f.rating === 'up' ? '' : 'up' })}><span aria-hidden="true">👍</span></button>
        <button type="button" className="chip co-thumb" aria-pressed={f.rating === 'down'} aria-label="Inaccurate" onClick={() => edit({ rating: f.rating === 'down' ? '' : 'down' })}><span aria-hidden="true">👎</span></button>
        {f.saved && <span className="co-saved" role="status">✓ saved</span>}
      </div>
      {f.rating && (
        <>
          <div className="co-fb-tags" role="group" aria-label="What was off">
            {FEEDBACK_TAGS.map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={f.tags.includes(t)} onClick={() => edit({ tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t] })}>{t}</button>
            ))}
          </div>
          <label className="sr-only" htmlFor={`co-fb-${id}`}>Comment</label>
          <textarea id={`co-fb-${id}`} className="input co-fb-text" maxLength={500} rows={2} placeholder="Optional comment (max 500 characters)" value={f.comment} onChange={(e) => edit({ comment: e.target.value })} />
          <div className="co-fb-row">
            <button type="button" className="btn btn-primary" disabled={busy || f.saved} onClick={() => void submit()}>{busy ? 'Sending…' : 'Send feedback'}</button>
            {err && <span className="co-fb-err" role="alert">Couldn't save your feedback</span>}
          </div>
        </>
      )}
    </div>
  )
}
