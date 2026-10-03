// Watch · a movie's sheet: backdrop, the facts, the trailer (played on the party's shared
// screen, for everyone), and the one thing to do
// next. In the library: Watch together (the party switches to it, after asking if it's
// on something else). Not yet: Add to library, then the sheet follows it in. Whoever
// added it, or an admin, can remove it again.
import { useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ErrorStrip } from '../../components/states'
import { toast } from '../../components/toast'
import { useSwipeDown } from '../../lib/gestures'
import { ApiError } from '../../lib/http'
import {
  addMovie, getDetails, getNow, inFlight, measured, removeMovie, stateText, streamUrl, type Details,
} from '../../lib/movies'
import { ConfirmDialog } from '../clips/ClipSheet'
import { Backdrop } from './MoviesHome'
import { watchTogether } from './session'

export function useNow() {
  return useQuery({ queryKey: ['movies', 'now'], queryFn: ({ signal }) => getNow(signal), refetchInterval: 15_000, staleTime: 10_000 })
}

export type PartyPlay = { play: (url: string, title: string, resumeAt?: number) => void; confirm: ReactNode }

/** Play something for the party and go there. If the party is on something else, ask first. */
export function usePartyPlay(): PartyPlay {
  const navigate = useNavigate()
  const now = useNow().data
  const [ask, setAsk] = useState<{ url: string; title: string; at: number } | null>(null)
  function go(url: string, title: string, at = 0) {
    watchTogether(url, title, at)
    navigate('/watch/party')
  }
  function play(url: string, title: string, at = 0) {
    if (now && now.watching > 0 && now.video && now.video !== url) setAsk({ url, title, at })
    else go(url, title, at)
  }
  const confirm = (
    <ConfirmDialog
      open={!!ask} onOpenChange={(v) => { if (!v) setAsk(null) }} title="Switch the party?" action="Switch"
      body={<p>{now?.watching ?? 0} {now?.watching === 1 ? 'person is' : 'people are'} watching {now?.title ? `‘${now.title}’` : 'something else'}. Switch everyone to ‘{ask?.title}’?</p>}
      onConfirm={() => { const a = ask; setAsk(null); if (a) go(a.url, a.title, a.at) }}
    />
  )
  return { play, confirm }
}

export function MovieSheet({ imdb, onClose, onGenre, party }: {
  imdb: string | null; onClose: () => void; onGenre: (g: string) => void; party: PartyPlay
}) {
  const open = !!imdb
  const q = useQuery({
    queryKey: ['movies', 'meta', imdb],
    queryFn: ({ signal }) => getDetails(imdb!, signal),
    enabled: open,
    staleTime: 30_000,
    refetchInterval: (s) => (s.state.data && inFlight(s.state.data.state) ? 5000 : false),
  })
  const swipe = useSwipeDown(onClose)
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="sheet mv-sheet" aria-describedby={undefined}>
          <div className="sheet-knob-row mv-sheet-knob" {...swipe}><span className="sheet-knob" /></div>
          <Dialog.Close asChild>
            <button type="button" className="icon-btn mv-sheet-close" aria-label="Close"><Icon name="close" /></button>
          </Dialog.Close>
          {q.data ? <Body d={q.data} onGenre={onGenre} party={party} onGone={onClose} />
            : q.isError ? (
              <div className="mv-sheet-pad">
                <Dialog.Title className="sheet-title">Movie</Dialog.Title>
                <ErrorStrip text="That movie didn't load" onRetry={() => q.refetch()} />
              </div>
            ) : (
              <div aria-busy="true">
                <Dialog.Title className="sr-only">Loading the movie</Dialog.Title>
                <div className="mv-sheet-hero skeleton" />
                <div className="mv-sheet-pad"><span className="skeleton" style={{ width: '60%', height: 28 }} /><span className="skeleton" style={{ width: '40%', height: 16, marginTop: 12 }} /></div>
              </div>
            )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`)

function Body({ d, onGenre, party, onGone }: { d: Details; onGenre: (g: string) => void; party: PartyPlay; onGone: () => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['movies', 'meta', d.imdb] })
    void qc.invalidateQueries({ queryKey: ['movies', 'library'] })
    void qc.invalidateQueries({ queryKey: ['movies', 'home'] })
    void qc.invalidateQueries({ queryKey: ['movies', 'catalog'] })
    void qc.invalidateQueries({ queryKey: ['movies', 'search'] })
  }
  async function add() {
    setBusy(true)
    try {
      const a = await addMovie(d.imdb)
      qc.setQueryData<Details>(['movies', 'meta', d.imdb], (x) => x && { ...x, state: a.status, progress: a.progress, id: a.id, adding: a.status === 'ready' ? null : a })
      refresh()
      toast(a.status === 'ready' ? `${d.title} is already in the library` : `Adding ${d.title}. Everyone hears when it's ready.`, 'success')
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "That movie didn't add", 'error')
    } finally { setBusy(false) }
  }
  async function remove() {
    if (!d.id) return
    setBusy(true)
    try {
      await removeMovie(d.id)
      refresh()
      toast(`${d.title} is out of the library`, 'success')
      onGone()
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "That movie didn't come out", 'error')
    } finally { setBusy(false) }
  }

  const ready = d.state === 'ready' && !!d.id
  const coming = inFlight(d.state)
  const meta = [d.year, d.runtime ? hm(d.runtime) : '', d.rating && `★ ${d.rating}`, d.country].filter(Boolean).join(' · ')
  const quality = d.library_quality || d.quality || d.adding?.quality || ''
  return (
    <div className="mv-sheet-scroll">
      <div className="mv-sheet-hero">
        <Backdrop src={d.background || d.poster} className="mv-sheet-bg" />
      </div>
      <div className="mv-sheet-pad">
        <div className="mv-sheet-top">
          {d.poster && <img className="mv-sheet-poster" src={d.poster} alt="" decoding="async" referrerPolicy="no-referrer" />}
          <div className="mv-sheet-titles">
            <Dialog.Title className="mv-sheet-h">{d.title}</Dialog.Title>
            {meta && <p className="mv-sheet-meta num">{meta}</p>}
            {(ready || quality) && <p className="meta">{[ready ? 'In our library' : '', quality, d.by ? `added by ${d.by}` : ''].filter(Boolean).join(' · ')}</p>}
          </div>
        </div>
        {d.genres && d.genres.length > 0 && (
          <div className="mv-sheet-genres">
            {d.genres.map((g) => <button key={g} type="button" className="chip" onClick={() => onGenre(g)} aria-label={`More ${g}`}>{g}</button>)}
          </div>
        )}

        <div className="mv-sheet-acts">
          {ready ? (
            <button type="button" className="btn btn-primary mv-cta" onClick={() => party.play(streamUrl(d.id!), d.title)}>
              <Icon name="play" />Watch together
            </button>
          ) : coming ? (
            <div className="mv-sheet-progress" role="status">
              <span className="find-chip" data-tone="live">{stateText(d.state, d.adding?.progress ?? d.progress)}</span>
              <span className="mv-bar" data-indeterminate={!measured(d.state) || undefined}
                role="progressbar" aria-label={`${d.title} progress`} aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={measured(d.state) ? Math.floor(d.adding?.progress ?? d.progress) : undefined}>
                <i style={measured(d.state) ? { width: `${Math.max(3, d.adding?.progress ?? d.progress)}%` } : undefined} />
              </span>
              <span className="meta">We'll tell everyone when it's ready.</span>
            </div>
          ) : d.can_add ? (
            <button type="button" className="btn btn-primary mv-cta" onClick={() => void add()} disabled={busy}>
              <Icon name={d.state === 'failed' ? 'refresh' : 'plus'} />{busy ? 'Adding…' : d.state === 'failed' ? 'Try again' : 'Add to library'}
            </button>
          ) : (
            <p className="meta">Adding movies isn't switched on yet.</p>
          )}
          {d.trailers[0] && (
            // On the party's shared screen, so everyone in the party watches it together.
            <button type="button" className="btn btn-secondary" title="Play the trailer for everyone in the Watch Party"
              onClick={() => party.play(`https://www.youtube.com/watch?v=${d.trailers[0]}`, `${d.title} · trailer`)}>
              <Icon name="play" />Trailer
            </button>
          )}
          {d.can_remove && (
            <button type="button" className="icon-btn" onClick={() => setConfirmRemove(true)} disabled={busy} aria-label={`Remove ${d.title} from the library`}>
              <Icon name="trash" />
            </button>
          )}
        </div>
        {d.state === 'failed' && d.error && <p className="field-err" role="alert">{d.error}</p>}
        {!ready && !coming && d.can_add && d.state !== 'failed' && (
          <p className="meta">We find the best copy (4K when there is one, else 1080p) and keep it on our server.</p>
        )}

        {d.overview && <p className="mv-sheet-overview">{d.overview}</p>}
        <dl className="mv-facts">
          {d.director.length > 0 && <><dt>Director</dt><dd>{d.director.join(', ')}</dd></>}
          {d.cast.length > 0 && <><dt>Starring</dt><dd>{d.cast.join(', ')}</dd></>}
          {d.writer.length > 0 && <><dt>Writers</dt><dd>{d.writer.slice(0, 3).join(', ')}</dd></>}
          {d.awards && <><dt>Awards</dt><dd>{d.awards}</dd></>}
        </dl>
      </div>
      <ConfirmDialog
        open={confirmRemove} onOpenChange={setConfirmRemove} title="Remove this movie?" action="Remove"
        body={<p>Take ‘{d.title}’ out of the library for everyone? You can add it again later.</p>}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
