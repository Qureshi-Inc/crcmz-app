// The one audio element for the whole app. It lives outside React so a route
// change never stops the music. Two modes:
//   solo      – a personal queue kept in localStorage.
//   together  – the shared Listen Together room. The server owns the queue and the
//               playhead; this tab follows it over SSE and sends every control as a
//               command, so anyone in the room can drive it.
import { useSyncExternalStore } from 'react'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { readLocal, writeLocal } from '../../lib/media'
import * as lockScreen from '../../lib/mediaSession'
import { artUrl, bumpStream, reportListen, streamUrl, together, type QueueItem, type Room, type TogetherOp, type Track } from '../../lib/slap'

export type Repeat = 'off' | 'all' | 'one'
export type Link = 'off' | 'connecting' | 'live' | 'retrying'
export type PlayerState = {
  mode: 'solo' | 'together'
  queue: QueueItem[]
  index: number
  playing: boolean
  shuffle: boolean
  repeat: Repeat
  room: Room | null
  link: Link
  /** The browser refused to start sound without a tap (autoplay policy). */
  blocked: boolean
  loading: boolean
  expanded: boolean
}
export type Clock = { position: number; duration: number }

const KEY = 'slap.player.v1'
const DRIFT_S = 1.5
const QUEUE_MAX = 500

type Saved = { queue: QueueItem[]; index: number; shuffle: boolean; repeat: Repeat; position: number; order: string[] | null }
const saved = readLocal<Saved | null>(KEY, null)

let state: PlayerState = {
  mode: 'solo',
  queue: Array.isArray(saved?.queue) ? saved.queue.slice(0, QUEUE_MAX) : [],
  index: saved && saved.index < (saved.queue?.length ?? 0) ? saved.index : -1,
  playing: false,
  shuffle: !!saved?.shuffle,
  repeat: saved?.repeat === 'all' || saved?.repeat === 'one' ? saved.repeat : 'off',
  room: null,
  link: 'off',
  blocked: false,
  loading: false,
  expanded: false,
}
let clock: Clock = { position: saved?.position ?? 0, duration: 0 }
/** Where the solo track was when Together took over the element. */
let soloPos = saved?.position ?? 0
/** Queue order before shuffle, by qid, so turning shuffle off puts it back. */
let unshuffled: string[] | null = saved?.order ?? null

const listeners = new Set<() => void>()
const clockListeners = new Set<() => void>()

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
  syncLockScreen()
  if ('queue' in patch || 'index' in patch || 'shuffle' in patch || 'repeat' in patch) persist()
}
function persist() {
  writeLocal(KEY, { queue: state.queue, index: state.index, shuffle: state.shuffle, repeat: state.repeat, position: soloPosition(), order: unshuffled })
}
function soloPosition() {
  if (state.mode !== 'solo') return soloPos
  return loaded ? audio?.currentTime ?? 0 : clock.position
}

export function usePlayer(): PlayerState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}
export function useClock(): Clock {
  return useSyncExternalStore((cb) => { clockListeners.add(cb); return () => { clockListeners.delete(cb) } }, () => clock)
}
export function current(s: PlayerState = state): QueueItem | null {
  if (s.mode === 'together') return s.room ? s.room.queue[s.room.index] ?? null : null
  return s.queue[s.index] ?? null
}
export const getState = () => state

// ── The audio element ───────────────────────────────────────────────────────
let audio: HTMLAudioElement | null = null
let loaded: string | null = null        // qid whose stream is in the element
let pendingSeek: number | null = null

function el(): HTMLAudioElement {
  if (audio) return audio
  const a = new Audio()
  a.preload = 'auto'
  a.addEventListener('timeupdate', () => { tickListen(); setClock(a.currentTime, a.duration) })
  a.addEventListener('durationchange', () => setClock(a.currentTime, a.duration))
  a.addEventListener('loadedmetadata', () => {
    if (pendingSeek != null) { a.currentTime = Math.min(pendingSeek, Number.isFinite(a.duration) ? a.duration : pendingSeek); pendingSeek = null }
  })
  a.addEventListener('seeked', () => { listen.lastT = a.currentTime })
  a.addEventListener('playing', () => set({ loading: false, blocked: false }))
  a.addEventListener('waiting', () => set({ loading: true }))
  a.addEventListener('pause', () => { if (state.mode === 'solo') { set({ playing: false }); persist() } })
  a.addEventListener('play', () => { if (state.mode === 'solo' && !state.playing) set({ playing: true }) })
  a.addEventListener('ended', onEnded)
  a.addEventListener('error', () => {
    if (!a.getAttribute('src')) return
    set({ loading: false })
    toast("That track wouldn't load", 'error')
  })
  window.addEventListener('pagehide', () => { persist(); finishListen(false) })
  audio = a
  return a
}

function setClock(position: number, duration: number) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : current()?.duration ?? 0
  if (Math.abs(position - clock.position) < 0.2 && d === clock.duration) return
  clock = { position, duration: d }
  clockListeners.forEach((l) => l())
  syncLockScreen()
}

/** Put `item` in the element (if it is not already) and start from `at`. */
function load(item: QueueItem, at: number) {
  const a = el()
  if (loaded !== item.qid) {
    finishListen(false)
    loaded = item.qid
    pendingSeek = at > 0.5 ? at : null
    a.src = streamUrl(item.id)
    startListen(item)
    setClock(at, item.duration)
    set({ loading: true })
  } else if (Math.abs(a.currentTime - at) > DRIFT_S) {
    if (a.readyState >= 1) a.currentTime = at
    else pendingSeek = at
  }
}

function unload() {
  finishListen(false)
  const a = audio
  loaded = null
  if (a) { a.pause(); a.removeAttribute('src'); a.load() }
  setClock(0, 0)
  set({ loading: false })
}

async function start() {
  lockScreen.claim('slap', lockSpec())
  try {
    await el().play()
  } catch (e) {
    if ((e as DOMException)?.name === 'NotAllowedError') set({ blocked: true, loading: false })
  }
}

// ── Play/skip reporting (stamped server-side with the caller's own name) ─────
const listen: { item: QueueItem | null; heard: number; lastT: number | null } = { item: null, heard: 0, lastT: null }
function startListen(item: QueueItem) { listen.item = item; listen.heard = 0; listen.lastT = null }
function tickListen() {
  const a = audio
  if (!a || a.paused || !listen.item) return
  const t = a.currentTime
  if (listen.lastT != null) {
    const d = t - listen.lastT
    if (d > 0 && d < 2) listen.heard += d
  }
  listen.lastT = t
}
function finishListen(completed: boolean) {
  const item = listen.item
  const heard = listen.heard
  listen.item = null
  if (!item) return
  // Under 3 s is a mis-tap, not a skip. 15 s or a finish counts as a play.
  const kind = completed || heard >= 15 ? 'play' : heard >= 3 ? 'skip' : null
  if (kind) reportListen(kind, item, completed ? Math.max(heard, item.duration) : heard, completed).catch(() => {})
}

function onEnded() {
  const a = el()
  if (state.mode === 'together') {
    const qid = loaded
    finishListen(true)
    if (qid) cmd('ended', { qid }, true)
    return
  }
  finishListen(true)
  if (state.repeat === 'one') {
    const item = current()
    if (item) { startListen(item); a.currentTime = 0; void start() }
    return
  }
  if (state.index + 1 < state.queue.length) return goSolo(state.index + 1, true)
  if (state.repeat === 'all' && state.queue.length) return goSolo(0, true)
  set({ playing: false })
  a.currentTime = 0
}

// ── Solo queue ──────────────────────────────────────────────────────────────
let seq = 0
const qid = () => `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`
export const toItem = (t: Track | QueueItem): QueueItem => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album, album_id: t.album_id, duration: t.duration, art: t.art, qid: qid(),
})

function goSolo(index: number, play: boolean) {
  const item = state.queue[index]
  if (!item) return
  set({ index, playing: play })
  load(item, 0)
  if (play) void start()
}

function shuffled<T>(xs: T[]): T[] {
  const a = xs.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** Replace the solo queue with `tracks` and start at `startAt`. */
export function playList(tracks: (Track | QueueItem)[], startAt = 0, opts: { shuffle?: boolean } = {}) {
  if (!tracks.length) return
  if (state.mode === 'together') {
    cmd('replace', { ids: tracks.slice(0, QUEUE_MAX).map((t) => t.id), start: startAt })
    return
  }
  let items = tracks.slice(0, QUEUE_MAX).map(toItem)
  let idx = Math.max(0, Math.min(startAt, items.length - 1))
  const shuffle = opts.shuffle ?? state.shuffle
  unshuffled = null
  if (shuffle) {
    unshuffled = items.map((i) => i.qid)
    const first = items[idx]!
    items = [first, ...shuffled(items.filter((_, i) => i !== idx))]
    idx = 0
  }
  set({ queue: items, shuffle })
  goSolo(idx, true)
}

/** Queue after the current track ("Play next") or at the end. */
export function enqueue(tracks: (Track | QueueItem)[], next: boolean) {
  if (!tracks.length) return
  if (state.mode === 'together') {
    cmd(next ? 'next_up' : 'add', { ids: tracks.map((t) => t.id) })
    return
  }
  const items = tracks.map(toItem)
  const q = state.queue.slice()
  const at = next && state.index >= 0 ? state.index + 1 : q.length
  q.splice(at, 0, ...items)
  if (unshuffled) unshuffled.push(...items.map((i) => i.qid))
  const idle = state.index < 0
  set({ queue: q.slice(0, QUEUE_MAX), index: idle ? 0 : state.index })
  if (idle) { goSolo(0, true); return }
  toast(next ? `Playing next: ${items.length === 1 ? items[0]!.title : `${items.length} tracks`}` : `Added ${items.length === 1 ? items[0]!.title : `${items.length} tracks`} to your queue`, 'success')
}

export function toggleShuffle() {
  if (state.mode === 'together') return
  const cur = state.queue[state.index]
  const head = state.queue.slice(0, state.index + 1)
  const rest = state.queue.slice(state.index + 1)
  if (!state.shuffle) {
    unshuffled = state.queue.map((i) => i.qid)
    set({ shuffle: true, queue: [...head, ...shuffled(rest)] })
  } else {
    const order = new Map((unshuffled ?? []).map((q, i) => [q, i]))
    const all = state.queue.slice().sort((a, b) => (order.get(a.qid) ?? 1e9) - (order.get(b.qid) ?? 1e9))
    unshuffled = null
    set({ shuffle: false, queue: all, index: cur ? all.findIndex((i) => i.qid === cur.qid) : state.index })
  }
}

export function cycleRepeat() {
  set({ repeat: state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off' })
}

// ── Controls (route to the room when together) ──────────────────────────────
export function toggle() {
  if (state.mode === 'together') {
    const r = state.room
    if (!r || r.index < 0) { if (r?.queue.length) cmd('play'); return }
    if (state.blocked) { void start(); return }
    cmd(r.playing ? 'pause' : 'play')
    return
  }
  const item = current()
  if (!item) return
  const a = el()
  if (loaded !== item.qid) {
    load(item, clock.position)
    set({ playing: true })
    void start()
  } else if (a.paused) { set({ playing: true }); void start() } else a.pause()
}

export function next() {
  if (state.mode === 'together') return cmd('next')
  if (state.index + 1 < state.queue.length) goSolo(state.index + 1, true)
  else if (state.repeat === 'all' && state.queue.length) goSolo(0, true)
}

export function prev() {
  if (state.mode === 'together') return cmd('prev')
  const a = el()
  if (a.currentTime > 3 || state.index <= 0) { a.currentTime = 0; return }
  goSolo(state.index - 1, true)
}

export function seek(s: number) {
  if (state.mode === 'together') return cmd('seek', { position: s })
  const item = current()
  if (!item) return
  const a = el()
  if (loaded !== item.qid) { load(item, s); setClock(s, item.duration); return }
  a.currentTime = s
  setClock(s, a.duration)
}

export function jump(index: number) {
  if (state.mode === 'together') return cmd('jump', { index })
  goSolo(index, true)
}

export function remove(q: string) {
  if (state.mode === 'together') return cmd('remove', { qid: q })
  const i = state.queue.findIndex((x) => x.qid === q)
  if (i < 0) return
  const queue = state.queue.filter((x) => x.qid !== q)
  if (i === state.index) {
    if (!queue.length) { unload(); set({ queue, index: -1, playing: false }); return }
    const ni = Math.min(i, queue.length - 1)
    const wasPlaying = state.playing
    set({ queue, index: ni })
    loaded = null
    goSolo(ni, wasPlaying)
    return
  }
  set({ queue, index: i < state.index ? state.index - 1 : state.index })
}

export function move(q: string, to: number) {
  if (state.mode === 'together') return cmd('move', { qid: q, to })
  const from = state.queue.findIndex((x) => x.qid === q)
  if (from < 0) return
  const cur = state.queue[state.index]?.qid
  const queue = state.queue.slice()
  const [it] = queue.splice(from, 1)
  queue.splice(Math.max(0, Math.min(to, queue.length)), 0, it!)
  set({ queue, index: cur ? queue.findIndex((x) => x.qid === cur) : state.index })
}

/** Drop everything except what is playing now. */
export function clearUpcoming() {
  if (state.mode === 'together') return cmd('clear')
  const cur = state.queue[state.index]
  set({ queue: cur ? [cur] : [], index: cur ? 0 : -1 })
}

/** The file behind `id` was replaced: fetch it fresh, and restart it if it's on now. */
export function reloadTrack(id: string, duration = 0) {
  bumpStream(id)
  if (duration > 0 && state.mode === 'solo') set({ queue: state.queue.map((q) => (q.id === id ? { ...q, duration } : q)) })
  const item = current()
  if (!item || item.id !== id || loaded !== item.qid) return
  const wasPlaying = state.playing && !!audio && !audio.paused
  loaded = null
  load(item, 0)
  if (wasPlaying) void start()
}

/** Stop and put the player away: no sound, no queue, no mini-player. */
export function closePlayer() {
  leaveTogether()
  unload()
  unshuffled = null
  soloPos = 0
  set({ queue: [], index: -1, playing: false, blocked: false, expanded: false })
  lockScreen.release('slap')
}

export function setExpanded(expanded: boolean) { set({ expanded }) }

// ── Listen Together ─────────────────────────────────────────────────────────
let es: EventSource | null = null
let receivedAt = 0
let driftTimer = 0
let backoff = 0

function expected(r: Room): number {
  const cur = r.queue[r.index]
  const p = r.position + (r.playing ? (performance.now() - receivedAt) / 1000 : 0)
  return cur?.duration ? Math.min(p, cur.duration) : p
}

/** The stream is ordered and authoritative; a command reply can arrive after a newer frame. */
function applyRoom(r: Room, fromStream = false) {
  if (!fromStream && state.room && r.version < state.room.version) return
  receivedAt = performance.now()
  set({ room: r })
  follow()
}

/** Make the local element match the room: right track, right place, right state. */
function follow() {
  const r = state.room
  if (state.mode !== 'together' || !r) return
  const cur = r.queue[r.index]
  if (!cur) { if (loaded) unload(); set({ playing: false }); return }
  load(cur, expected(r))
  set({ playing: r.playing })
  const a = el()
  if (r.playing && a.paused) void start()
  else if (!r.playing && !a.paused) a.pause()
  if (!r.playing) setClock(r.position, cur.duration)
}

function cmd(op: TogetherOp, extra: Record<string, unknown> = {}, quiet = false) {
  together(op, extra).then((r) => applyRoom(r)).catch((e) => {
    if (quiet) return
    const msg = e instanceof ApiError && e.detail ? e.detail : "Listen Together didn't take that"
    toast(msg, 'error')
  })
}

export function joinTogether() {
  if (state.mode === 'together') return
  // Keep the solo place so leaving puts you back where you were.
  soloPos = audio && loaded ? audio.currentTime : clock.position
  audio?.pause()
  persist()
  finishListen(false)
  loaded = null
  set({ mode: 'together', link: 'connecting', room: null, playing: false, blocked: false })
  open()
  window.clearInterval(driftTimer)
  driftTimer = window.setInterval(() => {
    const r = state.room
    if (state.mode !== 'together' || !r?.playing || !audio || audio.paused) return
    if (Math.abs(audio.currentTime - expected(r)) > DRIFT_S * 1.5) follow()
  }, 5000)
}

function open() {
  const src = new EventSource('/api/slap/together/events')
  es = src
  src.addEventListener('open', () => { backoff = 0; set({ link: 'live' }) })
  src.addEventListener('state', (e) => {
    try { applyRoom(JSON.parse((e as MessageEvent<string>).data) as Room, true) } catch { /* ignore a torn frame */ }
  })
  src.addEventListener('error', () => {
    if (es !== src) return
    if (src.readyState === EventSource.CLOSED) {
      // The server refused (signed out, not set up) or the connection died for good.
      src.close()
      es = null
      if (state.mode !== 'together') return
      set({ link: 'retrying' })
      backoff = Math.min(backoff ? backoff * 2 : 2000, 30_000)
      if (backoff >= 30_000 && state.link === 'retrying') {
        toast("Lost Listen Together. Rejoin when you're back online.", 'error')
        leaveTogether()
        return
      }
      window.setTimeout(() => { if (state.mode === 'together' && !es) open() }, backoff)
    } else set({ link: 'retrying' })
  })
}

export function leaveTogether() {
  window.clearInterval(driftTimer)
  es?.close()
  es = null
  backoff = 0
  if (state.mode !== 'together') return
  unload()
  set({ mode: 'solo', room: null, link: 'off', playing: false, blocked: false })
  const item = current()
  if (item) setClock(soloPos, item.duration)
}

/** Seed the room with my solo queue from the track I'm on. */
export function shareMyQueue() {
  if (state.mode !== 'together') return
  if (!state.queue.length) { toast('Your queue is empty', 'warning'); return }
  cmd('replace', { ids: state.queue.map((i) => i.id), start: Math.max(0, state.index) })
}

// ── Media Session (lock screen, headphone buttons) ──────────────────────────
// Together mode needs nothing special: toggle/next/prev/seek already go to the room.
const SKIP_S = 10
const handlers: lockScreen.Handlers = {
  play: () => { if (!state.playing || state.blocked) toggle() },
  pause: () => { if (state.playing) toggle() },
  nexttrack: () => next(),
  previoustrack: () => prev(),
  seekto: (d) => { if (d.seekTime != null) seek(d.seekTime) },
  seekbackward: (d) => seek(Math.max(0, clock.position - (d.seekOffset || SKIP_S))),
  seekforward: (d) => seek(Math.min(clock.duration || Infinity, clock.position + (d.seekOffset || SKIP_S))),
}

function lockSpec(): lockScreen.Spec {
  const item = current()
  const together = state.mode === 'together'
  return {
    title: item?.title ?? 'Slap',
    artist: item?.artist ?? '',
    album: together ? 'Listen Together' : item?.album ?? '',
    art: item?.art ? ([300, 600] as const).map((size) => ({ src: artUrl(item.art, size)!, size })) : [],
    playing: state.playing && !state.blocked,
    handlers,
    position: item ? { at: clock.position, duration: clock.duration || item.duration } : null,
  }
}

function syncLockScreen() {
  if (lockScreen.holds('slap')) lockScreen.update('slap', lockSpec())
}
