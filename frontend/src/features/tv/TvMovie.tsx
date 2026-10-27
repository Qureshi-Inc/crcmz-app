// A movie's page on the TV: the backdrop full screen, the title (its logo when there is
// one), the facts, and what you can do: Play for the party when it's in our library, or
// add it ("download": 4K or 1080p when both exist) and watch it come in.
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { addMovie, getDetails, getOptions, inFlight, measured, stateText, streamUrl, type Details } from '../../lib/movies'
import { Backdrop } from '../watch/MoviesHome'
import { focusFirst } from '../../lib/tv'
import { useTvPlay } from './TvApp'

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`)

export function TvMovie() {
  const { imdb = '' } = useParams()
  const q = useQuery({
    queryKey: ['movies', 'meta', imdb],
    queryFn: ({ signal }) => getDetails(imdb, signal),
    staleTime: 30_000,
    refetchInterval: (s) => (s.state.data && inFlight(s.state.data.state) ? 5000 : false),
  })
  const d = q.data
  return (
    <div className="tv-movie">
      {d && <Backdrop src={d.background || d.poster} className="tv-backdrop" />}
      {d ? <Body d={d} />
        : q.isError ? (
          <div className="tv-movie-body">
            <h1 className="tv-spot-h">That movie didn't load</h1>
            <button type="button" className="tv-btn tv-btn-primary" data-tv-autofocus onClick={() => void q.refetch()}><Icon name="refresh" />Try again</button>
          </div>
        ) : <div className="tv-movie-body"><span className="tv-skel tv-skel-title" /><span className="tv-skel tv-skel-line" /></div>}
    </div>
  )
}

function Body({ d }: { d: Details }) {
  const qc = useQueryClient()
  const party = useTvPlay()
  const [busy, setBusy] = useState(false)
  const ready = d.state === 'ready' && !!d.id
  const coming = inFlight(d.state)
  const opts = useQuery({
    queryKey: ['movies', 'options', d.imdb], queryFn: ({ signal }) => getOptions(d.imdb, signal),
    enabled: d.can_add && (d.state === 'new' || d.state === 'failed'), staleTime: 10 * 60_000, retry: false,
  }).data
  const both = !!(opts?.['4k'] && opts?.['1080p'])
  // Focus the main action once it's there (and again when Add turns into Play).
  useEffect(() => { const t = window.setTimeout(() => focusFirst(), 50); return () => window.clearTimeout(t) }, [ready, coming])

  async function add(quality?: '4k' | '1080p') {
    setBusy(true)
    try {
      const a = await addMovie(d.imdb, quality)
      qc.setQueryData<Details>(['movies', 'meta', d.imdb], (x) => x && { ...x, state: a.status, progress: a.progress, id: a.id, adding: a.status === 'ready' ? null : a })
      void qc.invalidateQueries({ queryKey: ['movies', 'library'] })
      void qc.invalidateQueries({ queryKey: ['movies', 'home'] })
      toast(a.status === 'ready' ? `${d.title} is already in the library` : `Adding ${d.title}. It shows up in Library when it's ready.`, 'success')
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "That movie didn't add", 'error')
    } finally { setBusy(false) }
  }

  const meta = [d.year, d.runtime ? hm(d.runtime) : '', d.rating && `★ ${d.rating}`, ...(d.genres ?? []).slice(0, 3)].filter(Boolean).join('  ·  ')
  const quality = d.library_quality || d.quality || d.adding?.quality || ''
  const pct = d.adding?.progress ?? d.progress
  return (
    <div className="tv-movie-body">
      {d.logo ? <img className="tv-logo" src={d.logo} alt={d.title} referrerPolicy="no-referrer" /> : <h1 className="tv-spot-h">{d.title}</h1>}
      {meta && <p className="tv-spot-meta">{meta}</p>}
      {(ready || quality) && <p className="tv-badge">{[ready ? 'In our library' : '', quality, d.by ? `added by ${d.by}` : ''].filter(Boolean).join(' · ')}</p>}
      {d.overview && <p className="tv-spot-text tv-movie-text">{d.overview}</p>}

      <div className="tv-spot-acts">
        {ready ? (
          <button type="button" className="tv-btn tv-btn-primary" data-tv-autofocus onClick={() => party.play(streamUrl(d.id!), d.title)}>
            <Icon name="play" />Play
          </button>
        ) : coming ? (
          <div className="tv-progress" role="status">
            <span className="tv-badge">{stateText(d.state, pct)}</span>
            <span className="tv-bar tv-bar-wide" data-indeterminate={!measured(d.state) || undefined}>
              <i style={measured(d.state) ? { width: `${Math.max(3, pct)}%` } : undefined} />
            </span>
          </div>
        ) : d.can_add && both ? (
          <>
            <button type="button" className="tv-btn tv-btn-primary" data-tv-autofocus disabled={busy} onClick={() => void add('4k')}>
              <Icon name="download" />{busy ? 'Adding…' : `Add ${opts!['4k']!.label}`}<span className="tv-btn-sub">{opts!['4k']!.size_gb} GB</span>
            </button>
            <button type="button" className="tv-btn" disabled={busy} onClick={() => void add('1080p')}>
              <Icon name="download" />Add 1080p<span className="tv-btn-sub">{opts!['1080p']!.size_gb} GB</span>
            </button>
          </>
        ) : d.can_add ? (
          <button type="button" className="tv-btn tv-btn-primary" data-tv-autofocus disabled={busy} onClick={() => void add()}>
            <Icon name={d.state === 'failed' ? 'refresh' : 'download'} />{busy ? 'Adding…' : d.state === 'failed' ? 'Try again' : 'Add to library'}
          </button>
        ) : (
          <p className="tv-meta">Adding movies isn't switched on for your account.</p>
        )}
        {d.trailers[0] && (
          <button type="button" className="tv-btn" data-tv-autofocus={coming || undefined}
            onClick={() => party.play(`https://www.youtube.com/watch?v=${d.trailers[0]}`, `${d.title} · trailer`)}>
            <Icon name="play" />Trailer
          </button>
        )}
      </div>
      {d.state === 'failed' && d.error && <p className="tv-err" role="alert">{d.error}</p>}
      {coming && <p className="tv-meta">It's on its way to our server. You can go back; it shows up in Library when it's ready.</p>}

      <dl className="tv-facts">
        {d.director.length > 0 && <div><dt>Director</dt><dd>{d.director.join(', ')}</dd></div>}
        {d.cast.length > 0 && <div><dt>Starring</dt><dd>{d.cast.slice(0, 5).join(', ')}</dd></div>}
      </dl>
      {party.confirm}
    </div>
  )
}
