// PS-4 · WhatsApp: the "Professional Goopers" chat analytics (J6). The range lives in
// the URL; every panel loads, fails and empties on its own. Reading never mutates:
// the only write is an importer's explicit upload.
import { Fragment, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Bars, DataTable, DAYS, HeatGrid, hour, n, Panel as ChartPanel } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { StaleMarker, useStale } from '../../components/states'
import { toast } from '../../components/toast'
import { useAccount } from '../../lib/api'
import { useDesktop } from '../../lib/media'
import { loginUrl, markSignedOut } from '../../lib/session'
import {
  EXPORT_HINT, MAX_IMPORT_BYTES, parseRange, RANGES, rangeLabel, rangeQuery, useCanImport, useWa,
  type Range, type RangeId, type WaAwards, type WaImport, type WaMember,
} from '../../lib/whatsapp'
import { HelpLink } from '../../components/HelpLink'

/** The page has no group headings, so each panel is a top-level section (h2). */
function Panel<T>(p: Parameters<typeof ChartPanel<T>>[0]) {
  return <ChartPanel level={2} {...p} />
}

const day = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '–')
const mins = (v: number) => (v < 1 ? '<1 min' : `${Math.round(v * 10) / 10} min`)

export function WhatsAppPage() {
  useTitle('WhatsApp')
  const [sp, setSp] = useSearchParams()
  const range = parseRange(sp)
  const account = useAccount()
  const signedIn = account.data?.state === 'signed-in'
  const stats = useWa('stats', range)
  const { stale, minutes } = useStale(stats, 5 * 60_000)
  const [signInFor, setSignInFor] = useState<'export' | 'import' | null>(null)

  function pick(r: Range) {
    const next = new URLSearchParams(sp)
    for (const k of ['range', 'start', 'end']) next.delete(k)
    if (r.id !== 'all_time') for (const [k, v] of new URLSearchParams(rangeQuery(r))) next.set(k, v)
    setSp(next, { replace: true })
  }

  const s = stats.data
  const none = s && s.total_messages === 0
  return (
    <div className="page wa-page">
      <h1 className="page-h1" tabIndex={-1}>WhatsApp<HelpLink id="whatsapp" /></h1>
      <RangeBar range={range} onPick={pick} signedIn={signedIn} onSignIn={() => setSignInFor('export')} />
      {signInFor && !signedIn && (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Sign in to {signInFor === 'export' ? 'export' : 'import'}</span>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      )}
      {stale && <StaleMarker minutes={minutes} onRetry={() => void stats.refetch()} />}
      <Loading range={range} />
      <div className="wa-body" data-dim={stats.isPlaceholderData || undefined}>
        {none ? (
          range.id === 'all_time' ? <NoMessages signedIn={signedIn} /> : (
            <div className="glass wa-empty">
              <p className="wa-empty-h">Nothing in this range</p>
              <button type="button" className="btn btn-secondary" onClick={() => pick({ id: 'all_time', start: '', end: '' })}>All time</button>
            </div>
          )
        ) : (
          <>
            <StatTiles range={range} />
            <Awards range={range} />
            <div className="stats-grid wa-grid">
              <Timeline range={range} />
              <ByHour range={range} />
              <ByDow range={range} />
              <Heatmap range={range} />
              <Emoji range={range} />
              <Words range={range} />
              <ResponseTimes range={range} />
            </div>
            <Members range={range} />
          </>
        )}
      </div>
      <Import signedIn={signedIn} onSignedOut={() => setSignInFor('import')} />
    </div>
  )
}

/** "Loading This Month…" while any panel still shows the previous range's numbers. */
function Loading({ range }: { range: Range }) {
  const q = useWa('stats', range)
  return q.isPlaceholderData ? <p className="meta wa-loading" role="status"><span className="spinner" aria-hidden="true" />Loading {rangeLabel(range)}…</p> : null
}

function NoMessages({ signedIn }: { signedIn: boolean }) {
  const can = useCanImport(signedIn).data?.can_import
  return (
    <div className="glass wa-empty">
      <p className="wa-empty-h">No WhatsApp messages yet.</p>
      <p className="dim">{can ? 'Import the chat to get started.' : 'Ask Moiz to import the chat.'}</p>
      {can && <a className="btn btn-secondary" href="#wa-import">Import</a>}
    </div>
  )
}

// ── Range + export (WA-01, WA-13) ───────────────────────────────────────────
function RangeBar({ range, onPick, signedIn, onSignIn }: { range: Range; onPick: (r: Range) => void; signedIn: boolean; onSignIn: () => void }) {
  const [custom, setCustom] = useState(range.id === 'custom')
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const active: RangeId = custom ? 'custom' : range.id
  const bad = !start || !end || start > end
  function apply(e: FormEvent) {
    e.preventDefault()
    if (!bad) onPick({ id: 'custom', start, end })
  }
  return (
    <div className="glass wa-rangebar">
      <div className="wa-range" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r.id} type="button" className="seg-tab" aria-pressed={active === r.id} data-state={active === r.id ? 'active' : undefined}
            onClick={() => {
              if (r.id === 'custom') { setCustom(true); return }
              setCustom(false)
              onPick({ id: r.id, start: '', end: '' })
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      {custom && (
        <form className="wa-custom" onSubmit={apply}>
          <div>
            <label className="field-label" htmlFor="wa-start">Start</label>
            <input id="wa-start" className="input" type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="wa-end">End</label>
            <input id="wa-end" className="input" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={bad}>Apply</button>
        </form>
      )}
      <Export range={range} signedIn={signedIn} onSignIn={onSignIn} />
    </div>
  )
}

function Export({ range, signedIn, onSignIn }: { range: Range; signedIn: boolean; onSignIn: () => void }) {
  const [busy, setBusy] = useState(false)
  const label = `Export ${rangeLabel(range)} (.xlsx)`
  async function go() {
    if (!signedIn) { onSignIn(); return }
    setBusy(true)
    try {
      const r = await fetch(`/api/whatsapp/export?${rangeQuery(range)}`, { credentials: 'same-origin' })
      if (r.status === 401) { markSignedOut(); onSignIn(); return }
      if (r.status === 501) { toast('Export unavailable on this server', 'warning'); return }
      if (!r.ok) { toast("Export didn't work. Try again.", 'error'); return }
      const name = /filename="?([^";]+)"?/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `whatsapp-${range.id}.xlsx`
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      toast("Export didn't work. Check your connection.", 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className="btn btn-secondary wa-export" disabled={busy} onClick={() => void go()}>
      <Icon name="down" />{busy ? 'Exporting…' : label}
    </button>
  )
}

// ── Stats + awards (WA-02, WA-03) ───────────────────────────────────────────
function StatTiles({ range }: { range: Range }) {
  const q = useWa('stats', range)
  return (
    <Panel title="The chat" q={q} wide>
      {(d) => (
        <dl className="wa-tiles">
          <div data-tone="cyan"><dt>💬 Messages</dt><dd className="num">{n(d.total_messages)}</dd></div>
          <div data-tone="cyan"><dt>👥 Members</dt><dd className="num">{n(d.total_members)}</dd></div>
          <div data-tone="lime"><dt>🎬 Videos</dt><dd className="num">{n(d.total_videos)}</dd></div>
          <div data-tone="lime"><dt>📷 Photos</dt><dd className="num">{n(d.total_photos)}</dd></div>
          <div data-tone="gold"><dt>📅 Days</dt><dd className="num">{n(d.conversation_days)}</dd></div>
          <div data-tone="gold"><dt>📊 Msgs/person</dt><dd className="num">{n(d.total_members ? Math.round(d.total_messages / d.total_members) : 0)}</dd></div>
        </dl>
      )}
    </Panel>
  )
}

type Award = { emoji: string; title: string; who: string; sub: string }
function awardList(a: WaAwards): Award[] {
  const named = (emoji: string, title: string, v: { name: string; count: number } | null | undefined, unit: string): Award | null =>
    v ? { emoji, title, who: v.name, sub: `${n(v.count)} ${unit}` } : null
  return [
    named('🗣️', 'Certified Yapper', a.certified_yapper, 'messages'),
    named('🦉', 'Night Owl', a.night_owl, 'late messages'),
    named('🌅', 'Early Bird', a.early_bird, 'early messages'),
    named('🎬', 'Video King', a.video_king, 'videos'),
    named('📷', 'Photo King', a.photo_king, 'photos'),
    named('💀', 'Most 💀', a.most_skull, 'skulls'),
    named('😂', 'Most 😂', a.most_laugh, 'laughs'),
    named('🔥', 'Most 🔥', a.most_fire, 'fires'),
    a.fastest_replier ? { emoji: '⚡', title: 'Fastest Replier', who: a.fastest_replier.name, sub: `avg ${mins(a.fastest_replier.avg_minutes)}` } : null,
    named('👻', 'Ghost of the Month', a.ghost_of_month, 'messages'),
    named('⭐', 'Most Reacted', a.most_reacted_person, 'reactions'),
    a.biggest_day ? { emoji: '📈', title: 'Biggest Day', who: day(Date.parse(`${a.biggest_day.date}T12:00:00`) / 1000), sub: `${n(a.biggest_day.count)} messages` } : null,
    a.peak_hour ? { emoji: '⏰', title: 'Peak Hour', who: hour(a.peak_hour.hour), sub: `${n(a.peak_hour.count)} messages` } : null,
    a.longest_streak_days ? { emoji: '🔗', title: 'Longest Streak', who: `${a.longest_streak_days} days`, sub: 'in a row' } : null,
    a.most_used_emoji ? { emoji: a.most_used_emoji.emoji, title: 'Top Emoji', who: a.most_used_emoji.emoji, sub: `${n(a.most_used_emoji.count)} times` } : null,
  ].filter((x): x is Award => !!x)
}

function Awards({ range }: { range: Range }) {
  const q = useWa('awards', range)
  return (
    <Panel title="🏅 Awards" q={q} wide empty={(d) => (awardList(d).length ? null : 'No awards computed for this range.')}>
      {(d) => {
        const m = d.most_reacted_message
        return (
          <>
            <ul className="wa-awards">
              {awardList(d).map((a) => (
                <li key={a.title} className="wa-award">
                  <span className="wa-award-emoji" aria-hidden="true">{a.emoji}</span>
                  <span className="wa-award-title">{a.title}</span>
                  <span className="wa-award-who">{a.who}</span>
                  <span className="meta">{a.sub}</span>
                </li>
              ))}
            </ul>
            {m && m.text && (
              <blockquote className="wa-quote">
                <p>“{m.text}”</p>
                <footer className="meta">Most reacted message · {m.sender_name} · {n(m.cnt)} reactions · {day(m.timestamp)}</footer>
              </blockquote>
            )}
          </>
        )
      }}
    </Panel>
  )
}

// ── Activity (WA-04 … WA-08) ────────────────────────────────────────────────
/** Vertical bars you can tap to read. The bars are pointer-only; the table carries them for everyone else. */
function VBars({ rows, color, label, head, every = 1 }: { rows: { key: string; label: string; value: number }[]; color: string; label: string; head: [string, string]; every?: number }) {
  const [sel, setSel] = useState<string | null>(null)
  const max = Math.max(1, ...rows.map((r) => r.value))
  const picked = rows.find((r) => r.key === sel)
  return (
    <>
      <p className="meta wa-readout" aria-hidden="true">{picked ? `${picked.label}: ${n(picked.value)}` : 'Tap a bar to read it'}</p>
      <div className="wa-vbars-scroll" aria-hidden="true">
        <div className="vbars wa-vbars" style={{ ['--bar' as string]: color, ['--bars' as string]: rows.length }}>
          {rows.map((r) => (
            <i key={r.key} data-on={r.key === sel || undefined} style={{ height: `${Math.max(2, (r.value / max) * 100)}%` }} title={`${r.label}: ${r.value}`} onClick={() => setSel(r.key === sel ? null : r.key)} />
          ))}
          <span className="wa-grid-line" style={{ bottom: '25%' }} /><span className="wa-grid-line" style={{ bottom: '75%' }} />
        </div>
        <div className="wa-vbars-axis meta" style={{ ['--bars' as string]: rows.length }}>
          {rows.map((r, i) => <span key={r.key}>{i % every === 0 ? r.label : ''}</span>)}
        </div>
      </div>
      <DataTable label={label} head={head} rows={rows.map((r) => [r.label, n(r.value)])} />
    </>
  )
}

function Timeline({ range }: { range: Range }) {
  const q = useWa('activity', range)
  const [view, setView] = useState<'daily' | 'monthly'>('daily')
  const toggle = (
    <div className="seg wa-seg" role="group" aria-label="Timeline view">
      {(['daily', 'monthly'] as const).map((v) => (
        <button key={v} type="button" className="seg-tab" aria-pressed={view === v} data-state={view === v ? 'active' : undefined} onClick={() => setView(v)}>
          {v === 'daily' ? 'Daily' : 'Monthly'}
        </button>
      ))}
    </div>
  )
  return (
    <Panel title="📈 Activity over time" q={q} wide action={toggle} empty={(d) => ((view === 'daily' ? d.daily : d.monthly).length ? null : 'Nothing in this range')}>
      {(d) => view === 'daily'
        ? <VBars label="Messages per day" head={['Date', 'Messages']} color="var(--neon-cyan)" every={7}
            rows={d.daily.slice(-60).map((e) => ({ key: e.date, label: e.date.slice(5), value: e.count }))} />
        : <VBars label="Messages per month" head={['Month', 'Messages']} color="var(--neon-cyan)"
            rows={d.monthly.map((e) => ({ key: e.month, label: e.month, value: e.count }))} />}
    </Panel>
  )
}

function ByHour({ range }: { range: Range }) {
  const q = useWa('activity', range)
  return (
    <Panel title="⏰ By hour" q={q} empty={(d) => (d.by_hour.some((h) => h.count) ? null : 'Nothing in this range')}>
      {(d) => <VBars label="Messages by hour" head={['Hour', 'Messages']} color="var(--neon-cyan)" every={6}
        rows={d.by_hour.map((h) => ({ key: String(h.hour), label: hour(h.hour), value: h.count }))} />}
    </Panel>
  )
}

function ByDow({ range }: { range: Range }) {
  const q = useWa('activity', range)
  return (
    <Panel title="📆 By day of week" q={q} empty={(d) => (d.by_dow.some((h) => h.count) ? null : 'Nothing in this range')}>
      {(d) => <Bars label="Messages by day of week" head={['Day', 'Messages']} color="var(--neon-cyan)" rows={d.by_dow.map((x) => ({ name: x.label, value: x.count }))} />}
    </Panel>
  )
}

function Heatmap({ range }: { range: Range }) {
  const q = useWa('heatmap', range)
  const [pick, setPick] = useState<[number, number] | null>(null)
  return (
    <Panel title="🌡️ When we talk" q={q} wide empty={(d) => (d.max_count > 0 && d.cells.length ? null : 'No activity data for this range.')}>
      {(d) => {
        const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
        for (const c of d.cells) if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) grid[c.dow]![c.hour] = c.count
        const v = pick ? grid[pick[0]]![pick[1]]! : 0
        return (
          <>
            <p className="meta wa-readout" aria-hidden="true">{pick ? `${DAYS[pick[0]]} ${hour(pick[1])}: ${n(v)} ${v === 1 ? 'message' : 'messages'}` : 'Tap a square to read it'}</p>
            <HeatGrid grid={grid} color="var(--neon-cyan)" picked={pick} onPick={(a, b) => setPick(pick && pick[0] === a && pick[1] === b ? null : [a, b])} />
            <DataTable label="Messages by day and hour" head={['Day', 'Busiest hour', 'Messages']} rows={grid.map((row, di) => {
              const best = row.indexOf(Math.max(...row))
              return [DAYS[di], row[best] ? `${hour(best)} (${n(row[best])})` : '–', n(row.reduce((s, x) => s + x, 0))]
            })} />
          </>
        )
      }}
    </Panel>
  )
}

// ── Emoji, words, response times (WA-10 … WA-12) ────────────────────────────
function Emoji({ range }: { range: Range }) {
  const q = useWa('emojis', range)
  const desktop = useDesktop()
  return (
    <Panel title="😂 Top emoji" q={q} empty={(d) => (d.total_emoji ? null : 'No emoji in this chat yet.')}>
      {(d) => {
        const max = Math.max(1, ...d.top_emoji.map((e) => e.pct))
        const people = Object.entries(d.member_top_emoji).filter(([, l]) => l.length)
        return (
          <>
            <ol className="wa-emoji" aria-label="Top emoji">
              {d.top_emoji.slice(0, 10).map((e, i) => (
                <li key={e.emoji}>
                  <span className="stat-rank num">{i + 1}</span>
                  <span className="wa-emoji-glyph">{e.emoji}</span>
                  <span className="hbar-track" aria-hidden="true"><i style={{ width: `${(e.pct / max) * 100}%`, background: 'var(--neon-cyan)' }} /></span>
                  <span className="num wa-emoji-n">{n(e.count)} <span className="meta">· {e.pct}%</span></span>
                </li>
              ))}
            </ol>
            <DataTable label="Top emoji" head={['Emoji', 'Count', '%']} rows={d.top_emoji.map((e) => [e.emoji, n(e.count), `${e.pct}%`])} />
            {people.length > 0 && (
              <ul className="wa-chips-list" aria-label="Each member's favourite emoji">
                {people.map(([name, l]) => (
                  <li key={name}><span className="wa-chips-name">{name}</span>{l.slice(0, desktop ? 4 : 3).map((e) => <span key={e.emoji} className="wa-chip" title={`${e.count}×`}>{e.emoji}</span>)}</li>
                ))}
              </ul>
            )}
          </>
        )
      }}
    </Panel>
  )
}

function Words({ range }: { range: Range }) {
  const q = useWa('words', range)
  const desktop = useDesktop()
  return (
    <Panel title="📝 Top words" q={q} empty={(d) => (d.top_words.length ? null : 'No text messages in this range.')}>
      {(d) => <Bars label="Top words" head={['Word', 'Count']} color="var(--neon-lime)" rows={d.top_words.slice(0, desktop ? 20 : 15).map((w) => ({ name: w.word, value: w.count }))} />}
    </Panel>
  )
}

function ResponseTimes({ range }: { range: Range }) {
  const q = useWa('response-times', range)
  return (
    <Panel title="⚡ Response times" q={q} wide empty={(d) => (d.event_count && d.distribution.length ? null : 'Not enough replies in this range.')}>
      {(d) => (
        <>
          <p className="meta">{n(d.event_count)} replies{d.fastest_responder ? ` · fastest: ${d.fastest_responder}` : ''}</p>
          <div className="wa-rt">
            <div>
              <h3 className="wa-sub-h">How fast replies come</h3>
              <VBars label="Replies by response time" head={['Within', 'Replies']} color="var(--neon-gold)" rows={d.distribution.map((b) => ({ key: b.label, label: b.label, value: b.count }))} />
            </div>
            <div>
              <h3 className="wa-sub-h">Average reply, by member</h3>
              <Bars label="Average reply time by member" head={['Member', 'Average']} color="var(--neon-gold)" fmt={mins}
                rows={d.member_avg_minutes.map((m) => ({ name: m.name, value: m.avg_minutes }))} />
            </div>
          </div>
        </>
      )}
    </Panel>
  )
}

// ── Members (WA-09) ─────────────────────────────────────────────────────────
type SortKey = 'messages' | 'total_words' | 'avg_words_per_msg' | 'total_chars' | 'photos' | 'videos' | 'audios' | 'media_omitted' | 'media' | 'first_ts' | 'last_ts' | 'name'
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'messages', label: 'Messages' }, { key: 'total_words', label: 'Words' }, { key: 'avg_words_per_msg', label: 'Avg words' },
  { key: 'media', label: 'Media' }, { key: 'last_ts', label: 'Last seen' },
]
const COLS: { key: SortKey; label: string; cell: (m: WaMember) => ReactNode }[] = [
  { key: 'messages', label: 'Messages', cell: (m) => n(m.messages) },
  { key: 'total_words', label: 'Words', cell: (m) => n(m.total_words) },
  { key: 'avg_words_per_msg', label: 'Avg words/msg', cell: (m) => n(m.avg_words_per_msg) },
  { key: 'total_chars', label: 'Chars', cell: (m) => n(m.total_chars) },
  { key: 'photos', label: 'Photos', cell: (m) => n(m.photos) },
  { key: 'videos', label: 'Videos', cell: (m) => n(m.videos) },
  { key: 'audios', label: 'Audio', cell: (m) => n(m.audios) },
  { key: 'media_omitted', label: 'Media omitted', cell: (m) => n(m.media_omitted) },
  { key: 'first_ts', label: 'First seen', cell: (m) => day(m.first_ts) },
  { key: 'last_ts', label: 'Last seen', cell: (m) => day(m.last_ts) },
]
const media = (m: WaMember) => m.photos + m.videos + m.audios + m.media_omitted
function sortValue(m: WaMember, k: SortKey): number | string {
  if (k === 'name') return m.name.toLowerCase()
  if (k === 'media') return media(m)
  return m[k] ?? 0
}

function Members({ range }: { range: Range }) {
  const q = useWa('members', range)
  const desktop = useDesktop()
  const [key, setKey] = useState<SortKey>('messages')
  const [desc, setDesc] = useState(true)
  function sortBy(k: SortKey) {
    if (k === key) setDesc(!desc)
    else { setKey(k); setDesc(k !== 'name') }
  }
  return (
    <section className="wa-members" aria-labelledby="wa-members-h">
      <div className="wa-members-head">
        <h2 className="section-h2" id="wa-members-h">👥 Members</h2>
        <div className="wa-sort">
          <label className="field-label" htmlFor="wa-sort">Sort by</label>
          <select id="wa-sort" className="input" value={SORTS.some((s) => s.key === key) ? key : ''} onChange={(e) => { setKey(e.target.value as SortKey); setDesc(true) }}>
            {!SORTS.some((s) => s.key === key) && <option value="" disabled>{COLS.find((c) => c.key === key)?.label ?? 'Member'}</option>}
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <button type="button" className="icon-btn" aria-label={desc ? 'Highest first. Show lowest first' : 'Lowest first. Show highest first'} onClick={() => setDesc(!desc)}>
            <Icon name={desc ? 'down' : 'up'} />
          </button>
        </div>
      </div>
      <ChartPanel title="Who says what" q={q} wide empty={(d) => (d.members.length ? null : 'Nobody talked in this range. Try another range.')}>
        {(d) => {
          const rows = [...d.members].sort((a, b) => {
            const x = sortValue(a, key)
            const y = sortValue(b, key)
            const c = x < y ? -1 : x > y ? 1 : 0
            return desc ? -c : c
          })
          return desktop ? <MemberTable rows={rows} range={range} sortKey={key} desc={desc} onSort={sortBy} /> : <MemberCards rows={rows} range={range} />
        }}
      </ChartPanel>
    </section>
  )
}

function useFavourites(range: Range) {
  const e = useWa('emojis', range).data?.member_top_emoji ?? {}
  const w = useWa('words', range).data?.member_top_words ?? {}
  return (name: string) => ({ emoji: e[name] ?? [], words: w[name] ?? [] })
}

function Favourites({ fav }: { fav: ReturnType<ReturnType<typeof useFavourites>> }) {
  if (!fav.emoji.length && !fav.words.length) return <p className="meta">No favourites in this range.</p>
  return (
    <div className="wa-fav">
      {fav.emoji.length > 0 && <p><span className="meta">Top emoji </span>{fav.emoji.map((e) => <span key={e.emoji} className="wa-chip" title={`${e.count}×`}>{e.emoji}</span>)}</p>}
      {fav.words.length > 0 && <p><span className="meta">Top words </span>{fav.words.slice(0, 10).map((w) => w.word).join(' · ')}</p>}
    </div>
  )
}

function MemberCards({ rows, range }: { rows: WaMember[]; range: Range }) {
  const fav = useFavourites(range)
  return (
    <ul className="wa-cards">
      {rows.map((m) => (
        <li key={m.name} className="wa-card">
          <p className="wa-card-name">{m.name}</p>
          <dl className="wa-card-stats">
            <div><dt>Messages</dt><dd className="num">{n(m.messages)}</dd></div>
            <div><dt>Words</dt><dd className="num">{n(m.total_words)}</dd></div>
            <div><dt>Avg words</dt><dd className="num">{n(m.avg_words_per_msg)}</dd></div>
          </dl>
          <p className="meta">
            {n(m.total_chars)} chars · {n(m.photos)} photos · {n(m.videos)} videos · {n(m.audios)} audio · {n(m.media_omitted)} media omitted
          </p>
          <p className="meta">First seen {day(m.first_ts)} · Last seen {day(m.last_ts)}</p>
          <details className="wa-more"><summary>Favourites</summary><Favourites fav={fav(m.name)} /></details>
        </li>
      ))}
    </ul>
  )
}

function MemberTable({ rows, range, sortKey, desc, onSort }: { rows: WaMember[]; range: Range; sortKey: SortKey; desc: boolean; onSort: (k: SortKey) => void }) {
  const fav = useFavourites(range)
  const [open, setOpen] = useState<string | null>(null)
  const sortAttr = (k: SortKey) => (sortKey === k ? (desc ? 'descending' : 'ascending') : undefined)
  const head = (k: SortKey, label: string) => (
    <th scope="col" aria-sort={sortAttr(k)}>
      <button type="button" className="wa-th" data-on={sortKey === k || undefined} onClick={() => onSort(k)}>
        {label}{sortKey === k && <Icon name={desc ? 'down' : 'up'} className="wa-th-icon" />}
      </button>
    </th>
  )
  return (
    <div className="wa-table-wrap" tabIndex={0} role="region" aria-label="Member table">
      <table className="wa-table">
        <caption className="sr-only">Members, sorted by {(COLS.find((c) => c.key === sortKey) ?? SORTS.find((c) => c.key === sortKey))?.label ?? 'name'}</caption>
        <thead><tr>{head('name', 'Member')}{COLS.map((c) => <Fragment key={c.key}>{head(c.key, c.label)}</Fragment>)}</tr></thead>
        <tbody>
          {rows.map((m) => (
            <MemberRow key={m.name} m={m} open={open === m.name} onToggle={() => setOpen(open === m.name ? null : m.name)} fav={fav(m.name)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MemberRow({ m, open, onToggle, fav }: { m: WaMember; open: boolean; onToggle: () => void; fav: ReturnType<ReturnType<typeof useFavourites>> }) {
  const id = `wa-fav-${m.name.replace(/[^a-zA-Z0-9]/g, '_')}`
  return (
    <>
      <tr>
        <th scope="row">
          <button type="button" className="wa-row-btn" aria-expanded={open} aria-controls={id} onClick={onToggle}>
            <Icon name={open ? 'up' : 'down'} className="wa-th-icon" />{m.name}
          </button>
        </th>
        {COLS.map((c) => <td key={c.key} className="num">{c.cell(m)}</td>)}
      </tr>
      <tr id={id} className="wa-fav-row" hidden={!open}>
        <td colSpan={COLS.length + 1}><Favourites fav={fav} /></td>
      </tr>
    </>
  )
}

// ── Import (WA-14) ──────────────────────────────────────────────────────────
function Import({ signedIn, onSignedOut }: { signedIn: boolean; onSignedOut: () => void }) {
  const can = useCanImport(signedIn)
  const qc = useQueryClient()
  const desktop = useDesktop()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<WaImport | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [drag, setDrag] = useState(false)
  const shown = Boolean(can.data?.can_import) && !forbidden
  // The Admin shortcut links to #wa-import; the section only exists once can-import answers.
  useEffect(() => {
    if (shown && window.location.hash === '#wa-import') document.getElementById('wa-import')?.scrollIntoView({ block: 'start' })
  }, [shown])
  if (!shown) {
    return forbidden ? <p className="banner" role="alert"><span style={{ fontWeight: 700 }}>You're not allowed to import — ask an admin.</span></p> : null
  }

  function choose(f: File | null | undefined) {
    setErr(null)
    setResult(null)
    if (!f) { setFile(null); return }
    if (!/\.(txt|zip)$/i.test(f.name)) { setFile(null); setErr("That file type won't work — upload a .txt or .zip from WhatsApp."); return }
    if (f.size > MAX_IMPORT_BYTES) { setFile(null); setErr(`File too large — keep it under 50 MB. ${EXPORT_HINT}`); return }
    setFile(f)
  }
  function drop(e: DragEvent) {
    e.preventDefault()
    setDrag(false)
    choose(e.dataTransfer.files[0])
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!file || busy) return
    setBusy(true)
    setErr(null)
    const fd = new FormData()
    fd.append('file', file, file.name)
    try {
      const r = await fetch('/api/whatsapp/import', { method: 'POST', body: fd, credentials: 'same-origin' })
      const body = (await r.json().catch(() => ({}))) as WaImport & { detail?: string }
      if (r.status === 401) { markSignedOut(); onSignedOut(); return }
      if (r.status === 403) { setForbidden(true); return }
      if (r.status === 413) { setErr(`File too large — keep it under 50 MB. ${EXPORT_HINT}`); return }
      if (r.status === 400) {
        setErr(/only \.txt and \.zip/.test(body.detail ?? '') || !body.detail ? "That file type won't work — upload a .txt or .zip from WhatsApp." : `Couldn't read that export: ${body.detail}`)
        return
      }
      if (!r.ok) { setErr("Import didn't work. Try again."); return }
      setResult(body)
      setFile(null)
      if (input.current) input.current.value = ''
      void qc.invalidateQueries({ queryKey: ['wa'] })
    } catch {
      setErr("Import didn't work. Check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section id="wa-import" className="glass wa-import" aria-labelledby="wa-import-h">
      <h2 className="section-h2" id="wa-import-h">Import chat history</h2>
      <form onSubmit={submit} aria-busy={busy}>
        <div
          className="wa-drop" data-drag={drag || undefined}
          onDragOver={desktop ? (e) => { e.preventDefault(); setDrag(true) } : undefined}
          onDragLeave={desktop ? () => setDrag(false) : undefined}
          onDrop={desktop ? drop : undefined}
        >
          <label className="field-label" htmlFor="wa-file">WhatsApp export (.txt or .zip)</label>
          <input
            id="wa-file" ref={input} className="input wa-file" type="file" accept=".txt,.zip,text/plain,application/zip" disabled={busy}
            aria-describedby="wa-file-hint" onChange={(e) => choose(e.target.files?.[0])}
          />
          {desktop && <p className="meta">or drop the file here</p>}
        </div>
        <p className="field-hint" id="wa-file-hint">Up to 50 MB. Without media: {EXPORT_HINT.replace(/^Re-export without media: /, '')} Re-importing the same chat skips the duplicates.</p>
        {err && <p className="wa-import-err" role="alert">{err}</p>}
        <button type="submit" className="btn btn-primary" disabled={!file || busy}>
          <Icon name="up" />{busy ? 'Importing…' : 'Import'}
        </button>
        {result && (
          <p className="wa-import-ok" role="status">
            {result.status === 'already_imported' ? 'Already imported · ' : ''}
            Imported {n(result.message_count ?? 0)} · {n(result.duplicate_count ?? 0)} duplicates skipped · {n(result.total_parsed ?? 0)} parsed
          </p>
        )}
      </form>
    </section>
  )
}
