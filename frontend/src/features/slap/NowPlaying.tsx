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
import { useSheetDrag } from '../../lib/gestures'
import { AddToPlaylist } from './AddToPlaylist'
import { CommentBox, CommentThread } from './Comments'
import { RoomChatInline } from './RoomChat'
import {
  artUrl, findSources, fmtTime, names, replaceTrack, rerollStatus, shareSong, sourceLink, slapNames, setFavorite, useLibrary, useTrackSocial,
  type Library, type QueueItem, type Source,
} from '../../lib/slap'
import {
  clearUpcoming, closePlayer, current, cycleRepeat, cycleSpeed, enqueue, jump, leaveTogether, move, next, prev, reloadTrack, remove, seek,
  setExpanded, setSleepTimer, toggle, toggleShuffle, useClock, usePlayer, type PlayerState,
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
        <button type="button" className="icon-btn miniplayer-close" onClick={closePlayer} aria-label={s.mode === 'together' ? 'Leave Listen Together and close the player' : 'Stop playing'}><Icon name="close" /></button>
      </div>
      <span className="sr-only" aria-live="polite">{s.blocked ? 'Playback is waiting for a tap' : ''}</span>
    </section>
  )
}

// ── Art colour extraction for the backdrop ──────────────────────────────────
function avgColor(data: Uint8ClampedArray, startX: number, startY: number, w: number, h: number, imgW: number): string {
  let r = 0, g = 0, b = 0, count = 0
  for (let y = startY; y < startY + h; y++) {
    for (let x = startX; x < startX + w; x++) {
      const i = (y * imgW + x) * 4
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; count++
    }
  }
  if (!count) return '#1a0533'
  const hex = (n: number) => Math.round(n / count).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function useArtColors(artId: string | null | undefined): [string, string] {
  const [colors, setColors] = useState<[string, string]>(['#1a0533', '#0d1a33'])
  useEffect(() => {
    if (!artId) { setColors(['#1a0533', '#0d1a33']); return }
    const url = artUrl(artId, 96)
    if (!url) { setColors(['#1a0533', '#0d1a33']); return }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 10; canvas.height = 10
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, 10, 10)
        const data = ctx.getImageData(0, 0, 10, 10).data
        const c1 = avgColor(data, 0, 0, 5, 5, 10)
        const c2 = avgColor(data, 5, 5, 5, 5, 10)
        setColors([c1, c2])
      } catch { setColors(['#1a0533', '#0d1a33']) }
    }
    img.onerror = () => setColors(['#1a0533', '#0d1a33'])
    img.src = url
  }, [artId])
  return colors
}

export function PlayerSheet() {
  const s = usePlayer()
  const desktop = useDesktop()
  const drag = useSheetDrag(() => setExpanded(false))
  const item = current(s)
  const [reroll, setReroll] = useState<QueueItem | null>(null)
  const [addTo, setAddTo] = useState<QueueItem | null>(null)
  const colors = useArtColors(item?.art)
  return (
    <Dialog.Root open={s.expanded} onOpenChange={setExpanded}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content ref={desktop ? undefined : drag} className={desktop ? 'dialog player-dialog' : 'sheet sheet-player'} aria-describedby={undefined}>
          {/* blurred + colour-sampled art backdrop (mobile full-screen sheet only) */}
          {!desktop && (
            <div
              className="player-backdrop player-backdrop-mesh"
              style={{ '--c1': colors[0], '--c2': colors[1], ...(item?.art ? { backgroundImage: `url(${artUrl(item.art, 300)})` } : {}) } as React.CSSProperties}
              aria-hidden="true"
            />
          )}
          {/* inner scroll wrapper on mobile; desktop dialog scrolls natively */}
          <div className={desktop ? undefined : 'player-scroll'}>
            {!desktop && <div className="sheet-knob-row"><span className="sheet-knob" /></div>}
            <div className="sheet-title-row">
              <Dialog.Title className={desktop ? 'sheet-title' : 'sr-only'}>
                {s.mode === 'together' ? 'Listen Together' : 'Now playing'}
              </Dialog.Title>
              <div className="player-head-tools">
                {item && s.mode === 'solo' && <SleepTimerButton s={s} />}
                {item && (
                  <Menu.Root>
                    <Menu.Trigger asChild>
                      <button type="button" className="icon-btn" aria-label={`More for ${item.title}`}><Icon name="more" /></button>
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Content className="menu-content" sideOffset={4} align="end">
                        {s.mode === 'solo' && (
                          <>
                            <Menu.Item className="menu-item" onSelect={() => enqueue([item], true)}>Play next</Menu.Item>
                            <Menu.Item className="menu-item" onSelect={() => enqueue([item], false)}>Add to end of queue</Menu.Item>
                            <Menu.Separator className="menu-separator" />
                          </>
                        )}
                        <Menu.Item className="menu-item" onSelect={() => setAddTo(item)}>Add to playlist…</Menu.Item>
                        <Menu.Item className="menu-item" onSelect={() => shareSong(item)}>Share song</Menu.Item>
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
            <PlayerBody s={s} onAdd={setAddTo} />
          </div>
          {reroll && <RerollDialog item={reroll} onClose={() => setReroll(null)} />}
          {addTo && <AddToPlaylist ids={[addTo.id]} title={addTo.title} open onOpenChange={(v) => { if (!v) setAddTo(null) }} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Sleep timer button ───────────────────────────────────────────────────────
function formatRemaining(deadline: number): string {
  const ms = deadline - Date.now()
  if (ms <= 0) return '0s'
  const totalSec = Math.ceil(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  return `${Math.ceil(totalSec / 60)}m`
}

function SleepTimerButton({ s }: { s: PlayerState }) {
  useClock() // re-render each tick so countdown stays fresh
  const armed = s.sleepTimer !== null
  const label = armed
    ? s.sleepTimer!.afterTrack ? 'After track' : formatRemaining(s.sleepTimer!.deadline)
    : '🌙'
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="icon-btn sleep-btn"
          aria-label={armed ? `Sleep timer: ${label}` : 'Set sleep timer'}
          data-armed={armed || undefined}
        >
          {label}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-content" sideOffset={4} align="end">
          {armed && <Menu.Item className="menu-item" onSelect={() => setSleepTimer(null)}>Cancel timer</Menu.Item>}
          {armed && <Menu.Separator className="menu-separator" />}
          <Menu.Item className="menu-item" onSelect={() => setSleepTimer(15)}>15 min</Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => setSleepTimer(30)}>30 min</Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => setSleepTimer(45)}>45 min</Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => setSleepTimer(60)}>60 min</Menu.Item>
          <Menu.Separator className="menu-separator" />
          <Menu.Item className="menu-item" onSelect={() => setSleepTimer('track')}>After this track</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
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
                <p className="reroll-wait" role="status"><span className="spinner" aria-hidden="true" />Searching YouTube{asked ? ` for "${asked}"` : ''}… this can take half a minute.</p>
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

function PlayerBody({ s, onAdd }: { s: PlayerState; onAdd: (item: QueueItem) => void }) {
  const item = current(s)
  const queue = s.mode === 'together' ? s.room?.queue ?? [] : s.queue
  const index = s.mode === 'together' ? s.room?.index ?? -1 : s.index
  const speedLabel = `${s.speed}×`
  return (
    <div className="player-body">
      {s.mode === 'together' && <TogetherBanner s={s} />}
      {/* Art lives outside player-main so desktop grid can put it in its own column */}
      <Art id={item?.art} size={600} className="slap-art player-art" />
      <div className="player-main">
        <div className="player-meta-row">
          <div className="player-meta">
            <p className="player-title">{item?.title ?? 'Nothing playing'}</p>
            <p className="player-artist">{item ? [item.artist, item.album].filter(Boolean).join(' · ') : s.mode === 'together' ? 'Add a track from Listen to start the room.' : 'Pick something from Listen.'}</p>
            <AddedBy item={item} together={s.mode === 'together'} />
          </div>
          {item && <SongButtons item={item} onAdd={() => onAdd(item)} />}
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
        {s.mode === 'solo' && (
          <div className="player-controls-row2">
            <button
              type="button"
              className="icon-btn speed-btn"
              onClick={cycleSpeed}
              aria-label={`Playback speed: ${speedLabel}`}
              aria-pressed={s.speed !== 1}
            >
              {speedLabel}
            </button>
          </div>
        )}
        <Seek disabled={!item} />
        {s.blocked && <button type="button" className="btn btn-primary" onClick={toggle}>Tap to listen with everyone</button>}
        {item && <TrackTalk item={item} together={s.mode === 'together'} />}
        <button type="button" className="btn btn-ghost player-close" onClick={closePlayer}>
          <Icon name="close" />{s.mode === 'together' ? 'Leave and close player' : 'Stop playing'}
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
  const pct = duration ? (v / duration) * 100 : 0
  return (
    <div className="seek" data-active={drag != null || undefined}>
      {drag != null && (
        <span
          className="seek-tooltip"
          style={{ left: `calc(${pct}% * (100% - 20px) / 100 + 10px)` }}
          aria-hidden="true"
        >
          {fmtTime(drag)}
        </span>
      )}
      <input
        type="range" className="seek-range" min={0} max={Math.max(1, Math.floor(duration))} step={1} value={Math.min(v, duration || 0)}
        disabled={disabled} aria-label="Seek" aria-valuetext={`${fmtTime(v)} of ${fmtTime(duration)}`}
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => { if (drag != null) { seek(drag); setDrag(null) } }}
        onKeyUp={() => { if (drag != null) { seek(drag); setDrag(null) } }}
        onBlur={() => { if (drag != null) { seek(drag); setDrag(null) } }}
      />
      <div className="seek-times num"><span>{fmtTime(v)}</span><span>{fmtTime(duration)}</span></div>
    </div>
  )
}

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

/** Beside the title, like a native player: the heart keeps the song in your Favorites
 *  playlist, the + puts it in any playlist you can edit. */
function SongButtons({ item, onAdd }: { item: QueueItem; onAdd: () => void }) {
  const qc = useQueryClient()
  // Subscribe, don't snapshot: getQueryData never re-renders, so the heart used to
  // write the favourite but keep drawing the old state. It also loads the library when
  // the player was opened from a page that never fetched it.
  const fav = useLibrary().data?.tracks.find((t) => t.id === item.id)?.fav ?? false
  const mark = (on: boolean) =>
    qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === item.id ? { ...x, fav: on } : x)) })

  function favourite() {
    const on = !fav
    mark(on)
    setFavorite(item.id, on)
      .then(() => {
        toast(on ? 'Saved to Favorites' : 'Removed from Favorites', 'success')
        void qc.invalidateQueries({ queryKey: ['slap', 'library'] })
        void qc.invalidateQueries({ queryKey: ['slap', 'playlist'] })
      })
      .catch((e) => { mark(!on); toast(e instanceof ApiError && e.detail ? e.detail : "Slap didn't take that", 'error') })
  }
  return (
    <div className="player-song-btns">
      <button type="button" className="icon-btn" onClick={onAdd} aria-label={`Add ${item.title} to a playlist`}>
        <Icon name="plus" />
      </button>
      <button type="button" className="icon-btn fav-btn" onClick={favourite} aria-pressed={fav} data-on={fav}
        aria-label={fav ? 'Remove from Favorites' : 'Save to Favorites'}>
        <Icon name={fav ? 'heartFill' : 'heart'} />
      </button>
    </div>
  )
}

function TrackTalk({ item, together }: { item: QueueItem; together: boolean }) {
  const t = { id: item.id, title: item.title, artist: item.artist, album: item.album }
  return (
    <div className="track-actions">
      {/* Together, the room talks in one chat that runs across every song; alone, each song keeps its comments. */}
      {together ? <RoomChatInline /> : <><CommentThread trackId={item.id} /><CommentBox item={t} /></>}
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

/** Shared context menu for a queue item — play next, add to end, add to playlist, share. */
function QueueTrackMenu({ item }: { item: QueueItem }) {
  const [addOpen, setAddOpen] = useState(false)
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className="icon-btn" aria-label={`More for ${item.title}`}><Icon name="more" /></button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu-content" sideOffset={4} align="end">
            <Menu.Item className="menu-item" onSelect={() => enqueue([item], true)}>Play next</Menu.Item>
            <Menu.Item className="menu-item" onSelect={() => enqueue([item], false)}>Add to end of queue</Menu.Item>
            <Menu.Separator className="menu-separator" />
            <Menu.Item className="menu-item" onSelect={() => setAddOpen(true)}>Add to playlist…</Menu.Item>
            <Menu.Item className="menu-item" onSelect={() => shareSong(item)}>Share song</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {addOpen && <AddToPlaylist ids={[item.id]} title={item.title} open onOpenChange={(v) => { if (!v) setAddOpen(false) }} />}
    </>
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
              {!together && <QueueTrackMenu item={q} />}
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
