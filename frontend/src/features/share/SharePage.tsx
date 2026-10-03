// Share → CRCMZ from another app (Android's share sheet, the installed web app; the iPhone
// app's share extension does the same natively). The server says what the link is
// (POST /api/share/inspect, share.py) and this offers what to do with it:
//   a song           added to Slap straight away, in your picks, with Undo
//   a film's page    found and added to Movies straight away, with Undo (or pick the
//                    film when it's not clear which)
//   a trailer        the one that asks: add its film, or play the trailer
//   any other video  played in the Watch Party straight away
// The "it's in Slap" notification links back here (?done=<job>) with Undo too.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon, type IconName } from '../../components/Icon'
import { ApiError, request } from '../../lib/http'

const MUSIC = /^https:\/\/(music\.apple\.com|open\.spotify\.com|music\.youtube\.com|soundcloud\.com|(www\.)?deezer\.com|tidal\.com|listen\.tidal\.com)\//i

/** The first link in what was shared ("Song by Artist https://…" is common). */
export function sharedLink(...parts: (string | null)[]): string {
  for (const p of parts) {
    const m = /https?:\/\/\S+/i.exec(p || '')
    if (m) return m[0].replace(/[)\].,!?'"]+$/, '')
  }
  return ''
}
export const isMusicLink = (u: string) => MUSIC.test(u)

type Choice = 'slap' | 'watch' | 'movie' | 'search'
type Movie = { imdb: string; title: string; year: string; poster: string; in_library: boolean }
type Inspect = { link: string; kind: 'song' | 'movie' | 'trailer' | 'video' | 'none'; auto: Choice | null; movie: Movie | null; candidates?: Movie[]; video_title: string; choices: Choice[] }
type Added = { status: 'downloading' | 'already_in_library'; title?: string | null; artist?: string | null; job?: string }
type ShareRow = { job_id: string; title: string; artist: string; status: 'downloading' | 'done' | 'failed' | 'undo' | 'undone'; error: string }

const songName = (t?: string | null, a?: string | null) => (t ? `${t}${a ? ` · ${a}` : ''}` : 'Your song')

export function SharePage() {
  useTitle('Share to CRCMZ')
  const [q] = useSearchParams()
  const done = q.get('done')
  return done ? <SharedSong job={done} /> : <Chooser url={q.get('url')} text={q.get('text')} title={q.get('title')} />
}

function Chooser({ url, text, title }: { url: string | null; text: string | null; title: string | null }) {
  const navigate = useNavigate()
  const [info, setInfo] = useState<Inspect | null>(null)
  const [err, setErr] = useState('')
  const [added, setAdded] = useState<Added | null>(null)
  const [film, setFilm] = useState<Movie | null>(null)   // a film added straight away
  const [busy, setBusy] = useState(false)
  const asked = useRef(false)
  const link = sharedLink(url, text, title)

  async function toSlap(l: string) {
    setBusy(true)
    try { setAdded(await request<Added>('/api/slap/share', { body: { url: l, text: text || '' }, timeoutMs: 45_000 })) } catch (e) {
      setErr(e instanceof ApiError && e.detail ? e.detail : "Couldn't add that song.")
    } finally { setBusy(false) }
  }
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    request<Inspect>('/api/share/inspect', { body: { url: url || '', text: text || '', title: title || '' }, timeoutMs: 20_000 })
      .then((r) => {
        setInfo(r)
        if (r.auto === 'slap') void toSlap(r.link)
        else if (r.auto === 'watch') watch(r.link)
        else if (r.auto === 'movie' && r.movie) {
          if (r.movie.in_library) openMovie(r.movie)
          else void addFilm(r.movie)
        }
      })
      // The server can't tell: fall back on the link itself.
      .catch(() => setInfo({ link, kind: link ? (isMusicLink(link) ? 'song' : 'video') : 'none', auto: null, movie: null, video_title: '', choices: link ? (isMusicLink(link) ? ['slap', 'watch'] : ['watch']) : [] }))
  }, []) // once per share

  function watch(l: string) { navigate(`/watch/party?${new URLSearchParams({ url: l })}`, { replace: true }) }
  function openMovie(m: Movie) { navigate(`/watch?m=${m.imdb}`, { replace: true }) }
  async function addFilm(m: Movie) {
    setBusy(true)
    try {
      // "from: share": it waits a few seconds for Undo before it starts.
      await request('/api/watch/movies/add', { body: { imdb: m.imdb, from: 'share' }, timeoutMs: 30_000 })
      setFilm(m)
    } catch (e) { setErr(e instanceof ApiError && e.detail ? e.detail : "Couldn't add that film.") } finally { setBusy(false) }
  }

  if (!info || info.auto === 'watch' || (info.auto === 'movie' && !film && !err)) {
    return <Card icon="watch"><p className="empty-title" role="status"><span className="spinner" aria-hidden="true" /> {info?.auto === 'movie' ? `Adding ${info.movie?.title ?? 'the film'}…` : info ? 'Opening the Watch Party…' : 'Looking at that link…'}</p></Card>
  }
  if (film) return <FilmAdded m={film} />
  if (added || (info.auto === 'slap' && (busy || err))) {
    return added ? <SongAdded added={added} onWatch={() => watch(info.link)} />
      : err ? <Card><p className="empty-title">Couldn't add it</p><p className="meta">{err}</p><Link className="btn btn-secondary" to="/slap">Open Slap</Link></Card>
      : <Card><p className="empty-title" role="status"><span className="spinner" aria-hidden="true" /> Adding to Slap…</p></Card>
  }
  if (info.kind === 'none') return <Card><p className="empty-title">There's no link in that</p><p className="meta">Share a song, a video or a movie page.</p></Card>
  const m = info.movie
  return (
    <Card icon={info.kind === 'song' ? 'slap' : 'watch'}>
      {m ? (
        <div className="share-movie">
          {m.poster && <img src={m.poster} alt="" className="share-poster" />}
          <div>
            <p className="empty-title">{m.title}{m.year && ` (${m.year})`}</p>
            <p className="meta">{info.kind === 'trailer' ? 'The film this trailer is for' : 'From IMDb'}{m.in_library ? ' · in Movies' : ''}</p>
          </div>
        </div>
      ) : (
        <p className="empty-title share-what">{info.video_title || info.link}</p>
      )}
      {err && <p className="banner" role="alert">{err}</p>}
      {!!info.candidates?.length && <p className="meta">Not sure which film: is it this one, or…</p>}
      <div className="share-choices">
        {info.choices.map((c, i) => {
          const cls = `btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}`
          if (c === 'search') return (
            <button key={c} type="button" className={cls} onClick={() => navigate(`/watch?${new URLSearchParams({ q: info.video_title })}`, { replace: true })}>
              <Icon name="search" />Find the film in Movies
            </button>
          )
          if (c === 'movie' && m) return (
            <button key={c} type="button" className={cls} disabled={busy} onClick={() => (m.in_library ? openMovie(m) : info.kind === 'trailer' ? openMovie(m) : void addFilm(m))}>
              <Icon name="watch" />{m.in_library ? 'Watch it together' : info.kind === 'trailer' ? 'Add the film to Movies' : `Add ${m.title}`}
            </button>
          )
          if (c === 'watch') return (
            <button key={c} type="button" className={cls} onClick={() => watch(info.link)}>
              <Icon name="play" />{info.kind === 'trailer' ? 'Play the trailer in the Watch Party' : 'Play in the Watch Party'}
            </button>
          )
          return (
            <button key={c} type="button" className={cls} disabled={busy} onClick={() => void toSlap(info.link)}>
              <Icon name="slap" />{info.kind === 'song' ? 'Add to Slap' : 'Add the song to Slap'}
            </button>
          )
        })}
        {info.candidates?.map((c) => (
          <button key={c.imdb} type="button" className="btn btn-secondary share-cand" disabled={busy} onClick={() => (c.in_library ? openMovie(c) : void addFilm(c))}>
            {c.title}{c.year && ` (${c.year})`}{c.in_library ? ' · in Movies' : ''}
          </button>
        ))}
        <Link className="btn btn-ghost" to="/">Cancel</Link>
      </div>
    </Card>
  )
}

/** A film added straight away: it waits a few seconds for Undo before it starts. */
function FilmAdded({ m }: { m: Movie }) {
  const [undone, setUndone] = useState(false)
  const [err, setErr] = useState('')
  const [left, setLeft] = useState(20)
  useEffect(() => {
    const t = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000)
    return () => window.clearInterval(t)
  }, [])
  async function undo() {
    try { await request('/api/watch/movies/undo', { body: { imdb: m.imdb } }); setUndone(true) } catch (e) {
      setErr(e instanceof ApiError && e.detail ? e.detail : "Couldn't undo that.")
    }
  }
  if (undone) return <Card icon="watch"><p className="empty-title">Undone</p><p className="meta">{m.title} won't be added.</p><Link className="btn btn-secondary" to="/watch">Open Movies</Link></Card>
  return (
    <Card icon="watch">
      <div className="share-movie">
        {m.poster && <img src={m.poster} alt="" className="share-poster" />}
        <div>
          <p className="empty-title">Adding {m.title}{m.year && ` (${m.year})`}</p>
          <p className="meta">It's on its way to Movies. Everyone hears when it's ready to watch.</p>
        </div>
      </div>
      {err && <p className="banner" role="alert">{err}</p>}
      <div className="share-choices">
        <Link className="btn btn-primary" to={`/watch?m=${m.imdb}`}><Icon name="watch" />Open it in Movies</Link>
        {left > 0 && <button type="button" className="btn btn-secondary" onClick={() => void undo()}>Undo ({left}s)</button>}
      </div>
    </Card>
  )
}

/** The song is on its way: Undo takes it back out (cancelled, or removed once it's in). */
function SongAdded({ added, onWatch }: { added: Added; onWatch?: () => void }) {
  const [undone, setUndone] = useState(false)
  const [err, setErr] = useState('')
  const name = songName(added.title, added.artist)
  async function undo() {
    if (!added.job) return
    try { await request('/api/slap/share/undo', { body: { job: added.job } }); setUndone(true) } catch (e) {
      setErr(e instanceof ApiError && e.detail ? e.detail : "Couldn't undo that.")
    }
  }
  if (undone) return <Card><p className="empty-title">Undone</p><p className="meta">{name} won't be added.</p><Link className="btn btn-secondary" to="/slap">Open Slap</Link></Card>
  return (
    <Card>
      {added.status === 'already_in_library' ? (
        <><p className="empty-title">{name} is already in Slap</p><p className="meta">Nothing to download.</p></>
      ) : (
        <><p className="empty-title">Adding {name}</p><p className="meta">It goes into your picks in Slap. You'll get a notification when it's in.</p></>
      )}
      {err && <p className="banner" role="alert">{err}</p>}
      <div className="share-choices">
        <Link className="btn btn-primary" to="/slap"><Icon name="slap" />Open Slap</Link>
        {added.job && added.status === 'downloading' && <button type="button" className="btn btn-secondary" onClick={() => void undo()}>Undo</button>}
        {onWatch && <button type="button" className="btn btn-ghost" onClick={onWatch}>Play it in the Watch Party instead</button>}
      </div>
    </Card>
  )
}

/** From the "it's in Slap" notification: where the song is, and Undo. */
function SharedSong({ job }: { job: string }) {
  const [row, setRow] = useState<ShareRow | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    request<ShareRow>(`/api/slap/share/${encodeURIComponent(job)}`).then(setRow).catch(() => setMissing(true))
  }, [job])
  if (missing) return <Card><p className="empty-title">That song isn't one you shared</p><Link className="btn btn-secondary" to="/slap">Open Slap</Link></Card>
  if (!row) return <Card><p className="empty-title" role="status"><span className="spinner" aria-hidden="true" /> Loading…</p></Card>
  const name = songName(row.title, row.artist)
  async function undo() {
    setBusy(true)
    try { await request('/api/slap/share/undo', { body: { job } }); setRow({ ...row!, status: 'undone' }) } finally { setBusy(false) }
  }
  const gone = row.status === 'undone' || row.status === 'undo'
  return (
    <Card>
      <p className="empty-title">{gone ? `${name} was taken out` : row.status === 'failed' ? `Couldn't add ${name}` : row.status === 'done' ? `${name} is in Slap` : `Adding ${name}`}</p>
      <p className="meta">{gone ? 'It won\'t be in your picks.' : row.status === 'failed' ? row.error : 'In your picks.'}</p>
      <div className="share-choices">
        <Link className="btn btn-primary" to="/slap"><Icon name="slap" />Open Slap</Link>
        {!gone && row.status !== 'failed' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void undo()}>Undo</button>}
      </div>
    </Card>
  )
}

function Card({ children, icon = 'slap' }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="page share-page">
      <section className="glass share-card" aria-live="polite">
        <Icon name={icon} className="nav-icon share-icon" />
        {children}
      </section>
    </div>
  )
}

/** The iPhone's share extension can't open the app, so "Play in the Watch Party" leaves the
 *  link on the server; the app opens it here the next time it's opened (or comes back). */
export function usePendingShare(enabled: boolean) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!enabled) return
    const check = () => {
      if (document.hidden) return
      request<{ url: string }>('/api/share/pending', { quiet401: true })
        .then((r) => {
          if (!r.url) return
          // A page of the app (a film in Movies), or a link to play for the party.
          const own = /^https:\/\/app\.crcmz\.me\/app(\/[^\s]*)?$/.exec(r.url)
          navigate(own ? own[1] || '/' : `/watch/party?${new URLSearchParams({ url: r.url })}`)
        })
        .catch(() => { /* signed out, offline: nothing waiting */ })
    }
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [enabled, navigate])
}
