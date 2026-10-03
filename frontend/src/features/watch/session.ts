// The Watch Party session: socket, synced player, the camera call and history
// pings. It lives outside React, like Slap's player, so leaving /watch keeps the
// party going. A port of the classic client (server.py, wp*), same wire protocol:
//   socket   WatchParty over socket.io, a fresh Watch Ticket per connect
//   sync     REC:host/play/pause/seek in, CMD:* out; remote applies are fenced by
//            `applying` so they never echo back; drift > 3 s vs the room median seeks
//   call     a WebRTC mesh over the `signal` relay with perfect negotiation, STUN only;
//            peer audio plays through hidden <audio> elements owned here, so the UI
//            can re-render (or the page can hide) without touching sound
import { useSyncExternalStore } from 'react'
import { toast } from '../../components/toast'
import { muteOtherCalls, registerCall } from '../../lib/calls'
import { ApiError, request } from '../../lib/http'
import { readLocal, writeLocal } from '../../lib/media'
import { openPip, pipSupported, setPipStream, stopPip, streamOf } from '../../lib/pip'
import * as lockScreen from '../../lib/mediaSession'
import {
  beacon, extract, fmtTime, getConfig, isDirect, isProxy, joinRoom, loadScript, REACTIONS, setNickname,
  rally as postRally, ytId, type WatchConfig,
} from '../../lib/watch'

// ── Minimal shapes of the three libraries loaded at runtime ─────────────────
type Sock = {
  connected: boolean; id?: string
  emit: (ev: string, ...a: unknown[]) => void
  on: (ev: string, fn: (...a: never[]) => void) => void
  removeAllListeners: (ev?: string) => void
  disconnect: () => void
}
type IoFn = (url: string, opts: Record<string, unknown>) => Sock
type YtPlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(t: number, ahead: boolean): void; getCurrentTime(): number; getDuration(): number
  getVideoLoadedFraction(): number; setVolume(v: number): void; mute(): void; unMute(): void; destroy(): void
  getVideoData?: () => { title?: string }
  // Captions (the player's own module).
  loadModule?: (m: string) => void; unloadModule?: (m: string) => void; setOption?: (m: string, k: string, v: unknown) => void
}
type YtNs = { Player: new (el: HTMLElement, o: Record<string, unknown>) => YtPlayer; PlayerState: { PLAYING: number; PAUSED: number } }
type HlsInst = { loadSource(u: string): void; attachMedia(v: HTMLVideoElement): void; destroy(): void; on(e: string, f: (ev: unknown, d: { fatal?: boolean; type?: string; details?: string }) => void): void; once(e: string, f: () => void): void }
type HlsNs = { new (): HlsInst; isSupported(): boolean; Events: { ERROR: string; MANIFEST_PARSED: string } }
declare global {
  interface Window { io?: IoFn; YT?: YtNs; Hls?: HlsNs; onYouTubeIframeAPIReady?: () => void; webkitAudioContext?: typeof AudioContext }
}

export type Status = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed' | 'kicked' | 'forbidden' | 'signin' | 'unavailable'
export type ChatMsg = { id: string; msg: string; cmd?: string }
export type Presence = { count: number; viewers: { id: string; name: string }[] }
export type RosterEntry = { id: string; isMod?: boolean }
export type Call = { on: boolean; muted: boolean; micOnly: boolean; camOff: boolean; facing: 'user' | 'environment'; busy: boolean; note: string }
export type Device = { id: string; label: string }
export type Unblock = '' | 'play' | 'unmute'
/** Cameras outside the video (top/bottom) or on it: 'over' is the side column (its stored name predates the others). */
export type OrbPos = 'top' | 'bottom' | 'over' | 'overTop' | 'overBottom'

export type WatchState = {
  active: boolean
  status: Status
  /** Inline error under the URL field (socket errorMessage, extract failure, …). */
  error: string
  cfg: WatchConfig | null
  room: string
  clientId: string
  myName: string
  isMod: boolean
  presence: Presence
  roster: RosterEntry[]
  names: Record<string, string>
  video: string
  kind: '' | 'file' | 'yt'
  ytFresh: boolean
  playing: boolean
  unblock: Unblock
  mediaError: '' | 'unsupported' | 'failed'
  chat: ChatMsg[]
  call: Call
  /** Bumped on any peer connection or track change; read the details with peerView(). */
  rtc: number
  loud: Record<string, boolean>
  playerVol: number
  playerMuted: boolean
  camVol: number
  camMuted: boolean
  prefs: Record<string, { v: number; m: boolean }>
  fs: boolean
  /** The library film's subtitles (none for other videos), and which one is on (index, or null). */
  subs: SubTrack[]
  sub: number | null
  /** YouTube's own captions are on. */
  ytCc: boolean
  extracting: boolean
  /** Extract 429: Play counts down to this (ms). */
  extractUntil: number
  title: string
  needGesture: boolean
  histTick: number
  mics: Device[]
  speakers: Device[]
  micId: string
  speakerId: string
  orbPos: OrbPos
}
export type SubTrack = { index: number; label: string; lang: string; text: boolean; forced: boolean }
export type Clock = { t: number; dur: number; buf: number; live: boolean }

const MAX_TRIES = 6
// The orbs are small, so a tiny stream looks identical to a big one and keeps the
// call affordable on phone uplinks.
const CAM_BITRATE = 260_000
const VIDEO_C = { width: { ideal: 320 }, height: { ideal: 320 }, frameRate: { ideal: 15, max: 20 } }
const RX_WINDOW = 5000
const RX_NEED = 3
export const ORB_KEY = 'watch.orbs.pos'
const PREFS_KEY = 'wpPeerVol'

function clientId(): string {
  try {
    let id = sessionStorage.getItem('crcmzWatchClientId')
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('crcmzWatchClientId', id) }
    return id
  } catch { return crypto.randomUUID() }
}
function sessionId(): string {
  try {
    let id = localStorage.getItem('crcmzWatchSessionId')
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('crcmzWatchSessionId', id) }
    return id
  } catch { return crypto.randomUUID() }
}
const readOrbPos = (): OrbPos => { const v = readLocal<string>(ORB_KEY, 'bottom'); return v === 'top' || v === 'over' || v === 'overTop' || v === 'overBottom' ? v : 'bottom' }

let state: WatchState = {
  active: false, status: 'idle', error: '', cfg: null, room: '', clientId: clientId(), myName: '', isMod: false,
  presence: { count: 0, viewers: [] }, roster: [], names: {},
  video: '', kind: '', ytFresh: false, playing: false, unblock: '', mediaError: '',
  chat: [], call: { on: false, muted: true, micOnly: false, camOff: false, facing: 'user', busy: false, note: '' },
  rtc: 0, loud: {}, playerVol: 1, playerMuted: false, camVol: 1, camMuted: false,
  prefs: readLocal<Record<string, { v: number; m: boolean }>>(PREFS_KEY, {}),
  fs: false, subs: [], sub: null, ytCc: false, extracting: false, extractUntil: 0, title: '', needGesture: false, histTick: 0,
  mics: [], speakers: [], micId: '', speakerId: '', orbPos: readOrbPos(),
}
let clock: Clock = { t: 0, dur: NaN, buf: 0, live: false }
const listeners = new Set<() => void>()
const clockListeners = new Set<() => void>()
function set(patch: Partial<WatchState>) {
  state = { ...state, ...patch }
  if (patch.loud || patch.rtc) setPipStream(callPipStream(), 'watch')
  listeners.forEach((l) => l())
}
const setCall = (patch: Partial<Call>) => set({ call: { ...state.call, ...patch } })
const bumpRtc = () => set({ rtc: state.rtc + 1 })

export const getWatch = () => state
export function useWatch(): WatchState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}
/** A primitive slice of the state, so chrome (the Shell) re-renders only when it changes. */
export function useWatchSelect<T extends string | number | boolean>(sel: (s: WatchState) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => sel(state))
}
export function useWatchClock(): Clock {
  return useSyncExternalStore((cb) => { clockListeners.add(cb); return () => { clockListeners.delete(cb) } }, () => clock)
}

// ── Camera position (a per-user preference, also in Settings) ───────────────
export function setOrbPos(p: OrbPos) { writeLocal(ORB_KEY, p); set({ orbPos: p }) }
window.addEventListener('storage', (e) => { if (e.key === ORB_KEY) set({ orbPos: readOrbPos() }) })

// ── Events the UI listens to (reactions, new chat lines) ────────────────────
export type RxEvent = { e: string; name: string; burst: number }
const rxListeners = new Set<(r: RxEvent) => void>()
const chatListeners = new Set<(m: ChatMsg) => void>()
export function onReaction(fn: (r: RxEvent) => void) { rxListeners.add(fn); return () => { rxListeners.delete(fn) } }
export function onChat(fn: (m: ChatMsg) => void) { chatListeners.add(fn); return () => { chatListeners.delete(fn) } }

// ── Diagnostics (POST /api/watch/log, read by the watch_diagnostics MCP tool) ──
type LogEv = { ts: number; type: string; level: string; data?: unknown }
const ring: LogEv[] = []
let logT = 0
const errSeen: Record<string, number> = {}
export const short = (u: string) => {
  if (!u) return ''
  if (isProxy(u)) { try { return `proxy:${(new URL(u, location.origin).searchParams.get('url') || '').split('?')[0]}` } catch { return 'proxy' } }
  return u.split('?')[0] ?? ''
}
function log(type: string, data?: unknown, level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  ring.push({ ts: Date.now(), type, level, ...(data === undefined ? {} : { data }) })
  if (ring.length > 400) ring.splice(0, ring.length - 400)
  if ((level === 'warn' || level === 'error') && !logT) logT = window.setTimeout(flushLog, 2500)
}
function flushLog() {
  window.clearTimeout(logT); logT = 0
  if (!ring.length || !state.room) return
  const events = ring.splice(0, 120)
  void beacon('/api/watch/log', { room: state.room, clientId: state.clientId, session: sessionId(), events }).then((r) => {
    if (!r || r.status === 429 || r.status >= 500) ring.unshift(...events.slice(-200))
  })
}
const snap = () => ({ status: state.status, video: short(state.video), kind: state.kind, t: time(), playing: isPlaying(), call: state.call.on, peers: Object.keys(peers).length })
function logError(msg: string) {
  const k = msg.slice(0, 80)
  errSeen[k] = (errSeen[k] || 0) + 1
  if (errSeen[k]! <= 3) log('js.error', { msg: msg.slice(0, 200) }, 'error')
}

// ── Media handles (the page hands these over once; the page stays mounted) ──
let video: HTMLVideoElement | null = null
let ytBox: HTMLElement | null = null
let layout: HTMLElement | null = null
let yt: YtPlayer | null = null
let hls: HlsInst | null = null
let ytState = -1
let ytLoading: Promise<void> | null = null
let ytPlayT = 0
let applying = 0
// A tap on our own controls inside the echo window above still has to reach the room.
let intent = 0
const echo = () => !applying || Date.now() - intent < 1000
let pendingTS = 0

function remote(fn: () => void) {
  applying++
  try { fn() } finally { window.setTimeout(() => { applying = Math.max(0, applying - 1) }, 400) }
}
export function time(): number | null {
  if (state.kind === 'file') return video && !Number.isNaN(video.currentTime) ? video.currentTime : null
  if (state.kind === 'yt' && yt) { try { return yt.getCurrentTime() } catch { /* not ready */ } }
  return null
}
function duration(): number {
  if (state.kind === 'file') return video ? video.duration : NaN
  if (state.kind === 'yt' && yt) { try { return yt.getDuration() } catch { /* not ready */ } }
  return NaN
}
function buffered(): number {
  if (state.kind === 'file' && video?.buffered) {
    for (let i = video.buffered.length - 1; i >= 0; i--) if (video.buffered.start(i) <= video.currentTime + 0.5) return video.buffered.end(i)
    return 0
  }
  if (state.kind === 'yt' && yt) { try { return yt.getVideoLoadedFraction() * duration() } catch { /* not ready */ } }
  return 0
}
function isPlaying(): boolean {
  if (state.kind === 'file') return !!(video && !video.paused && !video.ended)
  if (state.kind === 'yt') return ytState === 1 || ytState === 3
  return false
}
const syncPlaying = () => {
  const p = isPlaying()
  if (p === state.playing) return
  set({ playing: p })
  // Pressing play on the party (or the room starting it) takes the lock screen.
  if (p) lockScreen.claim('watch', lockSpec())
  else syncLockScreen()
}

export function attachVideo(el: HTMLVideoElement | null) {
  if (!el || el === video) return
  video = el
  el.volume = state.playerVol
  el.muted = state.playerMuted
  el.addEventListener('play', () => { syncPlaying(); if (echo()) sock?.emit('CMD:play') })
  el.addEventListener('pause', () => { syncPlaying(); if (echo()) sock?.emit('CMD:pause') })
  el.addEventListener('ended', syncPlaying)
  el.addEventListener('playing', () => { syncPlaying(); if (state.unblock) set({ unblock: '' }) })
  el.addEventListener('seeked', () => { if (echo()) sock?.emit('CMD:seek', el.currentTime) })
  el.addEventListener('error', () => {
    if (!el.getAttribute('src')) return
    log('video.error', { code: el.error?.code, video: short(state.video) }, 'error')
    set({ mediaError: 'failed' })
  })
  el.addEventListener('stalled', () => log('video.stalled', { t: el.currentTime }, 'warn'))
  el.addEventListener('webkitbeginfullscreen', () => {
    // iPhone Safari has no element fullscreen; back out of the native player and
    // fill the viewport with the stage + cams instead.
    if (document.fullscreenEnabled) return
    window.setTimeout(() => { try { (el as HTMLVideoElement & { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.() } catch { /* */ } set({ fs: true }) }, 0)
  })
  if (state.speakerId) applySink()
}
export function attachYt(el: HTMLElement | null) { if (el) ytBox = el }
export function attachLayout(el: HTMLElement | null) { if (el) layout = el }
/** Where menus and dialogs must portal while fullscreen, or they open behind it. */
export const fsRoot = (): HTMLElement | undefined => (state.fs && layout) || undefined

// ── Player ──────────────────────────────────────────────────────────────────
function play() {
  if (state.kind === 'file' && video) {
    const v = video
    v.play().catch((e: unknown) => playBlocked(v, e))
  } else if (state.kind === 'yt' && yt) {
    yt.playVideo()
    // A blocked YouTube embed just sits unstarted/cued; say so after a beat.
    window.clearTimeout(ytPlayT)
    ytPlayT = window.setTimeout(() => {
      if (state.kind === 'yt' && [-1, 2, 5].includes(ytState)) { log('play.yt_stuck', { state: ytState }, 'warn'); set({ unblock: 'play' }) }
    }, 4000)
  }
}
function pause() {
  if (state.kind === 'file') video?.pause()
  else if (state.kind === 'yt') yt?.pauseVideo()
}
/** Play a little faster or slower to catch up with the room (1 = normal). */
let nudging = 1
function nudge(rate: number, ahead = 0) {
  if (!video || rate === nudging) return
  nudging = rate
  if (rate !== 1) log('sync.nudge', { rate, ahead: Math.round(ahead * 10) / 10 }, 'debug')
  video.playbackRate = rate
}

function seek(ts: number) {
  if (!Number.isFinite(ts)) return
  if (state.kind === 'file' && video) video.currentTime = ts
  else if (state.kind === 'yt') yt?.seekTo(ts, true)
}
/** The browser refused play(): play muted if it lets us, and ask for the tap that lets sound through. */
function playBlocked(v: HTMLVideoElement, e: unknown) {
  const name = (e as { name?: string })?.name || ''
  if (name === 'AbortError') return
  log('play.blocked', { name, muted: v.muted }, 'warn')
  if (name !== 'NotAllowedError') return
  if (v.muted) { set({ unblock: 'play' }); return }
  v.muted = true
  remote(() => {
    v.play().then(() => { log('play.muted_fallback', undefined, 'warn'); set({ unblock: 'unmute' }) })
      .catch(() => { v.muted = state.playerMuted; set({ unblock: 'play' }) })
  })
}
export function unblock() {
  const k = state.unblock
  set({ unblock: '' })
  log('play.unblocked', { k })
  if (state.kind === 'file' && video) {
    const v = video
    if (k === 'play') remote(() => { v.play().catch((e: unknown) => playBlocked(v, e)) })
    applyPlayerVol()
  } else if (state.kind === 'yt' && yt) {
    const p = yt
    remote(() => p.playVideo())
  }
  forceSync()
}

export function togglePlay() {
  if (!state.kind) return
  intent = Date.now()
  if (isPlaying()) pause(); else play()
  window.setTimeout(tick, 60)
}
/** Seeks from our own controls. File seeks broadcast through 'seeked'; YouTube has no seek event, so announce those. */
export function userSeek(t: number) {
  if (!state.kind || !Number.isFinite(t)) return
  const d = duration()
  const to = Math.max(0, Number.isFinite(d) && d > 0 ? Math.min(t, d - 0.25) : t)
  intent = Date.now()
  if (state.kind === 'file' && video) video.currentTime = to
  else if (state.kind === 'yt' && yt) { try { yt.seekTo(to, true) } catch { /* */ } sock?.emit('CMD:seek', to) }
  window.setTimeout(tick, 60)
}
export const skip = (by: number) => userSeek((time() ?? 0) + by)
export function forceSync() { if (sock?.connected) sock.emit('CMD:askHost') }

export function setPlayerVol(v: number) {
  const vol = Math.max(0, Math.min(1, v))
  set({ playerVol: vol, playerMuted: vol > 0 ? false : state.playerMuted })
  applyPlayerVol()
}
export function togglePlayerMute() {
  if (!state.playerMuted && state.playerVol === 0) set({ playerVol: 1 })
  else set({ playerMuted: !state.playerMuted })
  applyPlayerVol()
}
function applyPlayerVol() {
  if (video) { video.volume = state.playerVol; video.muted = state.playerMuted }
  if (state.kind === 'yt' && yt) {
    try {
      yt.setVolume(Math.round(state.playerVol * 100))
      if (state.playerMuted || !state.playerVol) yt.mute(); else yt.unMute()
    } catch { /* not ready */ }
  }
}

function mount(url: string) {
  log('video.mount', { video: short(url), prev: short(state.video) })
  if (yt) { try { yt.destroy() } catch { /* */ } yt = null }
  if (hls) { try { hls.destroy() } catch { /* */ } hls = null }
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); video.volume = state.playerVol; video.muted = state.playerMuted }
  if (ytBox) ytBox.replaceChildren()
  ytState = -1
  nudging = 1
  burned = null
  set({ video: url, kind: '', ytFresh: false, playing: false, unblock: '', mediaError: '', subs: [], sub: null, ytCc: false })
  void loadSubs(url)
  titleVideoChanged()
  void movieTitle(url)
  if (!url) { lockScreen.release('watch'); return }
  const id = ytId(url)
  if (id) { set({ kind: 'yt', ytFresh: true }); mountYt(id); return }
  if (!video) return
  if (/\.m3u8/i.test(url)) { set({ kind: 'file' }); mountHls(url); return }
  if (isProxy(url) || /^https?:\/\//i.test(url)) {
    set({ kind: 'file' })
    video.src = url
    seekOnMeta()
    return
  }
  set({ mediaError: 'unsupported' })
}
function seekOnMeta() {
  if (!pendingTS || !video) return
  const t = pendingTS, v = video
  pendingTS = 0
  v.addEventListener('loadedmetadata', () => { v.currentTime = t }, { once: true })
}
function mountHls(url: string) {
  const v = video
  if (!v) return
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = url; seekOnMeta(); return }
  loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
    const H = window.Hls
    if (state.video !== url) return
    if (!H || !H.isSupported()) { v.src = url; return }
    const h = new H()
    hls = h
    h.on(H.Events.ERROR, (_ev, d) => {
      if (d && (d.fatal || d.details === 'bufferStalledError')) log('hls.error', { type: d.type, details: d.details, fatal: !!d.fatal }, d.fatal ? 'error' : 'warn')
      if (d?.fatal) set({ mediaError: 'failed' })
    })
    h.loadSource(url)
    h.attachMedia(v)
    if (pendingTS) { const t = pendingTS; pendingTS = 0; h.once(H.Events.MANIFEST_PARSED, () => { v.currentTime = t }) }
  }).catch(() => { v.src = url })
}
function mountYt(id: string) {
  const box = ytBox
  if (!box) return
  // YT.Player replaces its target, so give it a throwaway child.
  const target = document.createElement('div')
  target.style.width = '100%'
  target.style.height = '100%'
  box.replaceChildren(target)
  const build = () => {
    const Y = window.YT
    if (!Y || !target.isConnected) return
    yt = new Y.Player(target, {
      videoId: id, width: '100%', height: '100%',
      // Our overlay drives the player, so YouTube's own controls, keys and fullscreen are off.
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, origin: location.origin },
      events: {
        onReady: () => { if (pendingTS && yt) { yt.seekTo(pendingTS, true); pendingTS = 0 } applyPlayerVol() },
        onError: (e: { data?: number }) => { log('yt.error', { code: e?.data }, 'error'); set({ mediaError: 'failed' }) },
        onStateChange: (e: { data: number }) => {
          ytState = e.data
          set({ ytFresh: e.data === -1 || e.data === 5, ...(e.data === 1 ? { unblock: '' as Unblock } : {}) })
          syncPlaying()
          if (!echo()) return
          if (e.data === Y.PlayerState.PLAYING) sock?.emit('CMD:play')
          if (e.data === Y.PlayerState.PAUSED) sock?.emit('CMD:pause')
        },
      },
    })
  }
  if (window.YT?.Player) { build(); return }
  if (!ytLoading) {
    ytLoading = new Promise<void>((res) => {
      window.onYouTubeIframeAPIReady = () => res()
      loadScript('https://www.youtube.com/iframe_api').catch(() => res())
    })
  }
  void ytLoading.then(build)
}

// ── Host state from the room ────────────────────────────────────────────────
let awaitHost = false
let roomVideo = ''
let lastHost: { url: string; t: number | null; paused: boolean; at: number } | null = null
let recoverT = 0
function applyHost(h: { video?: string; videoTS?: number; paused?: boolean }) {
  const url = h.video || ''
  const first = awaitHost
  awaitHost = false
  roomVideo = url
  // Right after a reconnect the room came back empty although we were watching:
  // the realtime server restarted. Keep playing and put it back.
  if (!url && first && recoverHost()) return
  if (url) { window.clearTimeout(recoverT); recoverT = 0 }
  if (url !== state.video) mount(url)
  if (!url) return
  const ts = Number(h.videoTS) || 0
  const cur = time()
  if (cur !== null && Math.abs(cur - ts) > 2) remote(() => seek(ts))
  else if (cur === null) pendingTS = ts
  remote(() => (h.paused ? pause() : play()))
}
/** Every viewer tries after a random delay; whoever goes first wins and the rest see the video arrive. */
function recoverHost(): boolean {
  const L = lastHost
  if (!L?.url || Date.now() - L.at > 180_000) return false
  lastHost = null
  const delay = 400 + Math.random() * 1600
  log('recover.pending', { video: short(L.url), t: L.t, paused: L.paused, delay: Math.round(delay) }, 'warn')
  window.clearTimeout(recoverT)
  recoverT = window.setTimeout(() => {
    recoverT = 0
    if (roomVideo || !sock?.connected) return
    sock.emit('CMD:host', L.url)
    toast(`↻ Watch Party reconnected — putting the video back${L.t ? ` at ${fmtTime(L.t)}` : ''}`)
    const t0 = Date.now()
    const iv = window.setInterval(() => {
      if (Date.now() - t0 > 30_000) { window.clearInterval(iv); return }
      if (state.video !== L.url || applying || !(duration() > 0)) return
      window.clearInterval(iv)
      if (L.t && L.t > 3) { userSeek(L.t); sock?.emit('CMD:seek', L.t) }
      if (L.paused) { pause(); sock?.emit('CMD:pause') }
    }, 500)
  }, delay)
  return true
}

// ── Socket ──────────────────────────────────────────────────────────────────
let sock: Sock | null = null
let tries = 0
let retryT = 0
let watchdog = 0
let tsTimer = 0
let kicked = false

export function start() {
  if (state.active) return
  kicked = false
  set({ active: true })
  void boot()
}
export async function boot() {
  set({ status: 'connecting', error: '' })
  let cfg: WatchConfig
  try {
    cfg = await getConfig()
  } catch (e) {
    set({ status: e instanceof ApiError && e.status === 401 ? 'signin' : 'unavailable' })
    return
  }
  if (!state.active) return
  set({ cfg, room: cfg.defaultRoom || 'crcmz', myName: cfg.viewer?.name || '', isMod: !!cfg.viewer?.mod })
  try {
    await loadScript(`${cfg.origin || ''}${cfg.socketPath || '/socket.io'}/socket.io.js`)
  } catch {
    log('sock.script_failed', undefined, 'error')
    set({ status: 'unavailable' })
    return
  }
  tries = 0
  void connect()
}
function dropSock() {
  window.clearTimeout(watchdog)
  window.clearInterval(tsTimer)
  tsTimer = 0
  if (sock) { sock.removeAllListeners(); try { sock.disconnect() } catch { /* */ } sock = null }
}
function retry(code = '') {
  dropSock()
  if (!state.active || kicked) return
  tries++
  if (tries > MAX_TRIES) {
    log('sock.give_up', { code }, 'error')
    set({ status: 'failed' })
    return
  }
  set({ status: 'reconnecting' })
  window.clearTimeout(retryT)
  retryT = window.setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** tries))
}
async function connect() {
  dropSock()
  window.clearTimeout(retryT)
  const cfg = state.cfg
  const io = window.io
  if (!cfg || !io || !state.active) return
  if (state.status !== 'reconnecting') set({ status: 'connecting' })
  let ticket: string
  try {
    const t = await joinRoom(state.room)
    ticket = t.ticket
    set({ myName: t.viewer?.name || state.myName, isMod: !!t.viewer?.mod })
  } catch (e) {
    if (e instanceof ApiError) {
      log('join.error', { status: e.status, detail: e.detail }, 'warn')
      if (e.status === 401) { endCall(); set({ status: 'signin' }); return }
      if (e.status === 403) { set({ status: 'forbidden', error: e.detail }); return }
      if (e.status === 503) { set({ status: 'unavailable' }); return }
      if (e.status === 429) {
        set({ status: 'reconnecting' })
        retryT = window.setTimeout(() => void connect(), Math.max(1, e.retryAfter ?? 30) * 1000)
        return
      }
      if (e.status < 500) { set({ status: 'failed', error: e.detail || "Couldn't join the party." }); return }
    }
    retry('join')
    return
  }
  if (!state.active) return
  const s = io(`${cfg.origin || ''}/${state.room}`, {
    transports: ['websocket'], path: cfg.socketPath || '/socket.io',
    auth: { watchTicket: ticket, sessionId: sessionId() },
    query: { clientId: state.clientId, roomId: state.room, password: '', shard: '' },
    reconnection: false, withCredentials: true,
  })
  sock = s
  const emit0 = s.emit.bind(s)
  s.emit = (ev: string, ...a: unknown[]) => {
    if (ev === 'CMD:host') log('cmd.host', { video: short(String(a[0] ?? '')), prev: short(state.video) })
    else if (ev === 'CMD:play' || ev === 'CMD:pause') log(`cmd.${ev.slice(4)}`, { t: time() })
    else if (ev === 'CMD:seek') log('cmd.seek', { to: Number(a[0]) || 0, t: time() })
    else if (ev === 'CMD:kickUser') log('cmd.kick', a[0])
    emit0(ev, ...a)
  }
  // Neither connect nor an error after 15 s: try again.
  watchdog = window.setTimeout(() => { if (!s.connected) { log('sock.watchdog', undefined, 'warn'); retry('watchdog') } }, 15_000)
  bind(s)
}

function bind(s: Sock) {
  s.on('connect', () => {
    window.clearTimeout(watchdog)
    log('sock.connect', { sid: s.id, tries, away: lastHost ? Math.round((Date.now() - lastHost.at) / 1000) : null })
    tries = 0
    awaitHost = true
    set({ status: 'live', error: '' })
    void connectRoom()   // listen to the party's call (cameras of whoever's in it)
    s.emit('watch:presence:get')
    s.emit('CMD:askHost')
    // After askHost, so the room's current video can't arrive after the one picked.
    if (pendingHost) { s.emit('CMD:host', pendingHost); pendingHost = null }
    set({ histTick: state.histTick + 1 })
    window.clearInterval(tsTimer)
    tsTimer = window.setInterval(() => { if (!s.connected) return; const t = time(); if (t !== null) s.emit('CMD:ts', t) }, 1000)
  })
  s.on('connect_error', (err: { message?: string }) => {
    window.clearTimeout(watchdog)
    const code = String(err?.message || '')
    log('sock.connect_error', { code }, 'warn')
    if (code === 'AUTH_REQUIRED' || code === 'INVALID_WATCH_TICKET' || code === 'WRONG_ROOM') set({ error: 'Watch pass rejected — refreshing your sign-in.' })
    retry(code)
  })
  s.on('disconnect', (reason: string) => {
    window.clearTimeout(watchdog)
    // Remember what was on, in case the server restarted and forgot the room.
    lastHost = state.video ? { url: state.video, t: time(), paused: !isPlaying(), at: Date.now() } : null
    log('sock.disconnect', { reason: String(reason || ''), ...snap() }, 'warn')
    // The call is its own LiveKit room, so it carries on; the roster comes back on reconnect.
    set({ roster: [] })
    if (kicked) { dropSock(); return }
    retry('')
  })
  s.on('errorMessage', (m: string) => { log('sock.error_message', { msg: String(m || '') }, 'warn'); set({ error: String(m || '') }) })
  s.on('kicked', (d: { by?: string }) => {
    log('kicked', d, 'warn')
    kicked = true
    endCall()
    set({ status: 'kicked' })
  })
  s.on('watch:presence', (d: Presence) => set({ presence: { count: Number(d?.count) || 0, viewers: Array.isArray(d?.viewers) ? d.viewers : [] } }))
  // nameMap only supplies names; it is never pruned. `roster` is the live list.
  s.on('REC:nameMap', (m: Record<string, string>) => set({ names: m || {} }))
  s.on('roster', (arr: RosterEntry[]) => { set({ roster: Array.isArray(arr) ? arr : [] }); reconcilePeers() })
  s.on('signal', (d: { from?: string; msg?: { t?: string; e?: string } }) => onSignal(d?.from, d?.msg))
  s.on('REC:host', (h: { video?: string; videoTS?: number; paused?: boolean }) => {
    h = h || {}
    log('rec.host', { video: short(h.video || ''), prev: short(state.video), ts: Number(h.videoTS) || 0, paused: !!h.paused, first: awaitHost }, !h.video && state.video ? 'warn' : 'info')
    applyHost(h)
  })
  s.on('REC:play', (url: string) => { log('rec.play', { t: time() }); if (url && url !== state.video) mount(url); remote(play) })
  s.on('REC:pause', () => { log('rec.pause', { t: time() }); remote(pause) })
  s.on('REC:seek', (ts: number) => { log('rec.seek', { to: Number(ts), t: time() }); remote(() => seek(Number(ts))) })
  s.on('REC:playbackRate', (r: number) => { if (video && Number(r)) { video.playbackRate = Number(r); nudging = Number(r) } })
  // Stay in step with the room. The map is everyone's last reported time (each client
  // reports every second, the server sends the map every second), so compare OUR entry in
  // it with the others' median: like with like. Comparing our live time with their
  // seconds-old reports made everyone look 3-4 s off, and the seeks it caused restarted
  // the movie's transcode and stalled everyone (the "out of sync" feeling).
  // Small drift: play 4% faster or slower until back in step (no seek, nothing reloads).
  // Big drift (> 8 s, a rejoin or a long stall): seek.
  s.on('REC:tsMap', (map: Record<string, number>) => {
    if (!map || applying) return
    const cur = time()
    if (cur === null) return
    const others = Object.entries(map).filter(([id]) => id !== state.clientId).map(([, t]) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
    if (!others.length) { nudge(1); return }
    const med = others[Math.floor(others.length / 2)]!
    const mine = Number(map[state.clientId])
    const behind = med - (Number.isFinite(mine) && mine >= 0 ? mine : cur)
    // Only whoever is behind moves: someone joining (at 0:00) or coming back never pulls
    // the room back to them; they catch up to it.
    const bigJump = state.kind === 'file' ? 8 : 3   // YouTube can't be nudged smoothly
    if (behind > bigJump) {
      nudge(1)
      log('sync.drift', { t: Math.round(cur * 10) / 10, median: Math.round(med * 10) / 10, behind: Math.round(behind * 10) / 10, n: others.length })
      remote(() => seek(cur + behind))
    } else if (state.kind === 'file' && isPlaying() && behind > 1) {
      nudge(1.04, -behind)
    } else if (behind < 0.4) {
      nudge(1)
    }
  })
  s.on('chatinit', (arr: ChatMsg[]) => set({ chat: Array.isArray(arr) ? arr.slice(-60) : [] }))
  s.on('REC:chat', (m: ChatMsg) => {
    set({ chat: [...state.chat, m].slice(-60) })
    chatListeners.forEach((l) => l(m))
  })
}

/** Leave the party entirely: hang up, stop the video, close the socket. */
export function leave() {
  log('leave', snap())
  flushLog()
  postHistory()
  endCall()
  set({ active: false })
  disconnectRoom()
  window.clearTimeout(retryT)
  window.clearTimeout(recoverT)
  dropSock()
  mount('')
  lockScreen.release('watch')
  exitFs()
  set({ status: 'idle', roster: [], presence: { count: 0, viewers: [] }, chat: [], error: '' })
}
export function rejoin() {
  kicked = false
  tries = 0
  if (!state.active) { start(); return }
  if (!state.cfg) { void boot(); return }
  void connect()
}

// ── Setting the video ───────────────────────────────────────────────────────
const srcOf: Record<string, string> = {}
const titleOf: Record<string, string> = {}
let typedFor: string | null = null
let typedAt = 0

export function setTitle(t: string) { typedFor = state.video; typedAt = Date.now(); set({ title: t }) }
// Typing a title and then loading the video is the usual order, so a title typed
// shortly before a change goes with the new video; an old one is cleared.
function titleVideoChanged() {
  if (!state.title.trim()) return
  if (Date.now() - typedAt < 180_000) typedFor = state.video
  else if (typedFor !== state.video) { typedFor = null; set({ title: '' }) }
}

export async function setVideo(raw: string): Promise<boolean> {
  const url = raw.trim()
  if (!sock?.connected) { set({ error: 'Connecting to the party…' }); return false }
  if (!url) return false
  if (!/^https?:\/\//i.test(url)) { set({ error: 'Only http(s) links work here.' }); return false }
  if (ytId(url) || isDirect(url)) { set({ error: '' }); srcOf[url] = url; sock.emit('CMD:host', url); return true }
  set({ extracting: true, error: '' })
  try {
    const d = await extract(url)
    srcOf[d.url] = url
    if (d.title) titleOf[d.url] = d.title
    sock?.emit('CMD:host', d.url)
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) set({ extractUntil: Date.now() + (e.retryAfter ?? 30) * 1000, error: '' })
    else if (e instanceof ApiError && e.status === 422) set({ error: "Couldn't find a video at that link." })
    else set({ error: (e instanceof ApiError && e.detail) || "Couldn't find a video at that link." })
    return false
  } finally {
    set({ extracting: false })
  }
}
/** Play a film from the library for the whole room. */
export function hostMovie(url: string, title: string): boolean {
  if (!sock?.connected) { set({ error: 'Connecting to the party…' }); return false }
  srcOf[url] = url
  titleOf[url] = title
  set({ error: '' })
  sock.emit('CMD:host', url)
  return true
}
/** "Watch together" from the Movies home: play it for the party now, or as soon as
 *  the party page has connected. */
let pendingHost: string | null = null
export function watchTogether(url: string, title: string, resumeAt = 0) {
  srcOf[url] = url
  titleOf[url] = title
  // Continue watching: seek once the video knows its length (the same path as history's Resume).
  resume = resumeAt > 5 ? { t: resumeAt, url, prev: state.video, at: Date.now() } : null
  if (sock?.connected) {
    set({ error: '' })
    if (state.video === url) { if (resumeAt > 5) userSeek(resumeAt); return }
    sock.emit('CMD:host', url)
    return
  }
  pendingHost = url
}
export function clearVideo() { set({ error: '' }); sock?.emit('CMD:host', '') }

export function sendChat(msg: string): boolean {
  const m = msg.trim()
  if (!m || !sock?.connected) return false
  sock.emit('CMD:chatV2', { msg: m })
  return true
}

export async function changeName(nickname: string) {
  const d = await setNickname(nickname)
  if (state.cfg) set({ cfg: { ...state.cfg, viewer: { ...state.cfg.viewer, nickname: d.nickname, name: d.name } } })
  set({ myName: d.name })
  // The name lives in the ticket, so reconnect to publish it.
  tries = 0
  void connect()
  return d.name
}

// ── Subtitles (each viewer's own choice) ────────────────────────────────────
// A library film's text subtitles play as a WebVTT <track> (instant). Image ones (Blu-ray
// PGS) are drawn into this viewer's own transcode: the stream reloads at the same time,
// for them only. YouTube has its own captions.
let burned: number | null = null
async function loadSubs(url: string) {
  const id = MOVIE_STREAM.exec(url)?.[1]
  if (!id) return
  try {
    const subs = await request<SubTrack[]>(`/api/watch/movies/subs/${id}`, { quiet401: true })
    if (state.video === url) set({ subs })
  } catch { /* none, or not allowed: no CC menu */ }
}

export function setSubtitle(index: number | null) {
  if (state.kind === 'yt') {
    try {
      if (index === null) { yt?.unloadModule?.('captions'); set({ ytCc: false }) }
      else { yt?.loadModule?.('captions'); yt?.setOption?.('captions', 'track', { languageCode: 'en' }); set({ ytCc: true }) }
    } catch { /* captions aren't available for this video */ }
    return
  }
  const v = video
  const id = MOVIE_STREAM.exec(state.video)?.[1]
  if (!v || !id) return
  const pick = index === null ? null : state.subs.find((x) => x.index === index) ?? null
  v.querySelectorAll('track').forEach((t) => t.remove())
  const wantBurn = pick && !pick.text ? pick.index : null
  if (wantBurn !== burned) reloadStream(wantBurn)
  if (pick?.text) {
    const t = document.createElement('track')
    t.kind = 'subtitles'
    t.label = pick.label
    t.srclang = pick.lang.slice(0, 2) || 'en'
    t.src = `/api/watch/movies/subs/${id}/${pick.index}.vtt`
    t.default = true
    v.appendChild(t)
    const show = () => { for (const tt of Array.from(v.textTracks)) tt.mode = tt.label === pick.label ? 'showing' : 'disabled' }
    t.addEventListener('load', show)
    show()
  }
  log('sub.pick', { index, text: pick?.text ?? null })
  set({ sub: pick ? pick.index : null })
}

/** Load this viewer's stream again (with burned-in subtitles, or without), at the same time. */
function reloadStream(burn: number | null) {
  const v = video
  if (!v) return
  burned = burn
  const at = v.currentTime
  const wasPlaying = !v.paused
  const src = burn === null ? state.video : `${state.video}?burn=${burn}`
  const resume = () => { v.currentTime = at; if (wasPlaying) void v.play().catch(() => {}) }
  if (hls) {
    hls.once(window.Hls!.Events.MANIFEST_PARSED, resume)
    hls.loadSource(src)
  } else {
    v.addEventListener('loadedmetadata', resume, { once: true })
    v.src = src
  }
}

/** A film from the library plays as /api/watch/movies/stream/<id>/master.m3u8: only whoever
 *  picked it knows its name. Everyone else (and after a reload) looks it up in the library,
 *  so the player says the film's name, not "master". */
const MOVIE_STREAM = /\/api\/watch\/movies\/stream\/([0-9a-f]{32})\//i
const titleAsked = new Set<string>()
async function movieTitle(url: string) {
  const id = MOVIE_STREAM.exec(url)?.[1]
  if (!id || titleOf[url] || titleAsked.has(url)) return
  titleAsked.add(url)
  try {
    const lib = await request<{ movies: { id: string; title: string }[] }>('/api/watch/movies/library', { quiet401: true })
    const m = lib.movies.find((x) => x.id === id)
    if (m?.title) { titleOf[url] = m.title; if (state.video === url) set({}) }
  } catch { titleAsked.delete(url) /* the review account, or offline: try again later */ }
}

export function videoLabel(typedOnly = false): string {
  let label = state.title.trim() || titleOf[state.video] || ''
  // A library film whose title hasn't arrived yet: no filename ("master") meanwhile.
  if (!label && MOVIE_STREAM.test(state.video)) { void movieTitle(state.video); return typedOnly ? '' : 'Movie' }
  if (!label && state.video && ytId(state.video)) { try { label = yt?.getVideoData?.().title || '' } catch { /* */ } }
  if (!label && state.video && !typedOnly) {
    try {
      const u = new URL(state.video, location.origin)
      const rawPath = u.searchParams.get('url') || u.pathname
      label = decodeURIComponent(rawPath.split('/').pop()?.split('?')[0] ?? '').replace(/\.[a-z0-9]+$/i, '')
    } catch { /* */ }
  }
  return label
}
export async function rally() {
  const names = state.presence.viewers.map((v) => v.name).filter(Boolean)
  const label = videoLabel()
  const msg = `@all ${names.length ? names.join(', ') : 'We'} are on CRCMZ app ${label ? `watching ${label}` : 'in the watch party'}. Join now fuckers! ${location.origin}/app/watch/party`
  return postRally(msg)
}

export function kick(id: string, name: string) {
  if (!sock?.connected) return
  sock.emit('CMD:kickUser', { userToBeKicked: id })
  toast(`Removed ${name}`)
}

// ── History pings ───────────────────────────────────────────────────────────
let lastPost = 0
let posted = false
let wasPlaying = false
let histUrl = ''
let histLoadT = 0
const typedTitle = () => (state.title.trim() && typedFor === state.video ? state.title.trim() : '')
function sourceTitle(): string {
  if (state.video && ytId(state.video)) { try { const t = yt?.getVideoData?.().title; if (t) return t } catch { /* */ } }
  return titleOf[state.video] || ''
}
function postHistory() {
  if (!state.video || !state.kind) return
  const t = time()
  if (t === null || !Number.isFinite(t) || t < 5) return
  const d = duration()
  lastPost = Date.now()
  const first = !posted
  posted = true
  void beacon('/api/watch/history', {
    url: state.video, position: t, duration: Number.isFinite(d) && d > 0 ? d : null, room: state.room,
    title: typedTitle(), extracted_title: sourceTitle(), source: srcOf[state.video] || '',
  }).then((r) => {
    // The first ping for a video starts a metadata lookup; show it shortly.
    if (r?.ok && first) { window.clearTimeout(histLoadT); histLoadT = window.setTimeout(() => set({ histTick: state.histTick + 1 }), 6000) }
  })
}
function histCheck() {
  if (state.video !== histUrl) { histUrl = state.video; posted = false; wasPlaying = false }
  if (!state.video || !state.kind) return
  const p = isPlaying()
  if (p && Date.now() - lastPost >= 15_000) postHistory()
  else if (!p && wasPlaying) postHistory()
  wasPlaying = p
}

/** Resume a history item: seeks once the new video knows its length. */
let resume: { t: number; url: string; prev: string; at: number } | null = null
export function resumeItem(it: { url: string; source_url: string | null; position: number; finished: boolean; title: string; named_by: string | null; mine: { position: number; finished: boolean } | null }) {
  if (!sock?.connected) { set({ error: 'Connecting to the party…' }); return }
  const done = it.mine ? it.mine.finished : it.finished
  const t = done ? 0 : Math.max(0, (it.mine ? it.mine.position : it.position) - 3)
  if (it.title && it.named_by === 'viewer') { set({ title: it.title }); typedAt = Date.now() }
  if (state.video === it.url) { if (t > 0) userSeek(t); return }
  // Extracted stream URLs expire; re-resolve from the page they came from.
  const viaSrc = !!(it.source_url && it.source_url !== it.url && !isProxy(it.url))
  resume = t > 5 ? { t, url: viaSrc ? '' : it.url, prev: state.video, at: Date.now() } : null
  if (viaSrc) void setVideo(it.source_url!)
  else sock.emit('CMD:host', it.url)
}
function applyResume() {
  const r = resume
  if (!r) return
  if (Date.now() - r.at > 90_000) { resume = null; return }
  if (!state.kind || !state.video || applying) return
  if (r.url ? state.video !== r.url : state.video === r.prev) return
  if (!(duration() > 0)) return
  resume = null
  userSeek(r.t)
  toast(`▶ Resumed at ${fmtTime(r.t)}`)
}

// ── The 250 ms tick: clock, resume, history ─────────────────────────────────
let histN = 0
function tick() {
  if (!state.active) return
  const t = time() ?? 0, dur = duration(), live = state.kind === 'file' && dur === Infinity
  const buf = buffered()
  if (Math.abs(t - clock.t) >= 0.2 || dur !== clock.dur && !(Number.isNaN(dur) && Number.isNaN(clock.dur)) || Math.abs(buf - clock.buf) > 0.5 || live !== clock.live) {
    clock = { t, dur, buf, live }
    clockListeners.forEach((l) => l())
  }
  syncPlaying()
  syncLockScreen()
  applyResume()
  if (++histN % 12 === 0) histCheck()
}
window.setInterval(tick, 250)
window.setInterval(() => { if (state.active) flushLog() }, 10_000)
window.setInterval(() => { if (state.active) log('heartbeat', snap(), 'debug') }, 30_000)
window.addEventListener('pagehide', () => { if (!state.active) return; if (wasPlaying) postHistory(); log('pagehide', snap()); flushLog(); if (state.call.on) camStop() })
document.addEventListener('visibilitychange', () => {
  if (!state.active) return
  log('visibility', { v: document.visibilityState }, 'debug')
  if (document.visibilityState === 'hidden') { if (wasPlaying) postHistory(); flushLog() }
})
window.addEventListener('online', () => { if (state.active) log('net.online') })
window.addEventListener('offline', () => { if (state.active) log('net.offline', undefined, 'warn') })
window.addEventListener('error', (e) => { if (state.active) logError(String(e.message || 'error')) })

// ── Fullscreen: the whole layout (stage + cams), CSS fallback when refused ───
export function toggleFs() {
  if (document.fullscreenElement || state.fs) { exitFs(); return }
  set({ fs: true })
  const el = layout
  if (el?.requestFullscreen) el.requestFullscreen().catch(() => { /* the CSS fallback stays */ })
}
export function exitFs() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* */ })
  if (state.fs) set({ fs: false })
}
document.addEventListener('fullscreenchange', () => {
  const fe = document.fullscreenElement
  if (!fe) { if (state.fs) set({ fs: false }); return }
  if (layout && fe === layout) { if (!state.fs) set({ fs: true }); return }
  // The player itself went fullscreen: hand it to the layout so the cams stay in view.
  if (layout?.contains(fe)) layout.requestFullscreen?.().catch(() => { /* */ })
})

// ── Reactions ───────────────────────────────────────────────────────────────
let rxSent: number[] = []
const rxSeen: Record<string, number[]> = {}
const rxBurstAt: Record<string, number> = {}
export function react(e: string) {
  if (!(REACTIONS as readonly string[]).includes(e)) return
  const now = Date.now()
  rxSent = rxSent.filter((t) => now - t < 3000)
  if (rxSent.length >= 8) return // spam guard: 8 per 3 s
  rxSent.push(now)
  live().forEach((id) => signal(id, { t: 'rx', e }))
  showRx(e, 'You')
}
function showRx(e: string, name: string) {
  if (!(REACTIONS as readonly string[]).includes(e)) return
  const now = Date.now()
  const list = (rxSeen[e] || []).filter((t) => now - t < RX_WINDOW)
  list.push(now)
  rxSeen[e] = list
  let burst = 0
  if (list.length >= RX_NEED && now - (rxBurstAt[e] || 0) > 2500) {
    rxBurstAt[e] = now
    rxSeen[e] = [] // the next party needs three more
    burst = list.length
  }
  rxListeners.forEach((l) => l({ e, name, burst }))
}

// ── The call: a LiveKit room per party room (watch-<room>) ──────────────────
// The party itself (the video, chat, reactions) stays on the Watch Party socket. The
// cameras and mics are a LiveKit room, like Huddle: everyone in the party is connected
// to it listening, so you see and hear whoever's in the call without joining; joining
// publishes your camera. Each participant carries its party socket id as the "client"
// attribute, which is how a camera lands on the right viewer (and kick still works).
// The iOS app runs this same room natively (ios/), with picture in picture.
type Signal = { t: 'rx'; e: string }
type LkTrack = {
  kind: 'audio' | 'video'; source: string; isMuted: boolean; mediaStreamTrack: MediaStreamTrack
  restartTrack?(o?: MediaTrackConstraints): Promise<unknown>
  replaceTrack?(t: MediaStreamTrack, userProvided?: boolean): Promise<unknown>
}
type LkPub = { kind: 'audio' | 'video'; source: string; trackSid: string; isMuted: boolean; track?: LkTrack }
type LkParticipant = {
  identity: string; name?: string; isSpeaking: boolean; attributes?: Record<string, string>
  trackPublications: Map<string, LkPub>
  getTrackPublication(source: string): LkPub | undefined
}
type LkLocal = LkParticipant & {
  setMicrophoneEnabled(on: boolean, opts?: MediaTrackConstraints): Promise<unknown>
  setCameraEnabled(on: boolean, opts?: MediaTrackConstraints): Promise<unknown>
  unpublishTrack(t: LkTrack, stop?: boolean): Promise<unknown>
}
type LkRoom = {
  localParticipant: LkLocal
  remoteParticipants: Map<string, LkParticipant>
  on(ev: string, fn: (...a: never[]) => void): LkRoom
  connect(url: string, token: string): Promise<void>
  disconnect(): Promise<void>
}
type LkNs = { Room: new (o: Record<string, unknown>) => LkRoom; RoomEvent: Record<string, string> }
const LK_SRC = 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js'
const SRC = { cam: 'camera', mic: 'microphone' } as const
type Peer = { p: LkParticipant; stream: MediaStream | null; key: string }

let lkRoom: LkRoom | null = null
let lkConnecting: Promise<LkRoom | null> | null = null
let localStream: MediaStream | null = null
const peers: Record<string, Peer> = {}     // by party socket id

const live = () => state.roster.map((u) => u?.id).filter((id): id is string => !!id && id !== state.clientId)
export const nameOf = (id: string) => state.names[id] || 'Viewer'
function signal(to: string, msg: Signal) { if (sock?.connected) sock.emit('signal', { to, msg }) }
export const localMedia = () => localStream
export const canCall = () => typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.RTCPeerConnection === 'function'
const clientOf = (p: LkParticipant) => p.attributes?.client || p.identity.split('#')[1] || p.identity

function audioC() {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(state.micId ? { deviceId: { exact: state.micId } } : {}) }
}
async function enumerate() {
  if (!navigator.mediaDevices?.enumerateDevices) return
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    set({
      mics: devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Mic ${i + 1}` })),
      speakers: devs.filter((d) => d.kind === 'audiooutput').map((d, i) => ({ id: d.deviceId, label: d.label || `Speaker ${i + 1}` })),
    })
  } catch { /* */ }
}

async function loadLk(): Promise<LkNs | null> {
  const w = window as unknown as { LivekitClient?: LkNs }
  if (!w.LivekitClient) await loadScript(LK_SRC).catch(() => { /* offline */ })
  return w.LivekitClient ?? null
}

// The party's camera call runs here, in the page, in the phone apps too: the cameras sit
// over the video or beside it where your settings put them (Orbs), which a native call
// panel can't do. (Huddle is native in the apps; the Watch Party is not.)
/** The party's call room, connected listening (once per party visit). */
function connectRoom(): Promise<LkRoom | null> {
  if (lkRoom) return Promise.resolve(lkRoom)
  if (lkConnecting) return lkConnecting
  lkConnecting = (async () => {
    try {
      const ns = await loadLk()
      if (!ns || !state.active) return null
      const t = await request<{ token: string; url: string; room: string }>('/api/watch/call/token', {
        body: { room: state.room || 'crcmz', client: state.clientId }, quiet401: true })
      const r = new ns.Room({
        adaptiveStream: false, dynacast: true, stopLocalTrackOnUnpublish: true,
        videoCaptureDefaults: { resolution: { width: 320, height: 320, frameRate: 15 } },
        publishDefaults: { simulcast: false, videoEncoding: { maxBitrate: CAM_BITRATE, maxFramerate: 20 } },
      })
      wire(r, ns)
      await r.connect(t.url, t.token)
      if (!state.active) { void r.disconnect(); return null }
      lkRoom = r
      log('call.room', { room: t.room })
      syncPeers()
      return r
    } catch (e) {
      log('call.room_failed', { msg: String((e as Error)?.message || e).slice(0, 160) }, 'warn')
      return null
    } finally {
      lkConnecting = null
    }
  })()
  return lkConnecting
}
function disconnectRoom() {
  const r = lkRoom
  lkRoom = null
  Object.keys(peers).forEach((id) => { stopAudio(id); delete peers[id] })
  if (state.loud && Object.keys(state.loud).length) set({ loud: {} })
  if (r) void r.disconnect().catch(() => { /* */ })
  bumpRtc()
}

function wire(r: LkRoom, ns: LkNs) {
  const E = ns.RoomEvent
  const on = (ev: string | undefined, fn: (...a: never[]) => void) => { if (ev) r.on(ev, fn) }
  for (const ev of [E.TrackSubscribed, E.TrackUnsubscribed, E.TrackMuted, E.TrackUnmuted, E.TrackPublished, E.TrackUnpublished,
    E.ParticipantConnected, E.ParticipantDisconnected, E.LocalTrackPublished, E.LocalTrackUnpublished, E.ParticipantAttributesChanged]) {
    on(ev, () => syncPeers())
  }
  on(E.ActiveSpeakersChanged, ((speakers: LkParticipant[]) => {
    const loud: Record<string, boolean> = {}
    for (const sp of speakers) loud[sp === r.localParticipant ? 'me' : clientOf(sp)] = true
    set({ loud })
  }) as never)
  on(E.Reconnecting, () => log('call.reconnecting', undefined, 'warn'))
  on(E.Reconnected, () => { log('call.reconnected'); syncPeers() })
  on(E.Disconnected, () => {
    if (lkRoom !== r) return
    lkRoom = null
    if (state.call.on) camStop()
    Object.keys(peers).forEach((id) => { stopAudio(id); delete peers[id] })
    bumpRtc()
    // Still in the party: listen again shortly (the server restarted, the network blipped).
    if (state.active) window.setTimeout(() => { if (state.active && !lkRoom) void connectRoom() }, 3000)
  })
}

/** Rebuild who's in the call from the room: a MediaStream per person (camera + mic). */
function syncPeers() {
  const r = lkRoom
  const seen = new Set<string>()
  if (r) {
    for (const p of r.remoteParticipants.values()) {
      const id = clientOf(p)
      seen.add(id)
      const tracks = [p.getTrackPublication(SRC.cam), p.getTrackPublication(SRC.mic)]
        .map((pub) => pub?.track?.mediaStreamTrack).filter((t): t is MediaStreamTrack => !!t && t.readyState === 'live')
      const key = tracks.map((t) => t.id).join(',')
      const have = peers[id]
      // A new MediaStream when the tracks change, so <video>/<audio> pick it up cleanly.
      const stream = have && have.key === key ? have.stream : (tracks.length ? new MediaStream(tracks) : null)
      peers[id] = { p, stream, key }
      if (stream?.getAudioTracks().length) playAudio(id, stream)
      else stopAudio(id)
    }
  }
  Object.keys(peers).forEach((id) => { if (!seen.has(id)) { stopAudio(id); delete peers[id] } })
  const cam = r?.localParticipant.getTrackPublication(SRC.cam)?.track?.mediaStreamTrack
  localStream = state.call.on ? (cam && cam.readyState === 'live' ? streamOf(cam) : localStream && !cam ? localStream : null) : null
  bumpRtc()
}

export async function joinCall() {
  if (state.call.busy || state.call.on) return
  if (!canCall()) { setCall({ note: "This browser can't share a camera." }); return }
  setCall({ busy: true, note: 'Asking for permission…', micOnly: false })
  try {
    const r = await connectRoom()
    if (!r) { setCall({ note: "Couldn't reach the call. Try again in a moment." }); return }
    let micOnly = false
    try {
      // Camera only. A capturing mic (even a muted one) flips the OS into voice-call
      // audio: Bluetooth drops to the headset profile and the movie sounds worse. The mic
      // is opened only while you're unmuted.
      await r.localParticipant.setCameraEnabled(true, { facingMode: 'user' })
    } catch (e) {
      const n = (e as { name?: string })?.name || ''
      log('cam.error', { name: n, msg: String((e as Error)?.message || '').slice(0, 160) }, 'warn')
      if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') micOnly = true
      else {
        setCall({ note: n === 'NotAllowedError' ? 'Camera/mic blocked — allow it in your browser settings.' : n === 'NotReadableError' ? 'Camera is in use by another app.' : 'Could not start the camera.' })
        return
      }
    }
    void enumerate()
    // You join muted, with no mic open at all; Unmute is one tap away.
    setCall({ on: true, muted: true, camOff: false, micOnly, facing: 'user', note: micOnly ? 'No camera found — tap Unmute to talk.' : '' })
    syncPeers()
    log('cam.on', { micOnly })
  } finally {
    setCall({ busy: false })
  }
}
function camStop() {
  log('cam.off')
  stopPip('watch')
  micGen++
  const lp = lkRoom?.localParticipant
  setCall({ on: false, muted: true, camOff: false, micOnly: false })
  if (lp) {
    for (const src of [SRC.cam, SRC.mic]) {
      const t = lp.getTrackPublication(src)?.track
      if (t) void lp.unpublishTrack(t, true).catch(() => { /* */ })
    }
  }
  localStream?.getTracks().forEach((t) => t.stop())
  localStream = null
  bumpRtc()
}
export const leaveCall = () => { if (state.call.on) camStop() }
function endCall() { if (state.call.on) camStop() }

let micGen = 0
/** Open the mic and send it. Returns false if the mic couldn't be opened. */
async function micOpen(): Promise<boolean> {
  const lp = lkRoom?.localParticipant
  if (!state.call.on || !lp) return false
  const gen = ++micGen
  try {
    await lp.setMicrophoneEnabled(true, audioC())
  } catch (e) {
    const n = (e as { name?: string })?.name
    setCall({ note: n === 'NotAllowedError' ? 'Mic blocked — allow it in your browser settings.' : n === 'NotFoundError' ? 'No mic found.' : 'Could not access the mic.' })
    return false
  }
  // Muted or left while the permission prompt was up.
  if (gen !== micGen || !state.call.on) { micClose(); return false }
  void enumerate()
  setCall({ note: '' })
  return true
}
/** Stop the mic entirely (unpublish and stop the track), so the OS leaves voice-call mode. */
function micClose() {
  micGen++
  const lp = lkRoom?.localParticipant
  const t = lp?.getTrackPublication(SRC.mic)?.track
  if (lp && t) void lp.unpublishTrack(t, true).catch(() => { /* */ })
}
export function setMic(id: string) {
  set({ micId: id })
  if (state.call.on && !state.call.muted) { micClose(); void micOpen() }
}
export function setSpeaker(id: string) { set({ speakerId: id }); applySink() }
function applySink() {
  type Sinkable = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  const els: Sinkable[] = [...Object.values(audioEls), ...(video ? [video] : [])]
  els.forEach((el) => { el.setSinkId?.(state.speakerId).catch(() => { /* */ }) })
}

export async function toggleMute() {
  if (!state.call.on || !lkRoom) return
  if (!state.call.muted) { micClose(); setCall({ muted: true }); return }
  setCall({ muted: false })
  const others = muteOtherCalls('watch')
  if (others.length) toast(`Muted your ${others.join(' and ')} mic while you're talking in Watch Party`, 'info')
  if (!(await micOpen()) && state.call.on) setCall({ muted: true })
}
registerCall('watch', { label: 'Watch', live: () => state.call.on && !state.call.muted, mute: () => void toggleMute() })
/** Camera off/on while staying in the call. Before joining, the same control joins. */
export function toggleVideo() {
  if (!state.call.on) { void joinCall(); return }
  const lp = lkRoom?.localParticipant
  if (state.call.micOnly || !lp) return
  const camOff = !state.call.camOff
  setCall({ camOff })
  void lp.setCameraEnabled(!camOff).catch(() => { setCall({ camOff: !camOff }) }).finally(syncPeers)
}
export async function flipCam() {
  const t = lkRoom?.localParticipant.getTrackPublication(SRC.cam)?.track
  if (!state.call.on || state.call.busy || !t) return
  setCall({ busy: true })
  const next = state.call.facing === 'environment' ? 'user' : 'environment'
  try {
    if (t.restartTrack) await t.restartTrack({ facingMode: next })
    else if (t.replaceTrack) {
      const nt = (await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_C, facingMode: next } })).getVideoTracks()[0]
      if (nt) await t.replaceTrack(nt, true)
    }
    setCall({ facing: next })
    syncPeers()
  } catch {
    setCall({ note: 'Could not flip camera.' })
  } finally {
    setCall({ busy: false })
  }
}

// Reactions still go peer to peer over the party socket.
function onSignal(from: string | undefined, msg: { t?: string; e?: string } | undefined) {
  if (!from || from === state.clientId || !msg) return
  if (msg.t === 'rx' && msg.e) showRx(msg.e, nameOf(from))
}
/** The roster changed: the tiles follow it (who's in the call is the LiveKit room). */
function reconcilePeers() { bumpRtc() }

export type PeerView = { stream: MediaStream | null; video: boolean; badge: string; connected: boolean; inCall: boolean }
/** What an orb shows for a peer right now. */
export function peerView(id: string): PeerView {
  const pr = peers[id]
  const cam = pr?.p.getTrackPublication(SRC.cam)
  const v = cam?.track?.mediaStreamTrack
  const inCall = !!pr && pr.p.trackPublications.size > 0
  const video = !!cam && !cam.isMuted && !!v && v.readyState === 'live'
  return { stream: pr?.stream ?? null, video, badge: inCall && pr?.stream ? '📷' : '', connected: !!pr, inCall }
}

// ── Peer audio: hidden <audio> elements, one per peer ───────────────────────
const audioEls: Record<string, HTMLAudioElement> = {}
let audioBox: HTMLDivElement | null = null
function playAudio(id: string, stream: MediaStream) {
  if (!audioBox) { audioBox = document.createElement('div'); audioBox.hidden = true; audioBox.dataset.wpAudio = ''; document.body.appendChild(audioBox) }
  let a = audioEls[id]
  if (!a) { a = document.createElement('audio'); a.autoplay = true; audioEls[id] = a; audioBox.appendChild(a) }
  if (a.srcObject !== stream) a.srcObject = stream
  applyPeerAudio()
  if (state.speakerId) applySink()
  a.play().catch((e: unknown) => { if ((e as { name?: string })?.name === 'NotAllowedError') needGesture() })
}
function stopAudio(id: string) {
  const a = audioEls[id]
  if (!a) return
  a.srcObject = null
  a.remove()
  delete audioEls[id]
}
/** Browsers refuse to start audio without a tap; take the next one anywhere. */
function needGesture() {
  if (state.needGesture) return
  set({ needGesture: true })
  const go = () => {
    window.removeEventListener('pointerdown', go, true)
    window.removeEventListener('keydown', go, true)
    set({ needGesture: false })
    Object.values(audioEls).forEach((a) => { a.play().catch(() => { /* */ }) })
  }
  window.addEventListener('pointerdown', go, true)
  window.addEventListener('keydown', go, true)
}

// Stored by display name, since client ids change on every visit.
const prefKey = (id: string) => `n:${String(state.names[id] || id).toLowerCase()}`
export function peerPref(id: string) {
  const p = state.prefs[prefKey(id)]
  return { v: p && Number.isFinite(p.v) ? Math.max(0, Math.min(1, p.v)) : 1, m: !!p?.m }
}
export function setPeerPref(id: string, patch: Partial<{ v: number; m: boolean }>) {
  const k = prefKey(id)
  const cur = { ...peerPref(id), ...patch }
  const all = { ...state.prefs }
  if (cur.v === 1 && !cur.m) delete all[k]; else all[k] = cur
  writeLocal(PREFS_KEY, all)
  set({ prefs: all })
  applyPeerAudio()
}
function applyPeerAudio() {
  for (const [id, a] of Object.entries(audioEls)) {
    const pr = peerPref(id)
    a.muted = state.camMuted || pr.m
    try { a.volume = Math.max(0, Math.min(1, state.camVol * pr.v)) } catch { /* iOS */ }
  }
}
export function setCamVol(v: number) {
  const vol = Math.max(0, Math.min(1, v))
  set({ camVol: vol, camMuted: vol > 0 ? false : state.camMuted })
  applyPeerAudio()
}
export function toggleCamsMute() {
  if (!state.camMuted && state.camVol === 0) set({ camVol: 1 })
  else set({ camMuted: !state.camMuted })
  applyPeerAudio()
}

// ── Lock screen (Media Session) ─────────────────────────────────────────────
// Every control goes through the same paths as the overlay, so the whole party follows.
const SKIP_S = 10
const lockHandlers: lockScreen.Handlers = {
  play: () => { if (!isPlaying()) togglePlay() },
  pause: () => { if (isPlaying()) togglePlay() },
  seekto: (d) => { if (d.seekTime != null) userSeek(d.seekTime) },
  seekbackward: (d) => skip(-(d.seekOffset || SKIP_S)),
  seekforward: (d) => skip(d.seekOffset || SKIP_S),
  // Chrome offers this when you switch away from a playing video (or a live call).
  enterpictureinpicture: () => { void popOut() },
}

// ── Picture in picture ──────────────────────────────────────────────────────
// The movie floats when there's a video file playing; otherwise the call does, showing
// whoever's talking (the last one who did, so it doesn't flicker between people).
let lastTalker = ''
function callPipStream(): MediaStream | null {
  const withVideo = Object.keys(peers).filter((id) => peerView(id).video)
  const talking = withVideo.find((id) => state.loud[id])
  if (talking) lastTalker = talking
  const pick = withVideo.includes(lastTalker) ? lastTalker : withVideo[0]
  return pick ? streamOf(peers[pick]?.stream?.getVideoTracks().find((t) => t.readyState === 'live')) : null
}
const movieFloats = () => state.kind === 'file' && !!video && state.playing && !!document.pictureInPictureEnabled
/** Pop out: the movie, or the call, in a floating window. */
export async function popOut(): Promise<boolean> {
  if (movieFloats() && video) {
    try {
      if (document.pictureInPictureElement !== video) await video.requestPictureInPicture()
      return true
    } catch { return false }
  }
  return openPip(callPipStream(), 'watch')
}
export const canPopOut = (s: WatchState) => pipSupported() && ((s.kind === 'file' && s.playing) || (s.call.on && Object.keys(peers).some((id) => peerView(id).video)))

function lockSpec(): lockScreen.Spec {
  const id = state.kind === 'yt' ? ytId(state.video) : null
  const n = state.presence.count
  const d = duration()
  return {
    title: videoLabel() || 'Watch Party',
    artist: `Watch Party${n > 1 ? ` · ${n} watching` : ''}`,
    album: 'CRCMZ',
    art: id ? [{ src: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, size: '480x360' }] : [],
    playing: state.playing,
    handlers: lockHandlers,
    // A live stream has no end, so no scrubber.
    position: Number.isFinite(d) && d > 0 ? { at: time() ?? 0, duration: d } : null,
  }
}

function syncLockScreen() {
  if (lockScreen.holds('watch')) lockScreen.update('watch', lockSpec())
}
