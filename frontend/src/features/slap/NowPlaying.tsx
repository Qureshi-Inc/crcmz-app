// The persistent mini-player (above the tab bar on a phone, above the account row
// in the sidebar) and the full player sheet it opens.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { useSwipeDown } from '../../lib/gestures'
import { CommentBox, CommentThread } from './Comments'
import {
  artUrl, findSources, fmtTime, names, replaceTrack, rerollStatus, sendComment, sourceLink, slapName, slapNames, sendThumb, setFavorite, useSlapMe, useTrackComments, useTrackSocial,
  type Library, type QueueItem, type Source, type TrackSocial,
} from '../../lib/slap'
import {
  clearUpcoming, closePlayer, current, cycleRepeat, jump, leaveTogether, move, next, prev, reloadTrack, remove, seek, setExpanded,
  toggle, toggleShuffle, useClock, usePlayer, type PlayerState,
} from './player'

export function Art({ id, size = 96, className = 'slap-art' }: { id: string | null | undefined; size?: 96 | 300 | 600; className?: string }) {
  // 0 = as cached, 1 = refetched once past the cache, 2 = give up and show the icon.
  const [tries, setTries] = useState(0)
  const base = artUrl(id, size)
  useEffect(() => setTries(0), [base])
  const src = base && tries === 1 ? `${base}&r=${Date.now()}` : base
  return (
    <span className={className} aria-hidden="true">
      {src && tries < 2 ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setTries((n) => n + 1)} /> : <Icon name="slap" />}
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
              <MiniAddedBy id={item?.id} />
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

/** Compact heart toggle used in the player header on both layouts. */
function HeartButton({ item }: { item: QueueItem }) {
  const qc = useQueryClient()
  const lib = qc.getQueryData<Library>(['slap', 'library'])
  const fav = lib?.tracks.find((t) => t.id === item.id)?.fav ?? false
  function favourite() {
    const on = !fav
    qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: on } : x)) })
    setFavorite(item.id, on).catch(() => {
      qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: !on } : x)) })
    })
  }
  return (
    <button type="button" className="icon-btn" onClick={favourite} aria-pressed={fav} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'} data-on={fav}>
      <Icon name={fav ? 'heartFill' : 'heart'} />
    </button>
  )
}

export function PlayerSheet() {
  const s = usePlayer()
  const desktop = useDesktop()
  const swipe = useSwipeDown(() => setExpanded(false))
  const item = current(s)
  const [reroll, setReroll] = useState<QueueItem | null>(null)
  return (
    <Dialog.Root open={s.expanded} onOpenChange={setExpanded}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className={desktop ? 'dialog player-dialog' : 'sheet sheet-player'} aria-describedby={undefined}>
          {/* blurred art backdrop (mobile full-screen sheet only) */}
          {!desktop && item?.art && (
            <div
              className="player-backdrop"
              style={{ backgroundImage: `url(${artUrl(item.art, 300)})` }}
              aria-hidden="true"
            />
          )}
          {/* inner scroll wrapper on mobile; desktop dialog scrolls natively */}
          <div className={desktop ? undefined : 'player-scroll'}>
            {!desktop && <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>}
            <div className="sheet-title-row">
              <Dialog.Title className={desktop ? 'sheet-title' : 'sr-only'}>
                {s.mode === 'together' ? 'Listen Together' : 'Now playing'}
              </Dialog.Title>
              <div className="player-head-tools">
                {item && <HeartButton item={item} />}
                {item && (
                  <Menu.Root>
                    <Menu.Trigger asChild>
                      <button type="button" className="icon-btn" aria-label={`More for ${item.title}`}><Icon name="more" /></button>
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Content className="menu-content" sideOffset={4} align="end">
                        <Menu.Item className="menu-item" onSelect={() => setReroll(item)}>Wrong song? Find the right one</Menu.Item>
                      </Menu.Content>
                    </Menu.Portal>
                  </Menu.Root>
                )}
                <Dialog.Close asChild>
                  <button type="button" className="icon-btn" aria-label="Close player"><Icon name="close" /></button>
                </Dialog.Close>
              </div>
            </div>
            <PlayerBody s={s} />
          </div>
          {reroll && <RerollDialog item={reroll} onClose={() => setReroll(null)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Reroll: the import grabbed the wrong song; search again and swap in the right one ──
const errText = (e: unknown, fallback: string) => (e instanceof ApiError && e.detail ? e.detail : fallback)

/** Follow a replace in the background, so closing the dialog doesn't lose it. */
function watchReroll(job: string, item: QueueItem, done: () => void) {
  let tries = 0
  const tick = async () => {
    tries += 1
    try {
      const r = await rerollStatus(job)
      if (r.state === 'done') {
        reloadTrack(item.id, r.duration)
        done()
        toast(`${item.title} is fixed for everyone`, 'success')
        return
      }
      if (r.state === 'failed') { toast(r.error || "That download didn't work", 'error'); return }
    } catch (e) {
      // The job can outlive a blip, but not a missing job.
      if (e instanceof ApiError && e.status === 404) { toast('Lost track of that download; check back in a minute', 'error'); return }
    }
    if (tries < 160) window.setTimeout(() => void tick(), 3000)
  }
  window.setTimeout(() => void tick(), 3000)
}

function lengthHint(c: Source, want: number) {
  if (!c.duration_seconds || !want) return ''
  const d = Math.round(c.duration_seconds - want)
  if (Math.abs(d) <= 3) return 'Same length'
  return `${fmtTime(Math.abs(d))} ${d > 0 ? 'longer' : 'shorter'}`
}

function RerollDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [asked, setAsked] = useState('')
  const [found, setFound] = useState<Source[] | null>(null)
  const [want, setWant] = useState(item.duration || 0)
  const [error, setError] = useState('')
  const [pick, setPick] = useState<Source | null>(null)
  const [busy, setBusy] = useState(false)
  const ctrl = useRef<AbortController | null>(null)

  async function search(text: string) {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setFound(null); setError(''); setAsked(text)
    try {
      const r = await findSources(item.id, text, c.signal)
      if (c.signal.aborted) return
      setFound(r.candidates)
      if (r.track.duration) setWant(r.track.duration)
    } catch (e) {
      if (!c.signal.aborted) { setError(errText(e, "YouTube didn't answer. Try again.")); setFound([]) }
    }
  }
  useEffect(() => { void search(''); return () => ctrl.current?.abort() }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = q.trim()
    const link = sourceLink(text)
    if (link) { setPick({ url: link, title: 'The link you pasted', channel: new URL(link).hostname.replace(/^www\./, ''), duration_seconds: null, view_count: null, score: 0 }); return }
    void search(text)
  }

  async function replace() {
    if (!pick || busy) return
    setBusy(true)
    try {
      const { job } = await replaceTrack(item.id, pick.url)
      watchReroll(job, item, () => void qc.invalidateQueries({ queryKey: ['slap', 'library'] }))
      toast(`Downloading the new ${item.title}. It swaps in when it's ready.`, 'info')
      onClose()
    } catch (e) {
      setError(errText(e, "Slap didn't take that"))
      setPick(null)
    } finally { setBusy(false) }
  }

  return (
    <Dialog.Root open onOpenChange={(v) => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim scrim-top" />
        <Dialog.Content className="dialog dialog-wide reroll-dialog" aria-describedby="reroll-desc">
          <div className="sheet-title-row">
            <Dialog.Title className="dialog-title" style={{ margin: 0 }}>{pick ? 'Replace this song?' : 'Find the right song'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close"><Icon name="close" /></button>
            </Dialog.Close>
          </div>
          <p id="reroll-desc" className="dim reroll-now">
            <b>{item.title}</b> · {item.artist}{want ? ` · ${fmtTime(want)}` : ''}
          </p>
          {pick ? (
            <>
              <p>
                Slap will download <b>{pick.title}</b>{pick.channel ? ` (${pick.channel})` : ''} and put it in place of the current file.
                It keeps the title, album and cover, and it changes the song for everyone. The old file is kept, so it can be put back.
              </p>
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setPick(null)} disabled={busy}>Back</button>
                <button type="button" className="btn btn-primary" onClick={() => void replace()} disabled={busy}>{busy ? 'Starting…' : 'Replace for everyone'}</button>
              </div>
            </>
          ) : (
            <>
              <form className="reroll-search" onSubmit={submit} role="search">
                <label className="sr-only" htmlFor="reroll-q">Search YouTube, or paste a YouTube or SoundCloud link</label>
                <input
                  id="reroll-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} maxLength={300}
                  placeholder="Search, or paste a YouTube link"
                />
                <button type="submit" className="btn btn-secondary" disabled={!q.trim() || found === null}>{sourceLink(q) ? 'Use link' : 'Search'}</button>
              </form>
              {error && <p className="error-strip" role="alert">{error}</p>}
              {found === null ? (
                <p className="reroll-wait" role="status"><span className="spinner" aria-hidden="true" />Searching YouTube{asked ? ` for “${asked}”` : ''}… this can take half a minute.</p>
              ) : found.length === 0 ? (
                !error && <p className="dim" role="status">Nothing came back. Try other words, or paste a link.</p>
              ) : (
                <ul className="rows reroll-list" aria-label="Candidates">
                  {found.map((c, i) => {
                    const hint = lengthHint(c, want)
                    return (
                      <li key={c.url} className="reroll-row">
                        <span className="reroll-text">
                          <span className="reroll-title">{c.title}</span>
                          <span className="meta">
                            {[c.channel, c.duration_seconds ? fmtTime(c.duration_seconds) : ''].filter(Boolean).join(' · ')}
                            {!asked && i === 0 && c.score > 0 && <span className="reroll-tag">Best match</span>}
                            {hint && <span className="reroll-hint" data-same={hint === 'Same length'}>{hint}</span>}
                          </span>
                        </span>
                        <a className="btn btn-ghost" href={c.url} target="_blank" rel="noreferrer" aria-label={`Preview ${c.title} on YouTube`}>Preview</a>
                        <button type="button" className="btn btn-secondary" onClick={() => setPick(c)} aria-label={`Use ${c.title}`}>Use this</button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
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
      {/* Art lives outside player-main so desktop grid can put it in its own column */}
      <Art id={item?.art} size={600} className="slap-art player-art" />
      <div className="player-main">
        <div className="player-meta">
          <p className="player-title">{item?.title ?? 'Nothing playing'}</p>
          <p className="player-artist">{item ? [item.artist, item.album].filter(Boolean).join(' · ') : s.mode === 'together' ? 'Add a track from Listen to start the room.' : 'Pick something from Listen.'}</p>
          <AddedBy item={item} together={s.mode === 'together'} />
        </div>
        {/* Transport controls come before the seek bar (Apple Music / Spotify order) */}
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
        <Seek disabled={!item} />
        {s.blocked && <button type="button" className="btn btn-primary" onClick={toggle}>Tap to listen with everyone</button>}
        {item && <TrackActions item={item} />}
        <button type="button" className="btn btn-ghost player-close" onClick={closePlayer}>
          <Icon name="close" />{s.mode === 'together' ? 'Leave and close player' : 'Stop and close player'}
        </button>
        {/* Queue is inside player-main so on desktop it scrolls in the right column */}
        <QueueList queue={queue} index={index} together={s.mode === 'together'} />
      </div>
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

/** "Added by Noor" (from the picks playlists) and, in the room, who queued it. */
function AddedBy({ item, together }: { item: QueueItem | null | undefined; together: boolean }) {
  const q = useTrackSocial(item?.id)
  const by = slapNames(q.data?.picked_by ?? [])
  const queued = together && item?.added_by
  if (!by.length && !queued) return null
  return (
    <p className="player-by meta">
      {by.length > 0 && <span>Added by <b>{names(by)}</b></span>}
      {by.length > 0 && queued && <span aria-hidden="true"> · </span>}
      {queued && <span>Queued by <b>{item.added_by}</b></span>}
    </p>
  )
}

function MiniAddedBy({ id }: { id: string | undefined }) {
  const by = slapNames(useTrackSocial(id).data?.picked_by ?? [])
  return by.length ? <span className="miniplayer-by">· {names(by, 1)}</span> : null
}

function TrackActions({ item }: { item: QueueItem }) {
  const qc = useQueryClient()
  const lib = qc.getQueryData<Library>(['slap', 'library'])
  const fav = lib?.tracks.find((t) => t.id === item.id)?.fav ?? false
  const social = useTrackSocial(item.id)
  const raw = social.data?.thumbs ?? { up: [], down: [], mine: 0 as const }
  const thumbs = { ...raw, up: slapNames(raw.up), down: slapNames(raw.down) }
  const me = useSlapMe().data?.slap_user?.toLowerCase()
  const comments = useTrackComments(item.id).data?.comments ?? []
  const [busy, setBusy] = useState<string | null>(null)

  const t = { id: item.id, title: item.title, artist: item.artist, album: item.album }
  const fail = (e: unknown) => toast(e instanceof ApiError && e.detail ? e.detail : "Slap didn't take that", 'error')
  const key = ['slap', 'track', item.id]

  function favourite() {
    const on = !fav
    qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: on } : x)) })
    setFavorite(item.id, on).catch((e) => {
      qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: !on } : x)) })
      fail(e)
    })
  }
  function rate(v: -1 | 1) {
    const nv = thumbs.mine === v ? 0 : v
    const before = qc.getQueryData<TrackSocial>(key)
    qc.setQueryData<TrackSocial>(key, (d) => d && { ...d, thumbs: { ...d.thumbs, mine: nv } })
    sendThumb(t, nv)
      .then((th) => qc.setQueryData<TrackSocial>(key, (d) => ({ picked_by: d?.picked_by ?? [], thumbs: th })))
      .catch((e) => { qc.setQueryData(key, before); fail(e) })
  }
  // Each emoji's reactors, from the thread; yours shows as pressed.
  const reacted = new Map<string, { who: string[]; mine: boolean }>()
  for (const c of comments) {
    if (!c.is_reaction) continue
    const r = reacted.get(c.text) ?? { who: [], mine: false }
    const name = c.username.toLowerCase()
    if (!r.who.includes(slapName(c.username))) r.who.push(slapName(c.username))
    if (me && name === me) r.mine = true
    reacted.set(c.text, r)
  }
  async function react(r: string) {
    if (busy) return
    if (reacted.get(r)?.mine) { toast(`You already reacted ${r}`, 'info'); return }
    setBusy(r)
    try {
      await sendComment(t, r, true)
      void qc.invalidateQueries({ queryKey: ['slap', 'social'] })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }
  const rated = [thumbs.up.length ? `👍 ${names(thumbs.up, 3)}` : '', thumbs.down.length ? `👎 ${names(thumbs.down, 3)}` : ''].filter(Boolean)

  return (
    <div className="track-actions">
      <div className="track-actions-row">
        <button type="button" className="icon-btn" onClick={favourite} aria-pressed={fav} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'} data-on={fav}>
          <Icon name={fav ? 'heartFill' : 'heart'} />
        </button>
        <button
          type="button" className="icon-btn thumb-btn" onClick={() => rate(1)} aria-pressed={thumbs.mine === 1}
          aria-label={`Thumbs up${thumbs.up.length ? `, ${thumbs.up.length} so far` : ''}`} title={thumbs.up.join(', ') || undefined}
        >
          <Icon name="thumbUp" />{thumbs.up.length > 0 && <span className="thumb-n num" aria-hidden="true">{thumbs.up.length}</span>}
        </button>
        <button
          type="button" className="icon-btn thumb-btn" onClick={() => rate(-1)} aria-pressed={thumbs.mine === -1}
          aria-label={`Thumbs down${thumbs.down.length ? `, ${thumbs.down.length} so far` : ''}`} title={thumbs.down.join(', ') || undefined}
        >
          <Icon name="thumbDown" />{thumbs.down.length > 0 && <span className="thumb-n num" aria-hidden="true">{thumbs.down.length}</span>}
        </button>
        <span className="track-actions-sep" />
        {REACTIONS.map((r) => {
          const x = reacted.get(r)
          return (
            <button
              key={r} type="button" className="reaction-btn" onClick={() => void react(r)} disabled={busy === r}
              aria-pressed={!!x?.mine} title={x ? x.who.join(', ') : undefined}
              aria-label={`React ${r}${x ? `, ${x.who.length} so far${x.mine ? ', including you' : ''}` : ''}`}
            >
              <span aria-hidden="true">{r}</span>{x && <span className="reaction-n num" aria-hidden="true">{x.who.length}</span>}
            </button>
          )
        })}
      </div>
      {rated.length > 0 && <p className="track-rated meta">{rated.join(' · ')}</p>}
      <CommentBox item={t} />
      <CommentThread trackId={item.id} tally={false} />
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
