// Watch · Movies, the home of Watch. A featured film, then rows of posters: what you
// were watching, what's in our library, what's on its way, and what's out there
// (trending, new, highest rated, by genre). Search finds anything; a genre chip turns
// every row into that genre; "See all" opens a full grid. Tapping a poster opens the
// movie's sheet (?m=<imdb id>), where it's added to the library or played for the party.
// The party itself lives at /watch/party.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { HelpLink } from '../../components/HelpLink'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { fmtTime, listHistory, type HistItem } from '../../lib/watch'
import {
  getCatalog, getHome, getLibrary, inFlight, isMovieStream, measured, searchMovies, stateText,
  type Adding, type ListKind, type Movie, type Result, type Row,
} from '../../lib/movies'
import { useMoviesOff } from './Library'
import { MovieSheet, useNow, usePartyPlay } from './MovieSheet'

const LIST_TITLES: Record<ListKind, (g: string) => string> = {
  popular: (g) => (g ? `Popular ${g}` : 'Trending now'),
  new: (g) => `New in ${g || new Date().getFullYear()}`,
  top: (g) => (g ? `Highest rated ${g}` : 'Highest rated'),
}

export function MoviesHome() {
  useTitle('Watch')
  // An app-store review account has no movie library: Watch is the party.
  if (useMoviesOff()) return <Navigate to="/watch/party" replace />
  return <Movies />
}

function Movies() {
  const [params, setParams] = useSearchParams()
  const genre = params.get('genre') || ''
  const list = params.get('list') as ListKind | null
  const imdb = params.get('m')
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const t = window.setTimeout(() => setQ(text.trim()), 300); return () => window.clearTimeout(t) }, [text])
  const searching = q.length >= 2

  function patch(next: Record<string, string | null>, replace = false) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) { if (v) p.set(k, v); else p.delete(k) }
    setParams(p, { replace })
  }
  const open = (id: string) => patch({ m: id })

  useLibraryLink()
  const party = usePartyPlay()

  return (
    <div className="page mv-home">
      <div className="mv-head">
        <h1 className="page-h1" tabIndex={-1}>Watch<HelpLink id="watch" /></h1>
      </div>
      <PartyBanner />
      <form className="mv-search mv-home-search" role="search" onSubmit={(e) => { e.preventDefault(); setQ(text.trim()) }}>
        <label htmlFor="mv-q" className="sr-only">Search movies</label>
        <Icon name="search" className="mv-search-icon" />
        <input id="mv-q" type="search" className="input" placeholder="Search movies" value={text}
          onChange={(e) => setText(e.target.value)} autoComplete="off" enterKeyHint="search" />
      </form>
      {!searching && (
        <Genres genre={genre} onPick={(g) => patch({ genre: g || null, list: null })} />
      )}
      {searching ? <SearchResults q={q} onOpen={open} />
        : list ? <SeeAll kind={list} genre={genre} onOpen={open} onBack={() => patch({ list: null })} />
        : <Rows genre={genre} onOpen={open} onSeeAll={(r) => patch({ list: r.kind, genre: r.genre || null })}
            onResume={(it) => party.play(it.url, it.title, resumeAt(it))} />}
      <MovieSheet imdb={imdb} onClose={() => patch({ m: null })} onGenre={(g) => patch({ m: null, genre: g, list: null })} party={party} />
      {party.confirm}
    </div>
  )
}

/** Notifications link to /watch?library=downloaded: land on the library row. */
function useLibraryLink() {
  const [params, setParams] = useSearchParams()
  const want = params.get('library')
  useEffect(() => {
    if (want === null) return
    const p = new URLSearchParams(params)
    p.delete('library')
    setParams(p, { replace: true })
    const t = window.setTimeout(() => document.getElementById('mv-library')?.scrollIntoView({ block: 'start' }), 300)
    return () => window.clearTimeout(t)
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps
}

// ── The party, at a glance ──────────────────────────────────────────────────
function PartyBanner() {
  const now = useNow().data
  const live = !!now && now.watching > 0
  return (
    <section className="glass mv-party" data-live={live} aria-label="Watch party">
      {live ? (
        <>
          <span className="mv-party-dot" aria-hidden="true" />
          <span className="mv-party-text">
            <span className="mv-party-h">Party on · {now.watching} watching</span>
            <span className="meta">{now.title ? `${now.paused ? 'Paused on' : 'Watching'} ${now.title}` : now.video ? 'Something is on' : 'Picking what to watch'}</span>
          </span>
          <Link className="btn btn-primary" to="/watch/party"><Icon name="watch" />Join</Link>
        </>
      ) : (
        <>
          <span className="mv-party-text">
            <span className="mv-party-h">Start a watch party</span>
            <span className="meta">Pick a movie below and press Watch together, or paste any video link.</span>
          </span>
          <span className="mv-party-acts">
            <Link className="btn btn-primary" to="/watch/party"><Icon name="watch" />Start</Link>
            <Link className="btn btn-secondary" to="/watch/party?paste=1"><Icon name="link" />Paste a link</Link>
          </span>
        </>
      )}
    </section>
  )
}

// ── Genres ──────────────────────────────────────────────────────────────────
const GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
  'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western']

function Genres({ genre, onPick }: { genre: string; onPick: (g: string) => void }) {
  return (
    <div className="chips mv-genres" role="toolbar" aria-label="Genre">
      {['', ...GENRES].map((g) => (
        <button key={g || 'all'} type="button" className="chip" aria-pressed={genre === g} onClick={() => onPick(g)}>{g || 'All'}</button>
      ))}
    </div>
  )
}

// ── Rows ────────────────────────────────────────────────────────────────────
function Rows({ genre, onOpen, onSeeAll, onResume }: {
  genre: string; onOpen: (imdb: string) => void; onSeeAll: (r: Row) => void; onResume: (it: HistItem) => void
}) {
  const home = useQuery({ queryKey: ['movies', 'home', genre], queryFn: ({ signal }) => getHome(genre, signal), staleTime: 10 * 60_000 })
  const lib = useQuery({
    queryKey: ['movies', 'library'], queryFn: ({ signal }) => getLibrary(signal),
    refetchInterval: (q) => (q.state.data?.adding.some((a) => inFlight(a.status)) ? 8000 : false),
  })
  if (home.isError && !home.data) return <ErrorStrip text="Movies didn't load" onRetry={() => home.refetch()} />
  const featured = genre ? home.data?.rows[0]?.items.find((m) => m.background) ?? null : home.data?.featured ?? null
  return (
    <>
      {home.isPending ? <div className="mv-hero mv-hero-skel" aria-hidden="true" /> : featured && <Hero m={featured} onOpen={onOpen} />}
      {!genre && <ContinueRow onResume={onResume} />}
      {!genre && <LibraryRows movies={lib.data?.movies ?? []} adding={lib.data?.adding ?? []} pending={lib.isPending} onOpen={onOpen} />}
      {home.isPending ? [0, 1, 2].map((i) => <RowSkeleton key={i} />)
        : home.data.rows.map((r) => (
          <PosterRow key={r.id} id={`mv-row-${r.id}`} title={r.title} onSeeAll={() => onSeeAll(r)}>
            {r.items.map((m) => <li key={m.imdb}><Poster m={m} onOpen={() => onOpen(m.imdb)} /></li>)}
          </PosterRow>
        ))}
    </>
  )
}

function Hero({ m, onOpen }: { m: Result; onOpen: (imdb: string) => void }) {
  return (
    <section className="mv-hero" aria-labelledby="mv-hero-h">
      <Backdrop src={m.background || m.poster} className="mv-hero-bg" />
      <div className="mv-hero-body">
        <p className="disc-kicker">Featured today</p>
        <h2 className="mv-hero-h" id="mv-hero-h">{m.title}</h2>
        <p className="mv-hero-meta">
          {[m.year, m.rating && `★ ${m.rating}`, ...(m.genres ?? []).slice(0, 2)].filter(Boolean).join(' · ')}
        </p>
        <div className="mv-hero-acts">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(m.imdb)}>
            {m.state === 'ready' ? <><Icon name="play" />Watch together</> : <><Icon name="info" />See the movie</>}
          </button>
          {m.state === 'ready' && <span className="mv-badge" data-tone="ok">In our library</span>}
          {inFlight(m.state) && <span className="mv-badge" data-tone="live">{stateText(m.state, m.progress)}</span>}
        </div>
      </div>
    </section>
  )
}

function PosterRow({ id, title, count, onSeeAll, children }: { id: string; title: string; count?: number; onSeeAll?: () => void; children: React.ReactNode }) {
  return (
    <section className="mv-row" id={id} aria-labelledby={`${id}-h`}>
      <div className="mv-row-head">
        <h2 className="section-h2" id={`${id}-h`}>{title}{count ? <span className="dim num"> {count}</span> : null}</h2>
        {onSeeAll && <button type="button" className="btn btn-ghost mv-see" onClick={onSeeAll} aria-label={`See all: ${title}`}>See all<Icon name="right" /></button>}
      </div>
      <ul className="mv-shelf">{children}</ul>
    </section>
  )
}

function RowSkeleton() {
  return (
    <div className="mv-row" aria-hidden="true">
      <div className="mv-row-head"><span className="skeleton" style={{ width: 140, height: 18 }} /></div>
      <ul className="mv-shelf">{[0, 1, 2, 3].map((i) => <li key={i}><span className="mv-tile-art skeleton" /></li>)}</ul>
    </div>
  )
}

/** A backdrop: metahub's 1 MB image fades in over its 18 KB small one, blurred. */
export function Backdrop({ src, className }: { src: string; className: string }) {
  const [loaded, setLoaded] = useState(false)
  if (!src) return null
  const small = src.replace(/\/(medium|large)\/(tt\d+)\//, '/small/$2/')
  return (
    <span className={`${className} mv-backdrop`} style={{ backgroundImage: `url("${small}")` }} aria-hidden="true">
      <img src={src} alt="" decoding="async" referrerPolicy="no-referrer" data-loaded={loaded} onLoad={() => setLoaded(true)} />
    </span>
  )
}

/** A poster card: art, rating, whether we have it, title and year. */
export function Poster({ m, onOpen }: { m: Pick<Result, 'imdb' | 'title' | 'year' | 'poster' | 'rating' | 'state' | 'progress' | 'quality'>; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  return (
    <button type="button" className="mv-tile" onClick={onOpen} aria-label={`${m.title}${m.year ? ` (${m.year})` : ''}${m.state === 'ready' ? ', in our library' : ''}`}>
      <span className="mv-tile-art">
        {m.poster && !broken
          ? <img src={m.poster} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          : <span className="mv-tile-fallback" aria-hidden="true">{m.title}</span>}
        {m.rating ? <span className="mv-rating num" aria-hidden="true">★ {m.rating}</span> : null}
        {m.state === 'ready' && <span className="mv-have" aria-hidden="true" title="In our library"><Icon name="play" /></span>}
        {inFlight(m.state) && (
          <span className="mv-tile-bar" aria-hidden="true"><i style={measured(m.state) ? { width: `${Math.max(4, m.progress)}%` } : undefined} data-indeterminate={!measured(m.state) || undefined} /></span>
        )}
      </span>
      <span className="mv-tile-title">{m.title}</span>
      <span className="mv-tile-sub">{inFlight(m.state) ? stateText(m.state, m.progress) : [m.year, m.state === 'ready' ? m.quality || 'In library' : ''].filter(Boolean).join(' · ')}</span>
    </button>
  )
}

// ── Ours: continue watching, the library, on its way ───────────────────────
const resumeAt = (it: HistItem) => {
  const pos = it.mine ? it.mine.position : it.position
  return Math.max(0, pos - 3)
}

function ContinueRow({ onResume }: { onResume: (it: HistItem) => void }) {
  const q = useQuery({ queryKey: ['watch', 'history', 'mine', 'continue'], queryFn: ({ signal }) => listHistory({ mine: true }, signal), staleTime: 60_000 })
  const items = (q.data?.items ?? []).filter((it) => isMovieStream(it.url) && it.mine && !it.mine.finished && it.mine.position > 60)
  if (!items.length) return null
  return (
    <PosterRow id="mv-continue" title="Continue watching">
      {items.slice(0, 12).map((it) => {
        const pct = it.duration ? Math.min(100, ((it.mine?.position ?? 0) / it.duration) * 100) : 0
        return (
          <li key={it.url}>
            <button type="button" className="mv-tile" onClick={() => onResume(it)}
              aria-label={`Resume ${it.title || 'this movie'} at ${fmtTime(resumeAt(it))} with the party`}>
              <span className="mv-tile-art">
                {it.poster ? <img src={it.poster} alt="" loading="lazy" decoding="async" /> : <span className="mv-tile-fallback" aria-hidden="true">{it.title}</span>}
                <span className="mv-have" aria-hidden="true"><Icon name="play" /></span>
                <span className="mv-tile-bar" aria-hidden="true"><i style={{ width: `${Math.max(4, pct)}%` }} /></span>
              </span>
              <span className="mv-tile-title">{it.title || 'Untitled'}</span>
              <span className="mv-tile-sub">Resume {fmtTime(resumeAt(it))}</span>
            </button>
          </li>
        )
      })}
    </PosterRow>
  )
}

function LibraryRows({ movies, adding, pending, onOpen }: { movies: Movie[]; adding: Adding[]; pending: boolean; onOpen: (imdb: string) => void }) {
  const navigate = useNavigate()
  const coming = adding.filter((a) => inFlight(a.status) || a.status === 'failed')
  return (
    <>
      {coming.length > 0 && (
        <PosterRow id="mv-coming" title="On the way">
          {coming.map((a) => (
            <li key={a.imdb}>
              <Poster m={{ imdb: a.imdb, title: a.title, year: a.year, poster: a.poster, rating: '', state: a.status, progress: a.progress, quality: a.quality }}
                onOpen={() => onOpen(a.imdb)} />
            </li>
          ))}
        </PosterRow>
      )}
      <PosterRow id="mv-library" title="In our library" count={movies.length || undefined}>
        {pending ? [0, 1, 2].map((i) => <li key={i}><span className="mv-tile-art skeleton" /></li>)
          : movies.length === 0 ? (
            <li className="mv-shelf-empty">
              <p className="meta">Nothing here yet. Open any movie and press <b>Add to library</b>; it shows up here when it's ready.</p>
            </li>
          ) : movies.map((m) => (
            <li key={m.id}>
              <Poster m={{ imdb: m.imdb, title: m.title, year: m.year, poster: m.poster, rating: '', state: 'ready', progress: 0, quality: m.quality }}
                onOpen={() => (m.imdb ? onOpen(m.imdb) : navigate('/watch/party'))} />
            </li>
          ))}
      </PosterRow>
    </>
  )
}

// ── See all and search ──────────────────────────────────────────────────────
function SeeAll({ kind, genre, onOpen, onBack }: { kind: ListKind; genre: string; onOpen: (imdb: string) => void; onBack: () => void }) {
  const q = useInfiniteQuery({
    queryKey: ['movies', 'catalog', kind, genre],
    queryFn: ({ pageParam, signal }) => getCatalog(kind, genre, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.results.length ? last.next : undefined),
    staleTime: 10 * 60_000,
  })
  const items = useMemo(() => {
    const seen = new Set<string>()
    return (q.data?.pages ?? []).flatMap((p) => p.results).filter((m) => (seen.has(m.imdb) ? false : (seen.add(m.imdb), true)))
  }, [q.data])
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = end.current
    if (!el) return
    const io = new IntersectionObserver((es) => { if (es[0]?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage() }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [q])
  return (
    <section className="mv-all" aria-labelledby="mv-all-h">
      <div className="mv-row-head">
        <button type="button" className="btn btn-ghost mv-back" onClick={onBack}><Icon name="left" />Back</button>
        <h2 className="section-h2" id="mv-all-h">{LIST_TITLES[kind](genre)}</h2>
      </div>
      {q.isError && !q.data ? <ErrorStrip text="That list didn't load" onRetry={() => q.refetch()} />
        : q.isPending ? <SkeletonRows n={3} height={160} />
        : <Grid items={items} onOpen={onOpen} />}
      <div ref={end} className="mv-end" aria-hidden="true" />
      {q.isFetchingNextPage && <p className="meta mv-hint" role="status">Loading more…</p>}
    </section>
  )
}

function SearchResults({ q, onOpen }: { q: string; onOpen: (imdb: string) => void }) {
  const res = useQuery({ queryKey: ['movies', 'search', q.toLowerCase()], queryFn: ({ signal }) => searchMovies(q, signal), placeholderData: (p) => p, staleTime: 60_000 })
  const rows = res.data?.results ?? []
  return (
    <section className="mv-all" aria-labelledby="mv-res-h" aria-busy={res.isFetching || undefined}>
      <h2 className="section-h2" id="mv-res-h">Results for “{q}”</h2>
      {res.isError && !res.data ? <ErrorStrip text="Search didn't work" onRetry={() => res.refetch()} />
        : res.isPending ? <SkeletonRows n={2} height={160} />
        : rows.length === 0 ? <p className="dim">Nothing found for “{q}”. Try another spelling.</p>
        : <Grid items={rows} onOpen={onOpen} />}
    </section>
  )
}

function Grid({ items, onOpen }: { items: Result[]; onOpen: (imdb: string) => void }) {
  return (
    <ul className="mv-grid-posters">
      {items.map((m) => <li key={m.imdb}><Poster m={m} onOpen={() => onOpen(m.imdb)} /></li>)}
    </ul>
  )
}

