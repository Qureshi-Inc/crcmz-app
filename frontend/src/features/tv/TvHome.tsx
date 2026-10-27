// The TV home: three tabs along the top (Watch Now, Library, Search). Watch Now is the
// Apple TV layout: the focused movie fills the screen behind a big title, and rows of
// posters run underneath (Continue watching, our library, on its way, then trending,
// new and top rated). The party, when it's on, is the first thing you can press.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { fmtTime, listHistory, type HistItem } from '../../lib/watch'
import {
  getCatalog, getHome, getLibrary, inFlight, isMovieStream, measured, searchMovies, stateText, streamUrl,
  type Adding, type Movie, type MovieState, type NowPlaying, type Result,
} from '../../lib/movies'
import { focusFirst } from '../../lib/tv'
import { Backdrop } from '../watch/MoviesHome'
import { useTvPlay } from './TvApp'

type Tab = 'now' | 'library' | 'search'
const TABS: { id: Tab; label: string }[] = [{ id: 'now', label: 'Watch Now' }, { id: 'library', label: 'Library' }, { id: 'search', label: 'Search' }]

/** What the big title area shows: the focused movie, or today's featured one. */
export type Spot = { title: string; meta: string; overview: string; art: string; badge?: string }
const spotOf = (m: Pick<Result, 'title' | 'year' | 'rating' | 'genres' | 'overview' | 'background' | 'poster' | 'state' | 'quality'>): Spot => ({
  title: m.title,
  meta: [m.year, m.rating && `★ ${m.rating}`, ...(m.genres ?? []).slice(0, 3)].filter(Boolean).join('  ·  '),
  overview: m.overview || '',
  art: m.background || m.poster,
  badge: m.state === 'ready' ? `In our library${m.quality ? ` · ${m.quality}` : ''}` : inFlight(m.state) ? stateText(m.state) : undefined,
})

export function TvHome() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab | null) ?? 'now'
  const setTab = (t: Tab) => { if (t !== tab) setParams(t === 'now' ? {} : { tab: t }, { replace: true }) }
  const party = useTvPlay()
  const [spot, setSpot] = useState<Spot | null>(null)
  // Down in the rows (the title area compact) or up top (the full one, with its buttons).
  const [inRows, setInRows] = useState(false)
  // Images swap a beat after focus settles, not on every poster flown past.
  const spotT = useRef(0)
  const showSpot = (s: Spot | null) => { window.clearTimeout(spotT.current); spotT.current = window.setTimeout(() => setSpot(s), 160) }
  useEffect(() => { const t = window.setTimeout(() => focusFirst(), 60); return () => window.clearTimeout(t) }, [])
  return (
    <div className="tv-home" data-tab={tab}>
      <header className="tv-top">
        <span className="tv-brand"><img src="/footer-avatar.png" alt="" />CRCMZ</span>
        <nav className="tv-tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="tv-tab" aria-selected={tab === t.id}
              onFocus={() => { setTab(t.id); setInRows(false); showSpot(null) }} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <PartyPill now={party.now} onJoin={party.join} />
      </header>
      {tab === 'now' && <WatchNow spot={spot} showSpot={showSpot} inRows={inRows} setInRows={setInRows} party={party} />}
      {tab === 'library' && <LibraryTab />}
      {tab === 'search' && <SearchTab />}
      {party.confirm}
    </div>
  )
}

function PartyPill({ now, onJoin }: { now?: NowPlaying; onJoin: () => void }) {
  const live = !!now && now.watching > 0
  return (
    <button type="button" className="tv-pill" data-live={live} onClick={onJoin}>
      {live && <span className="tv-dot" aria-hidden="true" />}
      {live ? `${now.watching} watching${now.title ? ` · ${now.title}` : ''}` : 'Start a party'}
    </button>
  )
}

// ── Watch Now ───────────────────────────────────────────────────────────────
function WatchNow({ spot, showSpot, inRows, setInRows, party }: {
  spot: Spot | null; showSpot: (s: Spot | null) => void; inRows: boolean; setInRows: (v: boolean) => void; party: ReturnType<typeof useTvPlay>
}) {
  const navigate = useNavigate()
  const home = useQuery({ queryKey: ['movies', 'home', ''], queryFn: ({ signal }) => getHome('', signal), staleTime: 10 * 60_000 })
  const lib = useLibraryQ()
  const featured = home.data?.featured ?? null
  const shown = spot ?? (featured ? spotOf(featured) : null)
  const live = !!party.now && party.now.watching > 0
  const hero = () => { setInRows(false); showSpot(null) }
  const open = (imdb: string) => navigate(`/tv/m/${imdb}`)
  return (
    <>
      <Backdrop src={shown?.art || ''} className="tv-backdrop" />
      <section className="tv-spot" data-rows={inRows} aria-live="polite">
        {shown ? (
          <>
            {!inRows && <p className="tv-kicker">{live ? 'Watch party on' : 'Featured today'}</p>}
            <h1 className="tv-spot-h">{shown.title}</h1>
            {shown.meta && <p className="tv-spot-meta">{shown.meta}</p>}
            {shown.badge && <p className="tv-badge">{shown.badge}</p>}
            {shown.overview && <p className="tv-spot-text">{shown.overview}</p>}
          </>
        ) : home.isPending ? <span className="tv-skel tv-skel-title" /> : <h1 className="tv-spot-h">Watch Party</h1>}
        <div className="tv-spot-acts">
          {live && (
            <button type="button" className="tv-btn tv-btn-primary" data-tv-autofocus onFocus={hero} onClick={party.join}>
              <Icon name="play" />Join the party{party.now?.title ? ` · ${party.now.title}` : ''}
            </button>
          )}
          {featured && (
            <button type="button" className={`tv-btn${live ? '' : ' tv-btn-primary'}`} data-tv-autofocus={!live || undefined} onFocus={hero} onClick={() => open(featured.imdb)}>
              {featured.state === 'ready' ? <><Icon name="play" />Watch {featured.title}</> : <><Icon name="info" />More about {featured.title}</>}
            </button>
          )}
        </div>
      </section>
      <div className="tv-rows" onFocus={(e) => { if ((e.target as HTMLElement).closest('.tv-shelf')) setInRows(true) }}>
        <ContinueRow onPlay={party.play} onFocusItem={showSpot} />
        <LibraryRows movies={lib.data?.movies ?? []} adding={lib.data?.adding ?? []} onOpen={open} onPlay={party.play} onFocusItem={showSpot} />
        {home.isPending ? <SkeletonRow /> : home.data?.rows.map((r) => (
          <Row key={r.id} title={r.title}>
            {r.items.map((m) => (
              <li key={m.imdb}><Poster m={m} onClick={() => open(m.imdb)} onFocus={() => showSpot(spotOf(m))} /></li>
            ))}
          </Row>
        ))}
      </div>
    </>
  )
}

function useLibraryQ() {
  return useQuery({
    queryKey: ['movies', 'library'], queryFn: ({ signal }) => getLibrary(signal),
    refetchInterval: (q) => (q.state.data?.adding.some((a) => inFlight(a.status)) ? 8000 : false),
  })
}

const resumeAt = (it: HistItem) => Math.max(0, (it.mine ? it.mine.position : it.position) - 3)

function ContinueRow({ onPlay, onFocusItem }: { onPlay: (url: string, title: string, at?: number) => void; onFocusItem: (s: Spot | null) => void }) {
  const q = useQuery({ queryKey: ['watch', 'history', 'mine', 'continue'], queryFn: ({ signal }) => listHistory({ mine: true }, signal), staleTime: 60_000 })
  const items = (q.data?.items ?? []).filter((it) => isMovieStream(it.url) && it.mine && !it.mine.finished && it.mine.position > 60)
  if (!items.length) return null
  return (
    <Row title="Continue watching">
      {items.slice(0, 12).map((it) => (
        <li key={it.url}>
          <Poster
            m={{ title: it.title || 'Untitled', poster: it.poster || '', state: 'ready' }}
            pct={it.duration ? ((it.mine?.position ?? 0) / it.duration) * 100 : 0}
            sub={`Resume ${fmtTime(resumeAt(it))}`}
            onClick={() => onPlay(it.url, it.title, resumeAt(it))}
            onFocus={() => onFocusItem({ title: it.title || 'Untitled', meta: `Resume at ${fmtTime(resumeAt(it))}`, overview: '', art: it.poster || '' })}
          />
        </li>
      ))}
    </Row>
  )
}

function LibraryRows({ movies, adding, onOpen, onPlay, onFocusItem }: {
  movies: Movie[]; adding: Adding[]; onOpen: (imdb: string) => void; onPlay: (url: string, title: string) => void; onFocusItem: (s: Spot | null) => void
}) {
  const coming = adding.filter((a) => inFlight(a.status) || a.status === 'failed')
  return (
    <>
      {movies.length > 0 && (
        <Row title={`In our library · ${movies.length}`}>
          {movies.map((m) => (
            <li key={m.id}>
              <Poster m={{ title: m.title, year: m.year, poster: m.poster, state: 'ready', quality: m.quality }}
                onClick={() => (m.imdb ? onOpen(m.imdb) : onPlay(streamUrl(m.id), m.title))}
                onFocus={() => onFocusItem({ title: m.title, meta: [m.year, m.quality].filter(Boolean).join('  ·  '), overview: m.overview, art: m.poster, badge: 'In our library' })} />
            </li>
          ))}
        </Row>
      )}
      {coming.length > 0 && (
        <Row title="On the way">
          {coming.map((a) => (
            <li key={a.imdb}>
              <Poster m={{ title: a.title, year: a.year, poster: a.poster, state: a.status, progress: a.progress, quality: a.quality }}
                onClick={() => onOpen(a.imdb)}
                onFocus={() => onFocusItem({ title: a.title, meta: a.year, overview: a.error || '', art: a.poster, badge: stateText(a.status, a.progress) })} />
            </li>
          ))}
        </Row>
      )}
    </>
  )
}

// ── Library tab ─────────────────────────────────────────────────────────────
function LibraryTab() {
  const navigate = useNavigate()
  const party = useTvPlay()
  const lib = useLibraryQ()
  const movies = lib.data?.movies ?? []
  const coming = (lib.data?.adding ?? []).filter((a) => inFlight(a.status) || a.status === 'failed')
  return (
    <div className="tv-page">
      <h2 className="tv-row-h">In our library{movies.length ? ` · ${movies.length}` : ''}</h2>
      {lib.isPending ? <SkeletonRow /> : movies.length === 0 ? (
        <p className="tv-empty">Nothing here yet. Find a movie in Watch Now or Search and press Add to library.</p>
      ) : (
        <ul className="tv-grid">
          {movies.map((m) => (
            <li key={m.id}>
              <Poster m={{ title: m.title, year: m.year, poster: m.poster, state: 'ready', quality: m.quality }}
                onClick={() => (m.imdb ? navigate(`/tv/m/${m.imdb}`) : party.play(streamUrl(m.id), m.title))} />
            </li>
          ))}
        </ul>
      )}
      {coming.length > 0 && (
        <Row title="On the way">
          {coming.map((a) => (
            <li key={a.imdb}>
              <Poster m={{ title: a.title, year: a.year, poster: a.poster, state: a.status, progress: a.progress, quality: a.quality }} onClick={() => navigate(`/tv/m/${a.imdb}`)} />
            </li>
          ))}
        </Row>
      )}
      {party.confirm}
    </div>
  )
}

// ── Search tab ──────────────────────────────────────────────────────────────
const GENRES = ['Action', 'Comedy', 'Horror', 'Thriller', 'Sci-Fi', 'Drama', 'Animation', 'Crime', 'Romance', 'Family', 'Documentary', 'War']

function SearchTab() {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  const [genre, setGenre] = useState('')
  useEffect(() => { const t = window.setTimeout(() => setQ(text.trim()), 400); return () => window.clearTimeout(t) }, [text])
  const searching = q.length >= 2
  const res = useQuery({
    queryKey: searching ? ['movies', 'search', q.toLowerCase()] : ['movies', 'catalog', 'popular', genre, 0],
    queryFn: ({ signal }) => (searching ? searchMovies(q, signal) : getCatalog('popular', genre, 0, signal)),
    placeholderData: (p) => p, staleTime: 60_000,
  })
  const items = useMemo(() => {
    const seen = new Set<string>()
    return ((res.data?.results ?? []) as Result[]).filter((m) => (seen.has(m.imdb) ? false : (seen.add(m.imdb), true)))
  }, [res.data])
  return (
    <div className="tv-page">
      <form className="tv-search" role="search" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()); (document.activeElement as HTMLElement)?.blur() }}>
        <Icon name="search" />
        <input className="tv-input" type="search" placeholder="Search movies" value={text} onChange={(e) => setText(e.target.value)}
          aria-label="Search movies" autoComplete="off" enterKeyHint="search" />
      </form>
      {!searching && (
        <div className="tv-chips" role="toolbar" aria-label="Genre">
          {['', ...GENRES].map((g) => (
            <button key={g || 'all'} type="button" className="tv-chip" aria-pressed={genre === g} onClick={() => setGenre(g)}>{g || 'Popular'}</button>
          ))}
        </div>
      )}
      <h2 className="tv-row-h">{searching ? `Results for “${q}”` : genre ? `Popular ${genre}` : 'Popular right now'}</h2>
      {res.isPending ? <SkeletonRow /> : items.length === 0 ? <p className="tv-empty">Nothing found{searching ? ` for “${q}”` : ''}.</p> : (
        <ul className="tv-grid">
          {items.map((m) => <li key={m.imdb}><Poster m={m} onClick={() => navigate(`/tv/m/${m.imdb}`)} /></li>)}
        </ul>
      )}
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────
function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="tv-row">
      <h2 className="tv-row-h">{title}</h2>
      <ul className="tv-shelf" data-tv-row>{children}</ul>
    </section>
  )
}

function SkeletonRow() {
  return <ul className="tv-shelf" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((i) => <li key={i}><span className="tv-poster-art tv-skel" /></li>)}</ul>
}

type PosterM = { title: string; year?: string; poster: string; state: MovieState; progress?: number; quality?: string; rating?: string }

export function Poster({ m, onClick, onFocus, pct, sub }: { m: PosterM; onClick: () => void; onFocus?: () => void; pct?: number; sub?: string }) {
  const [broken, setBroken] = useState(false)
  const busy = inFlight(m.state)
  const bar = pct ?? (busy && measured(m.state) ? m.progress ?? 0 : undefined)
  return (
    <button type="button" className="tv-poster" onClick={onClick} onFocus={onFocus}
      aria-label={`${m.title}${m.year ? ` (${m.year})` : ''}${m.state === 'ready' ? ', in our library' : ''}`}>
      <span className="tv-poster-art">
        {m.poster && !broken
          ? <img src={m.poster} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          : <span className="tv-poster-fallback">{m.title}</span>}
        {m.state === 'ready' && !sub && <span className="tv-have" aria-hidden="true"><Icon name="play" /></span>}
        {(bar !== undefined || busy) && <span className="tv-bar" data-indeterminate={bar === undefined || undefined}><i style={bar !== undefined ? { width: `${Math.max(4, Math.min(100, bar))}%` } : undefined} /></span>}
      </span>
      <span className="tv-poster-title">{m.title}</span>
      <span className="tv-poster-sub">{sub ?? (busy ? stateText(m.state, m.progress) : [m.year, m.state === 'ready' ? m.quality || 'In library' : m.rating ? `★ ${m.rating}` : ''].filter(Boolean).join(' · '))}</span>
    </button>
  )
}
