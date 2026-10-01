// PS-3 Stats: the Slaptastic dashboard, read through /api/slap/social. Each panel
// loads, fails and empties on its own; the AI panels only ask when scrolled to.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Bars, DataTable, DAYS, HeatGrid, Panel as ChartPanel, hour, n } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { slapName, useSocial, type Library, type Track } from '../../lib/slap'
import { enqueue, getState, playList } from './player'

// ── Shapes (only the fields this page reads) ────────────────────────────────
type Who = { username: string; color?: string }
type SiteStats = { total_songs: number; total_contributors: number; this_week_additions: number; top_artist: string | null; total_artists: number; most_active_day: string | null; peak_hour: number | null; longest_streak_user: string | null; longest_streak_days: number }
type Song = { title: string; artist: string; username?: string; color?: string; created_at?: string; source_platform?: string; track_id?: string; play_count?: number }
type Hot = { tracks: Song[]; period_hours: number }
type ListeningDash = { enabled: boolean; top_tracks: (Song & { plays?: number; count?: number })[]; total_scrobbles: number; period_days: number }
type Leader = { rank: number; username: string; song_count: number; color: string; latest_addition: string | null }
type Streak = Who & { current_streak: number; longest_streak: number; is_active: boolean }
type Hipster = Who & { unique_artists: number; hipster_score: number }
type Persona = Who & { personality: string; description: string; dominant_platform: string; song_count: number }
type Fame = { title: string; description: string; value: string; emoji: string }
type Achievement = { id: string; name: string; emoji: string; description: string; unlocked: boolean; unlocked_by: string[] }
type Vibe = { vibe: string; mood_emoji: string; description: string }
type Digest = { digest: string; highlights: string[] }
type Weekly = { name: string; description: string; tracks: { track_id: string; title: string; artist: string }[] }
type Recs = { username: string; recommendations: string[]; reasoning: string }
type H2H = { user1: string; user2: string; user1_color: string; user2_color: string; user1_songs: number; user2_songs: number; user1_artists: number; user2_artists: number; shared_artists: string[]; user1_unique_artists?: string[]; user2_unique_artists?: string[] }
type Dna = { analysis: string; compatibility_score: number; shared_artists: string[] }
type Listener = { username: string; title: string; artist: string; is_recent: boolean; track_id?: string }
type Activity = { username: string; title: string; artist: string; track_id?: string; completed: boolean; skipped: boolean; timestamp: string }
type Comment = { id: string; username: string; title: string; artist: string; text: string; is_reaction: boolean; created_at: string; track_id?: string }
type Scored = { track_id: string; title: string; artist: string; play_count: number; unique_listeners: number; thumb_ups: number }
type MyListening = { total_plays: number; total_listen_hours: number; top_tracks: Scored[] }

const GROUPS = [
  { id: 'overview', label: 'Overview' }, { id: 'rankings', label: 'Rankings' }, { id: 'compare', label: 'Compare' },
  { id: 'charts', label: 'Charts' }, { id: 'listening', label: 'Listening' }, { id: 'feed', label: 'Feed' },
] as const
const RAMP = ['var(--neon-magenta)', 'var(--neon-cyan)', 'var(--neon-gold)', 'var(--neon-lime)', 'var(--neon-violet)']

const ago = (iso?: string | null) => {
  if (!iso) return ''
  const t = Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)
  if (!Number.isFinite(t)) return ''
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return `${Math.round(m / 1440)} d ago`
}

export function Stats({ me }: { me: string | null }) {
  const qc = useQueryClient()
  return (
    <div className="slap-stats">
      <nav className="stats-jump" aria-label="Jump to">
        <div className="chips">
          {GROUPS.map((g) => (
            <button key={g.id} type="button" className="chip" onClick={() => document.getElementById(`stats-${g.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{g.label}</button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Refresh stats" onClick={() => { void qc.invalidateQueries({ queryKey: ['slap', 'social'] }); toast('Refreshing stats', 'info') }}>
          <Icon name="refresh" />
        </button>
      </nav>

      <Group id="overview" label="Overview"><Totals /><HotPanel /><VibePanel /><OnRepeat /></Group>
      <Group id="rankings" label="Rankings"><Leaderboard /><Streaks /><HipsterPanel /><Personalities /><HallOfFame /><Achievements /></Group>
      <Group id="compare" label="Compare"><Compare me={me} /><Recommendations me={me} /></Group>
      <Group id="charts" label="Charts"><Timeline /><Platforms /><Heatmap /><TopArtists /></Group>
      <Group id="listening" label="Listening"><NowListening /><MyStats me={me} /><Trending /><Feed /><Comments /></Group>
      <Group id="feed" label="Feed">
        <Recent /><DigestPanel /><WeeklyPanel />
        <a className="btn btn-secondary stats-full" href="https://slap.qureshi.io/dashboard" target="_blank" rel="noreferrer">Full dashboard<Icon name="external" /></a>
      </Group>
    </div>
  )
}

function Group({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <section className="stats-group" id={`stats-${id}`} aria-labelledby={`stats-${id}-h`}>
      <h2 className="section-h2" id={`stats-${id}-h`}>{label}</h2>
      <div className="stats-grid">{children}</div>
    </section>
  )
}

function Panel<T>(p: Parameters<typeof ChartPanel<T>>[0]) {
  return <ChartPanel errorText="Slap didn't answer" {...p} />
}

/** True once the element has come near the viewport. AI calls wait for this. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return }
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { setSeen(true); io.disconnect() } }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

function Lazy({ children }: { children: (seen: boolean) => ReactNode }) {
  const [ref, seen] = useSeen<HTMLDivElement>()
  return <div ref={ref} className="stat-lazy">{children(seen)}</div>
}

function Dot({ color }: { color?: string }) {
  return color ? <i className="user-dot" style={{ background: color }} aria-hidden="true" /> : null
}

/** Play Jellyfin ids that are in the library; in a room they join the shared queue. */
function usePlayIds() {
  const qc = useQueryClient()
  return (ids: string[]) => {
    const lib = qc.getQueryData<Library>(['slap', 'library'])
    const byId = new Map((lib?.tracks ?? []).map((t) => [t.id, t]))
    const tracks = ids.map((i) => byId.get(i)).filter((t): t is Track => !!t)
    if (!tracks.length) { toast(lib ? "Those aren't in the library yet" : 'Open Listen once so the library loads', 'warning'); return }
    if (getState().mode === 'together') enqueue(tracks, false)
    else playList(tracks, 0)
  }
}

function SongRows({ items, play, extra }: { items: Song[]; play?: (id: string) => void; extra?: (s: Song) => ReactNode }) {
  return (
    <ol className="stat-rows">
      {items.map((s, i) => (
        <li key={`${s.title}-${i}`} className="stat-row">
          {play && s.track_id
            ? <button type="button" className="icon-btn stat-play" onClick={() => play(s.track_id!)} aria-label={`Play ${s.title}`}><Icon name="play" /></button>
            : <span className="stat-rank num">{i + 1}</span>}
          <span className="stat-text">
            <span className="stat-title">{s.title}</span>
            <span className="stat-sub">{s.artist}{s.username ? <> · <Dot color={s.color} />{slapName(s.username)}</> : null}</span>
          </span>
          {extra?.(s)}
        </li>
      ))}
    </ol>
  )
}

// ── Overview ────────────────────────────────────────────────────────────────
function Totals() {
  const q = useSocial<SiteStats>('dashboard/stats')
  return (
    <Panel title="The library" q={q} wide>
      {(d) => (
        <dl className="kpis">
          <div><dt>Songs</dt><dd className="num">{n(d.total_songs)}</dd></div>
          <div><dt>This week</dt><dd className="num">{n(d.this_week_additions)}</dd></div>
          <div><dt>Artists</dt><dd className="num">{n(d.total_artists)}</dd></div>
          <div><dt>Slappers</dt><dd className="num">{n(d.total_contributors)}</dd></div>
          <div><dt>Top artist</dt><dd className="kpi-text">{d.top_artist ?? '–'}</dd></div>
          <div><dt>Busiest</dt><dd className="kpi-text">{d.most_active_day ?? '–'} · {hour(d.peak_hour)}</dd></div>
          {d.longest_streak_user && <div><dt>Longest streak</dt><dd className="kpi-text">{slapName(d.longest_streak_user)} · {d.longest_streak_days} days</dd></div>}
        </dl>
      )}
    </Panel>
  )
}

function HotPanel() {
  const q = useSocial<Hot>('dashboard/hot')
  return (
    <Panel title="Hot right now" q={q} empty={(d) => (d.tracks.length ? null : 'Nothing new in the last 24 h')}>
      {(d) => <SongRows items={d.tracks.slice(0, 8)} />}
    </Panel>
  )
}

function VibePanel() {
  return (
    <Lazy>{(seen) => <VibeInner seen={seen} />}</Lazy>
  )
}
function VibeInner({ seen }: { seen: boolean }) {
  const q = useSocial<Vibe>('dashboard/ai/vibe-check', undefined, { enabled: seen })
  // Hidden rather than broken when the AI has nothing.
  if (q.isError || (q.isSuccess && !q.data?.vibe)) return null
  return (
    <Panel title="Vibe check" q={q} loadingText="Asking the AI…">
      {(d) => (
        <div className="vibe">
          <p className="vibe-name">{d.mood_emoji} {d.vibe}</p>
          <p className="dim">{d.description}</p>
        </div>
      )}
    </Panel>
  )
}

function OnRepeat() {
  const q = useSocial<ListeningDash>('dashboard/listening')
  if (q.isError || (q.isSuccess && (!q.data.enabled || !q.data.top_tracks.length))) return null
  return (
    <Panel title="On repeat" q={q}>
      {(d) => <SongRows items={d.top_tracks.slice(0, 8)} extra={(s) => <span className="meta num">{n((s as { plays?: number }).plays ?? (s as { count?: number }).count ?? s.play_count)}</span>} />}
    </Panel>
  )
}

// ── Rankings ────────────────────────────────────────────────────────────────
function Leaderboard() {
  const q = useSocial<{ entries: Leader[] }>('dashboard/leaderboard')
  return (
    <Panel title="Leaderboard" q={q} empty={(d) => (d.entries.length ? null : 'No slaps yet')}>
      {(d) => (
        <ol className="stat-rows">
          {d.entries.map((e) => (
            <li key={e.username} className="stat-row" data-top={e.rank <= 3 || undefined}>
              <span className="stat-rank num">{e.rank}</span>
              <span className="stat-text">
                <span className="stat-title"><Dot color={e.color} />{slapName(e.username)}</span>
                <span className="stat-sub">{e.latest_addition ? `last slap ${ago(e.latest_addition)}` : ''}</span>
              </span>
              <span className="stat-num num">{n(e.song_count)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

function Streaks() {
  const q = useSocial<{ entries: Streak[] }>('dashboard/streaks')
  return (
    <Panel title="Streaks" q={q} empty={(d) => (d.entries.length ? null : 'No streaks yet')}>
      {(d) => (
        <ol className="stat-rows">
          {d.entries.map((e) => (
            <li key={e.username} className="stat-row">
              <span className="stat-text">
                <span className="stat-title"><Dot color={e.color} />{slapName(e.username)}</span>
                <span className="stat-sub">best {e.longest_streak} days</span>
              </span>
              <span className="stat-num num" data-live={e.is_active || undefined}>{e.current_streak}<span className="meta"> now</span></span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

function HipsterPanel() {
  const q = useSocial<{ entries: Hipster[] }>('dashboard/hipster')
  return (
    <Panel title="Hipster index" q={q} empty={(d) => (d.entries.length ? null : 'Not enough slaps to judge')}>
      {(d) => (
        <ol className="stat-rows">
          {d.entries.map((e, i) => (
            <li key={e.username} className="stat-row">
              <span className="stat-rank num">{i + 1}</span>
              <span className="stat-text">
                <span className="stat-title"><Dot color={e.color} />{slapName(e.username)}</span>
                <span className="stat-sub">{e.unique_artists} artists nobody else slapped</span>
              </span>
              <span className="stat-num num">{Math.round(e.hipster_score)}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

function Personalities() {
  const q = useSocial<{ cards: Persona[] }>('dashboard/personalities')
  return (
    <Panel title="Music personalities" q={q} wide empty={(d) => (d.cards.length ? null : 'No personalities yet')}>
      {(d) => (
        <ul className="persona-grid">
          {d.cards.map((c) => (
            <li key={c.username} className="persona">
              <p className="persona-who"><Dot color={c.color} />{slapName(c.username)}</p>
              <p className="persona-name">{c.personality}</p>
              <p className="dim">{c.description}</p>
              <p className="meta">{c.song_count} songs · mostly {c.dominant_platform.replace(/_/g, ' ')}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function HallOfFame() {
  const q = useSocial<{ entries: Fame[] }>('dashboard/hall-of-fame')
  return (
    <Panel title="Hall of fame" q={q} empty={(d) => (d.entries.length ? null : 'Nothing legendary yet')}>
      {(d) => (
        <ul className="fame">
          {d.entries.map((e) => (
            <li key={e.title}>
              <span className="fame-emoji" aria-hidden="true">{e.emoji}</span>
              <span className="stat-text"><span className="stat-title">{e.title}</span><span className="stat-sub">{e.value}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Achievements() {
  const q = useSocial<Achievement[] | { achievements: Achievement[] }>('dashboard/achievements')
  const list = (d: Achievement[] | { achievements: Achievement[] }) => (Array.isArray(d) ? d : d.achievements ?? [])
  return (
    <Panel title="Achievements" q={q} wide empty={(d) => (list(d).length ? null : 'No achievements yet')}>
      {(d) => (
        <ul className="ach-grid">
          {list(d).map((a) => (
            <li key={a.id} className="ach" data-unlocked={a.unlocked}>
              <span className="ach-emoji" aria-hidden="true">{a.emoji}</span>
              <span className="stat-text">
                <span className="stat-title">{a.name}{a.unlocked ? '' : <span className="sr-only"> (locked)</span>}</span>
                <span className="stat-sub">{a.unlocked && a.unlocked_by.length ? a.unlocked_by.map(slapName).join(', ') : a.description}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ── Compare ─────────────────────────────────────────────────────────────────
function usePeople(): string[] {
  const q = useSocial<{ entries: Leader[] }>('dashboard/leaderboard')
  return (q.data?.entries ?? []).map((e) => e.username)
}

function PersonSelect({ id, label, value, onChange, people }: { id: string; label: string; value: string; onChange: (v: string) => void; people: string[] }) {
  return (
    <div className="cmp-field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick someone</option>
        {people.map((p) => <option key={p} value={p}>{slapName(p)}</option>)}
      </select>
    </div>
  )
}

function Compare({ me }: { me: string | null }) {
  const people = usePeople()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [pair, setPair] = useState<[string, string] | null>(null)
  useEffect(() => { if (!a && me && people.includes(me)) setA(me) }, [a, me, people])
  const h2h = useSocial<H2H>(pair ? `dashboard/head-to-head/${pair[0]}/${pair[1]}` : null)
  return (
    <article className="glass stat-panel" data-wide>
      <h3 className="stat-h">Head to head</h3>
      <form className="cmp-form" onSubmit={(e) => { e.preventDefault(); if (a && b && a !== b) setPair([a, b]) }}>
        <PersonSelect id="cmp-a" label="First" value={a} onChange={setA} people={people} />
        <PersonSelect id="cmp-b" label="Second" value={b} onChange={setB} people={people} />
        <button type="submit" className="btn btn-primary" disabled={!a || !b || a === b}>Compare</button>
      </form>
      {!pair ? <p className="dim stat-empty">Pick two people to compare</p>
        : h2h.isPending ? <div className="stat-skel" aria-hidden="true"><div className="skeleton" /><div className="skeleton" /></div>
        : h2h.isError ? <div className="stat-err" role="alert"><span>Slap didn't answer</span><button type="button" className="btn btn-secondary" onClick={() => void h2h.refetch()}>Retry</button></div>
        : (
          <div className="cmp-out">
            <table className="cmp-table">
              <thead><tr><th scope="col"><span className="sr-only">Measure</span></th><th scope="col"><Dot color={h2h.data.user1_color} />{slapName(h2h.data.user1)}</th><th scope="col"><Dot color={h2h.data.user2_color} />{slapName(h2h.data.user2)}</th></tr></thead>
              <tbody>
                <tr><th scope="row">Songs</th><td className="num">{n(h2h.data.user1_songs)}</td><td className="num">{n(h2h.data.user2_songs)}</td></tr>
                <tr><th scope="row">Artists</th><td className="num">{n(h2h.data.user1_artists)}</td><td className="num">{n(h2h.data.user2_artists)}</td></tr>
              </tbody>
            </table>
            <p className="dim">{h2h.data.shared_artists.length ? <>Both slapped: {h2h.data.shared_artists.slice(0, 8).join(', ')}</> : 'No artists in common yet.'}</p>
            <Lazy>{(seen) => <TasteDna a={pair[0]} b={pair[1]} seen={seen} />}</Lazy>
          </div>
        )}
    </article>
  )
}

function TasteDna({ a, b, seen }: { a: string; b: string; seen: boolean }) {
  const q = useSocial<Dna>(`dashboard/taste-dna/${a}/${b}`, undefined, { enabled: seen })
  if (q.isError) return null
  if (q.isPending) return <p className="dim" role="status">Asking the AI…</p>
  const raw = q.data.compatibility_score
  const pct = Math.round(raw > 1 ? raw : raw * 100)
  return (
    <div className="dna">
      <p className="dna-score"><b className="num">{pct}%</b> taste match</p>
      <p className="dim">{q.data.analysis}</p>
    </div>
  )
}

function Recommendations({ me }: { me: string | null }) {
  const people = usePeople()
  const [who, setWho] = useState('')
  useEffect(() => { if (!who && me && people.includes(me)) setWho(me) }, [who, me, people])
  return (
    <Lazy>{(seen) => (
      <article className="glass stat-panel">
        <h3 className="stat-h">Recommendations</h3>
        <PersonSelect id="rec-who" label="For" value={who} onChange={setWho} people={people} />
        {who ? <RecsFor who={who} seen={seen} /> : <p className="dim stat-empty">Pick someone to get picks for</p>}
      </article>
    )}</Lazy>
  )
}
function RecsFor({ who, seen }: { who: string; seen: boolean }) {
  const q = useSocial<Recs>(`dashboard/ai/recommendations/${who}`, undefined, { enabled: seen })
  if (q.isPending) return <p className="dim" role="status">Asking the AI…</p>
  if (q.isError) return <div className="stat-err" role="alert"><span>Slap didn't answer</span><button type="button" className="btn btn-secondary" onClick={() => void q.refetch()}>Retry</button></div>
  if (!q.data.recommendations.length) return <p className="dim stat-empty">No picks yet</p>
  return (
    <>
      <ul className="recs">{q.data.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>
      {q.data.reasoning && <p className="meta">{q.data.reasoning}</p>}
    </>
  )
}

// ── Charts ──────────────────────────────────────────────────────────────────
function Timeline() {
  const q = useSocial<{ entries: { date: string; count: number }[] }>('dashboard/timeline')
  return (
    <Panel title="Slaps over time" q={q} wide empty={(d) => (d.entries.length ? null : 'No history yet')}>
      {(d) => {
        const es = d.entries.slice(-60)
        const max = Math.max(1, ...es.map((e) => e.count))
        return (
          <>
            <div className="vbars" aria-hidden="true">
              {es.map((e) => <i key={e.date} style={{ height: `${Math.max(2, (e.count / max) * 100)}%` }} title={`${e.date}: ${e.count}`} />)}
            </div>
            <div className="vbars-axis meta" aria-hidden="true"><span>{es[0]?.date}</span><span>{es[es.length - 1]?.date}</span></div>
            <DataTable label="Songs added per day" head={['Date', 'Songs']} rows={es.map((e) => [e.date, n(e.count)])} />
          </>
        )
      }}
    </Panel>
  )
}

function Platforms() {
  const q = useSocial<{ genres: { name: string; count: number; percentage: number }[] }>('dashboard/genres')
  return (
    <Panel title="Where slaps come from" q={q} empty={(d) => (d.genres.length ? null : 'No platforms yet')}>
      {(d) => <Bars label="Songs by platform" rows={d.genres.map((g, i) => ({ name: g.name.replace(/_/g, ' '), value: g.count, color: RAMP[i % RAMP.length] }))} />}
    </Panel>
  )
}

function Heatmap() {
  const q = useSocial<{ cells: { day: number; hour: number; count: number }[] }>('dashboard/heatmap')
  return (
    <Panel title="When we slap" q={q} wide empty={(d) => (d.cells.some((c) => c.count) ? null : 'No activity yet')}>
      {(d) => {
        const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
        for (const c of d.cells) if (c.day >= 0 && c.day < 7 && c.hour >= 0 && c.hour < 24) grid[c.day]![c.hour] = c.count
        return (
          <>
            <HeatGrid grid={grid} />
            <DataTable label="Songs by day and hour" head={['Day', 'Busiest hour', 'Songs']} rows={grid.map((row, di) => {
              const best = row.indexOf(Math.max(...row))
              return [DAYS[di], row[best] ? hour(best) : '–', n(row.reduce((s, v) => s + v, 0))]
            })} />
          </>
        )
      }}
    </Panel>
  )
}

function TopArtists() {
  const q = useSocial<{ artists: { name: string; count: number }[] }>('dashboard/artists')
  return (
    <Panel title="Top artists" q={q} empty={(d) => (d.artists.length ? null : 'No artists yet')}>
      {(d) => <Bars label="Songs by artist" color="var(--neon-gold)" rows={d.artists.slice(0, 10).map((a) => ({ name: a.name, value: a.count }))} />}
    </Panel>
  )
}

// ── Listening (the player's own plays) ──────────────────────────────────────
function NowListening() {
  const q = useSocial<{ listeners: Listener[] }>('listening/now')
  const play = usePlayIds()
  return (
    <Panel title="Listening now" q={q} empty={(d) => (d.listeners.length ? null : 'Nobody is playing anything right now')}>
      {(d) => <SongRows items={d.listeners} play={(id) => play([id])} />}
    </Panel>
  )
}

function MyStats({ me }: { me: string | null }) {
  const q = useSocial<MyListening>(me ? `listening/user/${me}` : null)
  const play = usePlayIds()
  if (!me) return null
  return (
    <Panel title="Your listening" q={q} empty={(d) => (d.total_plays ? null : 'Play something in Listen and it shows up here')}>
      {(d) => (
        <>
          <dl className="kpis kpis-2">
            <div><dt>Plays</dt><dd className="num">{n(d.total_plays)}</dd></div>
            <div><dt>Hours</dt><dd className="num">{n(d.total_listen_hours)}</dd></div>
          </dl>
          <SongRows items={d.top_tracks.slice(0, 5)} play={(id) => play([id])} extra={(s) => <span className="meta num">{n(s.play_count)}</span>} />
        </>
      )}
    </Panel>
  )
}

function Trending() {
  const q = useSocial<{ trending: Scored[]; squad_favorites: Scored[] }>('listening/insights')
  const play = usePlayIds()
  return (
    <Panel title="Squad favourites" q={q} empty={(d) => (d.squad_favorites.length || d.trending.length ? null : 'Not enough plays yet')}>
      {(d) => {
        const list = d.squad_favorites.length ? d.squad_favorites : d.trending
        return (
          <>
            <SongRows items={list.slice(0, 8)} play={(id) => play([id])} extra={(s) => <span className="meta num">{n(s.play_count)} plays</span>} />
            <button type="button" className="btn btn-secondary" onClick={() => play(list.map((s) => s.track_id))}><Icon name="play" />Play these</button>
          </>
        )
      }}
    </Panel>
  )
}

function Feed() {
  const q = useSocial<{ activity: Activity[] }>('listening/feed', { limit: 20 })
  return (
    <Panel title="Recent plays" q={q} empty={(d) => (d.activity.length ? null : 'No plays yet')}>
      {(d) => (
        <ol className="stat-rows">
          {d.activity.map((a, i) => (
            <li key={`${a.timestamp}-${i}`} className="stat-row">
              <span className="stat-text">
                <span className="stat-title">{a.title}</span>
                <span className="stat-sub">{slapName(a.username)} {a.skipped ? 'skipped' : a.completed ? 'played' : 'listened'} · {ago(a.timestamp)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

function Comments() {
  const q = useSocial<{ comments: Comment[] } | Comment[]>('listening/comments', { limit: 20 })
  const list = (d: { comments: Comment[] } | Comment[]) => (Array.isArray(d) ? d : d.comments ?? [])
  return (
    <Panel title="Comments" q={q} empty={(d) => (list(d).length ? null : 'No comments yet. Say something from the player.')}>
      {(d) => (
        <ol className="stat-rows">
          {list(d).map((c) => (
            <li key={c.id} className="stat-row">
              <span className="stat-text">
                <span className="stat-title comment-text">{c.text}</span>
                <span className="stat-sub">{slapName(c.username)} on {c.title} · {ago(c.created_at)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

// ── Feed ────────────────────────────────────────────────────────────────────
function Recent() {
  const q = useSocial<{ items: Song[] }>('dashboard/recent', { limit: 15 })
  return (
    <Panel title="Just slapped" q={q} empty={(d) => (d.items.length ? null : 'No slaps yet')}>
      {(d) => <SongRows items={d.items} extra={(s) => <span className="meta">{ago(s.created_at)}</span>} />}
    </Panel>
  )
}

function DigestPanel() {
  return <Lazy>{(seen) => <DigestInner seen={seen} />}</Lazy>
}
function DigestInner({ seen }: { seen: boolean }) {
  const q = useSocial<Digest>('dashboard/ai/digest', undefined, { enabled: seen })
  return (
    <Panel title="Weekly digest" q={q} loadingText={q.isPending ? 'Asking the AI…' : undefined} empty={(d) => (d.digest ? null : 'No digest this week')}>
      {(d) => (
        <>
          <p className="digest">{d.digest}</p>
          {d.highlights.length > 0 && <ul className="recs">{d.highlights.map((h) => <li key={h}>{h}</li>)}</ul>}
        </>
      )}
    </Panel>
  )
}

function WeeklyPanel() {
  return <Lazy>{(seen) => <WeeklyInner seen={seen} />}</Lazy>
}
function WeeklyInner({ seen }: { seen: boolean }) {
  const q = useSocial<Weekly>('dashboard/ai/weekly-playlist', undefined, { enabled: seen })
  const play = usePlayIds()
  return (
    <Panel title="This week's playlist" q={q} loadingText={q.isPending ? 'Asking the AI…' : undefined} empty={(d) => (d.tracks.length ? null : 'No playlist this week')}>
      {(d) => (
        <>
          <p className="stat-title">{d.name}</p>
          {d.description && <p className="dim">{d.description}</p>}
          <SongRows items={d.tracks.slice(0, 12)} play={(id) => play([id])} />
          <button type="button" className="btn btn-primary" onClick={() => play(d.tracks.map((t) => t.track_id))}><Icon name="play" />Play the playlist</button>
        </>
      )}
    </Panel>
  )
}
