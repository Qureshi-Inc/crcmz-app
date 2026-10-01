// The persistent mini-player (above the tab bar on a phone, above the account row
// in the sidebar) and the full player sheet it opens.
import { useEffect, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { useSwipeDown } from '../../lib/gestures'
import { artUrl, fmtTime, sendComment, sendThumb, setFavorite, type Library, type QueueItem } from '../../lib/slap'
import {
  clearUpcoming, closePlayer, current, cycleRepeat, jump, leaveTogether, move, next, prev, remove, seek, setExpanded,
  toggle, toggleShuffle, useClock, usePlayer, type PlayerState,
} from './player'

export function Art({ id, size = 96, className = 'slap-art' }: { id: string | null | undefined; size?: 96 | 300 | 600; className?: string }) {
  const [broken, setBroken] = useState(false)
  const src = artUrl(id, size)
  useEffect(() => setBroken(false), [src])
  return (
    <span className={className} aria-hidden="true">
      {src && !broken ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /> : <Icon name="slap" />}
    </span>
  )
}

function PlayButton({ s, big = false }: { s: PlayerState; big?: boolean }) {
  const label = s.blocked ? 'Tap to listen' : s.playing ? 'Pause' : 'Play'
  return (
    <button type="button" className={big ? 'play-btn play-btn-big' : 'icon-btn play-btn'} onClick={toggle} aria-label={label} data-loading={s.loading && s.playing}>
      <Icon name={s.playing && !s.blocked ? 'pause' : 'play'} />
    </button>
  )
}

export function MiniPlayer({ variant }: { variant: 'bar' | 'sidebar' }) {
  const s = usePlayer()
  const { position, duration } = useClock()
  const item = current(s)
  if (!item && s.mode !== 'together') return null
  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0
  const members = s.room?.members.length ?? 0
  return (
    <section className={`miniplayer miniplayer-${variant}`} aria-label="Now playing" data-together={s.mode === 'together'}>
      <div className="miniplayer-progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
      <div className="miniplayer-row">
        <button type="button" className="miniplayer-open" onClick={() => setExpanded(true)} aria-label={item ? `Open player: ${item.title} by ${item.artist}` : 'Open Listen Together'}>
          <Art id={item?.art} />
          <span className="miniplayer-text">
            <span className="miniplayer-title">{item?.title ?? 'Listen Together'}</span>
            <span className="miniplayer-sub">
              {s.mode === 'together' && <span className="together-tag">Together{members ? ` · ${members}` : ''}</span>}
              {item?.artist ?? (s.link === 'live' ? 'Nothing queued yet' : 'Connecting…')}
            </span>
          </span>
        </button>
        {s.blocked
          ? <button type="button" className="btn btn-primary miniplayer-unblock" onClick={toggle}>Tap to listen</button>
          : <PlayButton s={s} />}
        <button type="button" className="icon-btn" onClick={next} aria-label="Next"><Icon name="next" /></button>
        <button type="button" className="icon-btn miniplayer-close" onClick={closePlayer} aria-label={s.mode === 'together' ? 'Leave Listen Together and close the player' : 'Stop and close the player'}><Icon name="close" /></button>
      </div>
      <span className="sr-only" aria-live="polite">{s.blocked ? 'Playback is waiting for a tap' : ''}</span>
    </section>
  )
}

export function PlayerSheet() {
  const s = usePlayer()
  const desktop = useDesktop()
  const swipe = useSwipeDown(() => setExpanded(false))
  return (
    <Dialog.Root open={s.expanded} onOpenChange={setExpanded}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className={desktop ? 'dialog dialog-wide player-dialog' : 'sheet sheet-player'} aria-describedby={undefined}>
          {!desktop && <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>}
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">{s.mode === 'together' ? 'Listen Together' : 'Now playing'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close player"><Icon name="close" /></button>
            </Dialog.Close>
          </div>
          <PlayerBody s={s} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PlayerBody({ s }: { s: PlayerState }) {
  const item = current(s)
  const queue = s.mode === 'together' ? s.room?.queue ?? [] : s.queue
  const index = s.mode === 'together' ? s.room?.index ?? -1 : s.index
  return (
    <div className="player-body">
      {s.mode === 'together' && <TogetherBanner s={s} />}
      <div className="player-main">
        <Art id={item?.art} size={600} className="slap-art player-art" />
        <div className="player-meta">
          <p className="player-title">{item?.title ?? 'Nothing playing'}</p>
          <p className="player-artist">{item ? [item.artist, item.album].filter(Boolean).join(' · ') : s.mode === 'together' ? 'Add a track from Listen to start the room.' : 'Pick something from Listen.'}</p>
          {item?.added_by && <p className="meta">Queued by {item.added_by}</p>}
        </div>
        <Seek disabled={!item} />
        <div className="player-controls">
          {s.mode === 'solo'
            ? <button type="button" className="icon-btn" onClick={toggleShuffle} aria-pressed={s.shuffle} aria-label="Shuffle"><Icon name="shuffle" /></button>
            : <span className="player-ctl-gap" />}
          <button type="button" className="icon-btn" onClick={prev} aria-label="Previous"><Icon name="prev" /></button>
          <PlayButton s={s} big />
          <button type="button" className="icon-btn" onClick={next} aria-label="Next"><Icon name="next" /></button>
          {s.mode === 'solo'
            ? <button type="button" className="icon-btn repeat-btn" onClick={cycleRepeat} aria-pressed={s.repeat !== 'off'} aria-label={`Repeat: ${s.repeat}`} data-mode={s.repeat}><Icon name="repeat" />{s.repeat === 'one' && <span className="repeat-one" aria-hidden="true">1</span>}</button>
            : <span className="player-ctl-gap" />}
        </div>
        {s.blocked && <button type="button" className="btn btn-primary" onClick={toggle}>Tap to listen with everyone</button>}
        {item && <TrackActions item={item} />}
        <button type="button" className="btn btn-ghost player-close" onClick={closePlayer}>
          <Icon name="close" />{s.mode === 'together' ? 'Leave and close player' : 'Stop and close player'}
        </button>
      </div>
      <QueueList queue={queue} index={index} together={s.mode === 'together'} />
    </div>
  )
}

function Seek({ disabled }: { disabled: boolean }) {
  const { position, duration } = useClock()
  const [drag, setDrag] = useState<number | null>(null)
  const v = drag ?? position
  return (
    <div className="seek">
      <input
        type="range" className="seek-range" min={0} max={Math.max(1, Math.floor(duration))} step={1} value={Math.min(v, duration || 0)}
        disabled={disabled} aria-label="Seek" aria-valuetext={`${fmtTime(v)} of ${fmtTime(duration)}`}
        style={{ ['--pct' as string]: `${duration ? (v / duration) * 100 : 0}%` }}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag != null) { seek(drag); setDrag(null) } }}
        onKeyUp={() => { if (drag != null) { seek(drag); setDrag(null) } }}
        onBlur={() => { if (drag != null) { seek(drag); setDrag(null) } }}
      />
      <div className="seek-times num"><span>{fmtTime(v)}</span><span>{fmtTime(duration)}</span></div>
    </div>
  )
}

const REACTIONS = ['🔥', '😂', '💀', '😍', '🫡']
const thumbs = new Map<string, -1 | 0 | 1>()

function TrackActions({ item }: { item: QueueItem }) {
  const qc = useQueryClient()
  const lib = qc.getQueryData<Library>(['slap', 'library'])
  const fav = lib?.tracks.find((t) => t.id === item.id)?.fav ?? false
  const [thumb, setThumb] = useState<-1 | 0 | 1>(thumbs.get(item.id) ?? 0)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setThumb(thumbs.get(item.id) ?? 0), [item.id])

  const t = { id: item.id, title: item.title, artist: item.artist, album: item.album }
  const fail = (e: unknown) => toast(e instanceof ApiError && e.detail ? e.detail : "Slap didn't take that", 'error')

  function favourite() {
    const on = !fav
    qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: on } : x)) })
    setFavorite(item.id, on).catch((e) => {
      qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: !on } : x)) })
      fail(e)
    })
  }
  function rate(v: -1 | 1) {
    const nv = thumb === v ? 0 : v
    setThumb(nv)
    thumbs.set(item.id, nv)
    sendThumb(t, nv).catch((e) => { setThumb(thumb); thumbs.set(item.id, thumb); fail(e) })
  }
  async function say(body: string, reaction: boolean) {
    if (!body.trim() || busy) return
    setBusy(true)
    try {
      await sendComment(t, body.trim(), reaction)
      if (!reaction) setText('')
      toast(reaction ? `Reacted ${body}` : 'Comment posted', 'success')
      qc.invalidateQueries({ queryKey: ['slap', 'social'] })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void say(text, false) }

  return (
    <div className="track-actions">
      <div className="track-actions-row">
        <button type="button" className="icon-btn" onClick={favourite} aria-pressed={fav} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'} data-on={fav}>
          <Icon name={fav ? 'heartFill' : 'heart'} />
        </button>
        <button type="button" className="icon-btn" onClick={() => rate(1)} aria-pressed={thumb === 1} aria-label="Thumbs up"><Icon name="thumbUp" /></button>
        <button type="button" className="icon-btn" onClick={() => rate(-1)} aria-pressed={thumb === -1} aria-label="Thumbs down"><Icon name="thumbDown" /></button>
        <span className="track-actions-sep" />
        {REACTIONS.map((r) => (
          <button key={r} type="button" className="reaction-btn" onClick={() => void say(r, true)} disabled={busy} aria-label={`React ${r}`}>{r}</button>
        ))}
      </div>
      <form className="comment-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="slap-comment">Comment on this track</label>
        <input id="slap-comment" className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="Say something about this one… @name to tag" />
        <button type="submit" className="btn btn-secondary" disabled={busy || !text.trim()}>Post</button>
      </form>
    </div>
  )
}

export function TogetherBanner({ s }: { s: PlayerState }) {
  const r = s.room
  const names = r?.members.map((m) => m.name) ?? []
  return (
    <div className="together-banner" role="status">
      <div className="together-banner-text">
        <b>{s.link === 'live' ? `Listening with ${names.length > 1 ? names.join(', ') : 'just you so far'}` : s.link === 'connecting' ? 'Joining…' : 'Reconnecting…'}</b>
        {r?.last && <span className="meta">{r.last}</span>}
      </div>
      <button type="button" className="btn btn-secondary" onClick={leaveTogether}>Leave</button>
    </div>
  )
}

export function QueueList({ queue, index, together, level = 3 }: { queue: QueueItem[]; index: number; together: boolean; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3'
  const upcoming = queue.length - index - 1
  if (!queue.length) return null
  return (
    <section className="queue" aria-labelledby="queue-h">
      <div className="queue-head">
        <H className="section-h2" id="queue-h">{together ? 'Shared queue' : 'Queue'}</H>
        <span className="meta">{upcoming > 0 ? `${upcoming} up next` : 'Nothing after this'}</span>
        {upcoming > 0 && <button type="button" className="btn btn-ghost" onClick={clearUpcoming}>Clear</button>}
      </div>
      <ol className="rows queue-rows">
        {queue.map((q, i) => (
          <li key={q.qid} className="queue-row" data-current={i === index} data-past={i < index}>
            <button type="button" className="queue-jump" onClick={() => jump(i)} aria-current={i === index ? 'true' : undefined} aria-label={`Play ${q.title} by ${q.artist}`}>
              <Art id={q.art} />
              <span className="queue-text">
                <span className="queue-title">{q.title}</span>
                <span className="queue-sub">{q.artist}{together && q.added_by ? ` · ${q.added_by}` : ''}</span>
              </span>
            </button>
            <span className="queue-tools">
              <button type="button" className="icon-btn" onClick={() => move(q.qid, i - 1)} disabled={i === 0} aria-label={`Move ${q.title} up`}><Icon name="up" /></button>
              <button type="button" className="icon-btn" onClick={() => move(q.qid, i + 1)} disabled={i === queue.length - 1} aria-label={`Move ${q.title} down`}><Icon name="down" /></button>
              <button type="button" className="icon-btn" onClick={() => remove(q.qid)} aria-label={`Remove ${q.title}`}><Icon name="close" /></button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
