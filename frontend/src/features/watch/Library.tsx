// Watch party · Library, under the player. Downloaded: the films in Jellyfin, ready for
// the party, and what's on its way. Whoever added a film (or an admin) can remove it
// again. Watched: history. Finding and adding movies is the Movies home (/watch).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import * as Tabs from '@radix-ui/react-tabs'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { ConfirmDialog } from '../clips/ClipSheet'
import { ApiError } from '../../lib/http'
import { useReducedMotion } from '../../lib/media'
import {
  addMovie, getLibrary, removeMovie, inFlight, measured, stateText, streamUrl,
  type Adding, type Library as LibraryData, type Movie, type Result,
} from '../../lib/movies'
import { Watched } from './History'
import { hostMovie, useWatch } from './session'

type Tab = 'downloaded' | 'watched'
const TAB_KEY = 'watch.library.tab'
const TABS: Tab[] = ['downloaded', 'watched']

export function Library() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = sessionStorage.getItem(TAB_KEY) as Tab
    return TABS.includes(t) ? t : 'downloaded'
  })
  useEffect(() => { try { sessionStorage.setItem(TAB_KEY, tab) } catch { /* private mode */ } }, [tab])
  return (
    <section className="wp-library" aria-labelledby="wp-lib-h">
      <div className="mv-row-head">
        <h2 className="section-h2" id="wp-lib-h">Library</h2>
        <Link className="btn btn-ghost mv-see" to="/watch"><Icon name="search" />Browse all movies</Link>
      </div>
      <Tabs.Root value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <Tabs.List className="seg mv-tabs" aria-label="Library">
          <Tabs.Trigger value="downloaded" className="seg-tab">Downloaded</Tabs.Trigger>
          <Tabs.Trigger value="watched" className="seg-tab">Watched</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="downloaded" className="mv-panel"><Downloaded /></Tabs.Content>
        <Tabs.Content value="watched" className="mv-panel"><Watched /></Tabs.Content>
      </Tabs.Root>
    </section>
  )
}

function useLibrary() {
  return useQuery({
    queryKey: ['movies', 'library'],
    queryFn: ({ signal }) => getLibrary(signal),
    refetchInterval: (q) => (q.state.data?.adding.some((a) => inFlight(a.status)) ? 8000 : false),
  })
}

function usePlay() {
  const s = useWatch()
  const reduced = useReducedMotion()
  const live = s.status === 'live'
  return {
    live,
    playing: (id: string) => s.video === streamUrl(id),
    play(id: string, title: string) {
      if (!hostMovie(streamUrl(id), title)) return
      document.querySelector('.wp-screen')?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
    },
  }
}

// ── Downloaded ──────────────────────────────────────────────────────────────
function Downloaded() {
  const q = useLibrary()
  const p = usePlay()
  if (q.isError && !q.data) return <ErrorStrip text="The library didn't load" onRetry={() => q.refetch()} />
  if (q.isPending) return <SkeletonRows n={2} height={120} />
  const { movies, adding } = q.data
  return (
    <>
      {adding.length > 0 && (
        <ul className="mv-adding" aria-label="On the way">
          {adding.map((a) => <li key={a.imdb}><AddingRow a={a} /></li>)}
        </ul>
      )}
      {movies.length === 0 ? (
        <div className="glass empty">
          <p className="empty-title">No movies yet</p>
          <p className="meta">Find one and add it. It shows up here when it's ready to watch together.</p>
          <Link className="btn btn-primary" to="/watch"><Icon name="search" />Find a movie</Link>
        </div>
      ) : (
        <>
          {!p.live && <p className="meta mv-hint">Join the party above to play a movie for everyone.</p>}
          <ul className="mv-grid">
            {movies.map((m) => <li key={m.id}><MovieCard m={m} live={p.live} playing={p.playing(m.id)} onPlay={() => p.play(m.id, m.title)} /></li>)}
          </ul>
        </>
      )}
    </>
  )
}

function MovieCard({ m, live, playing, onPlay }: { m: Movie; live: boolean; playing: boolean; onPlay: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  async function doRemove() {
    setBusy(true)
    try {
      await removeMovie(m.id)
      qc.setQueryData<LibraryData>(['movies', 'library'], (d) => d && { ...d, movies: d.movies.filter((x) => x.id !== m.id) })
      void qc.invalidateQueries({ queryKey: ['movies'] })
      toast(`${m.title} is out of the library`, 'success')
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "That movie didn't come out", 'error')
    } finally { setBusy(false) }
  }
  return (
    <article className="glass mv-card" aria-label={m.year ? `${m.title} (${m.year})` : m.title}>
      <Poster src={m.poster} title={m.title} badge={m.quality} />
      <div className="mv-body">
        <h3 className="mv-title">{m.title}{m.year && <span className="dim"> ({m.year})</span>}</h3>
        {m.by && <p className="meta">Added by {m.by}</p>}
        <div className="mv-acts">
          {playing ? (
            <span className="wp-playing"><span className="wp-live-dot" aria-hidden="true" />Playing</span>
          ) : (
            <button type="button" className="btn btn-primary mv-act" onClick={onPlay} disabled={!live}
              aria-label={`Play ${m.title} for the party`}>
              <Icon name="play" />Play
            </button>
          )}
          {m.can_remove && (
            <button type="button" className="icon-btn" onClick={() => setConfirm(true)} disabled={busy || playing}
              aria-label={`Remove ${m.title} from the library`}>
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} title="Remove this movie?" action="Remove"
        body={<p>Take ‘{m.title}’ out of the library for everyone? You can add it again later.</p>}
        onConfirm={() => void doRemove()}
      />
    </article>
  )
}

function AddingRow({ a }: { a: Adding }) {
  const busy = inFlight(a.status)
  return (
    <div className="glass mv-add" data-status={a.status}>
      <span className="mv-add-art" aria-hidden="true">{a.poster ? <img src={a.poster} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="watch" />}</span>
      <span className="mv-add-text">
        <span className="mv-title">{a.title}{a.year && <span className="dim"> ({a.year})</span>}</span>
        <span className="meta">
          <span className="find-chip" data-tone={a.status === 'failed' ? 'bad' : 'live'} role="status">{stateText(a.status, a.progress)}</span>
          {a.quality && a.status !== 'failed' ? ` ${a.quality}` : ''}{a.by ? ` · added by ${a.by}` : ''}
        </span>
        {a.status === 'failed' && a.error && <span className="meta">{a.error}</span>}
        {busy && (
          <span className="mv-bar" role="progressbar" aria-label={`${a.title} progress`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={measured(a.status) ? Math.floor(a.progress) : undefined} data-indeterminate={!measured(a.status) || undefined}>
            <i style={measured(a.status) ? { width: `${Math.max(3, a.progress)}%` } : undefined} />
          </span>
        )}
      </span>
      {a.status === 'failed' && <TryAgain imdb={a.imdb} title={a.title} />}
    </div>
  )
}

function AddButton({ imdb, title, again = false }: { imdb: string; title: string; again?: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    try {
      const a = await addMovie(imdb)
      const patch = (d?: { results: Result[] }) => d && { results: d.results.map((x) => (x.imdb === imdb ? { ...x, state: a.status, id: a.id, progress: a.progress, quality: a.quality || x.quality } : x)) }
      qc.setQueriesData<{ results: Result[] }>({ queryKey: ['movies', 'search'] }, patch)
      qc.setQueriesData<{ results: Result[] }>({ queryKey: ['movies', 'popular'] }, patch)
      qc.setQueryData<LibraryData>(['movies', 'library'], (d) => d && a.status !== 'ready'
        ? { ...d, adding: [a, ...d.adding.filter((x) => x.imdb !== imdb)] } : d)
      void qc.invalidateQueries({ queryKey: ['movies', 'library'] })
      toast(a.status === 'ready' ? `${title} is already in the library` : `Adding ${title}. We'll tell everyone when it's ready.`, 'success')
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "That movie didn't add", 'error')
    } finally { setBusy(false) }
  }
  return (
    <button type="button" className={`btn ${again ? 'btn-secondary' : 'btn-primary'} mv-act`} onClick={() => void go()} disabled={busy}
      aria-label={`${again ? 'Try adding' : 'Add'} ${title} ${again ? 'again' : 'to the library'}`}>
      <Icon name={again ? 'refresh' : 'plus'} />{busy ? 'Adding…' : again ? 'Try again' : 'Add to library'}
    </button>
  )
}

function TryAgain({ imdb, title }: { imdb: string; title: string }) {
  return <AddButton imdb={imdb} title={title} again />
}

function Poster({ src, title, badge }: { src: string; title: string; badge: string }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className="mv-poster">
      {src && !broken ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : <span aria-hidden="true">{title.slice(0, 1)}</span>}
      {badge && <span className="wp-card-kind">{badge}</span>}
    </div>
  )
}
