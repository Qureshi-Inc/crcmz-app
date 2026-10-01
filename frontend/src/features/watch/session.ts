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
import { ApiError } from '../../lib/http'
import { readLocal, writeLocal } from '../../lib/media'
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
export type Clock = { t: number; dur: number; buf: number; live: boolean }

const MAX_TRIES = 6
// STUN finds a direct path; the server's config adds the TURN relay for people who
// can't be reached directly (strict NAT, mobile carriers, VPNs).
let ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
let iceAt = 0
/** The relay password lasts 12 hours; a page left open longer fetches a fresh one. */
async function freshIce() {
  if (!iceAt || Date.now() - iceAt < 6 * 3600_000) return
  try { const c = await getConfig(); if (c.iceServers?.length) { ICE = c.iceServers; iceAt = Date.now() } } catch { /* keep the old one */ }
}
// The orbs are small, so a tiny stream looks identical to a big one and keeps the
// mesh affordable on phone uplinks.
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
  chat: [], call: { on: false, muted: false, micOnly: false, camOff: false, facing: 'user', busy: false, note: '' },
  rtc: 0, loud: {}, playerVol: 1, playerMuted: false, camVol: 1, camMuted: false,
  prefs: readLocal<Record<string, { v: number; m: boolean }>>(PREFS_KEY, {}),
  fs: false, extracting: false, extractUntil: 0, title: '', needGesture: false, histTick: 0,
  mics: [], speakers: [], micId: '', speakerId: '', orbPos: readOrbPos(),
}
let clock: Clock = { t: 0, dur: NaN, buf: 0, live: false }
const listeners = new Set<() => void>()
const clockListeners = new Set<() => void>()
function set(patch: Partial<WatchState>) {
  state = { ...state, ...patch }
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
  set({ video: url, kind: '', ytFresh: false, playing: false, unblock: '', mediaError: '' })
  titleVideoChanged()
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
  if (cfg.iceServers?.length) { ICE = cfg.iceServers; iceAt = Date.now() }
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
    s.emit('watch:presence:get')
    s.emit('CMD:askHost')
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
    // Peer connections are addressed by socket id server-side, so they're all dead.
    // Our own camera stays on and re-announces once we're back.
    set({ roster: [] })
    dropAllPeers()
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
  s.on('signal', (d: { from?: string; msg?: Signal }) => void onSignal(d?.from, d?.msg))
  s.on('REC:host', (h: { video?: string; videoTS?: number; paused?: boolean }) => {
    h = h || {}
    log('rec.host', { video: short(h.video || ''), prev: short(state.video), ts: Number(h.videoTS) || 0, paused: !!h.paused, first: awaitHost }, !h.video && state.video ? 'warn' : 'info')
    applyHost(h)
  })
  s.on('REC:play', (url: string) => { log('rec.play', { t: time() }); if (url && url !== state.video) mount(url); remote(play) })
  s.on('REC:pause', () => { log('rec.pause', { t: time() }); remote(pause) })
  s.on('REC:seek', (ts: number) => { log('rec.seek', { to: Number(ts), t: time() }); remote(() => seek(Number(ts))) })
  s.on('REC:playbackRate', (r: number) => { if (video && Number(r)) video.playbackRate = Number(r) })
  // Correct drift > 3 s against the median of the other viewers.
  s.on('REC:tsMap', (map: Record<string, number>) => {
    if (!map || applying) return
    const cur = time()
    if (cur === null) return
    const others = Object.entries(map).filter(([id]) => id !== state.clientId).map(([, t]) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
    if (!others.length) return
    const med = others[Math.floor(others.length / 2)]!
    if (Math.abs(cur - med) > 3) { log('sync.drift', { t: Math.round(cur * 10) / 10, median: Math.round(med * 10) / 10, n: others.length }); remote(() => seek(med)) }
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

export function videoLabel(typedOnly = false): string {
  let label = state.title.trim()
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
  const msg = `@all ${names.length ? names.join(', ') : 'We'} are on CRCMZ app ${label ? `watching ${label}` : 'in the watch party'}. Join now fuckers! ${location.origin}/watch`
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

// ── The call: local media ───────────────────────────────────────────────────
type Signal = { t: 'cam'; on: boolean; vid?: boolean } | { t: 'sdp'; sdp: RTCSessionDescriptionInit } | { t: 'ice'; ice: RTCIceCandidateInit } | { t: 'rx'; e: string }
type Peer = { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; stream: MediaStream | null; discT: number }
let localStream: MediaStream | null = null
const peers: Record<string, Peer> = {}
const remoteCam: Record<string, boolean> = {}
const remoteCamOff: Record<string, boolean> = {}

const live = () => state.roster.map((u) => u?.id).filter((id): id is string => !!id && id !== state.clientId)
export const nameOf = (id: string) => state.names[id] || 'Viewer'
function signal(to: string, msg: Signal) { if (sock?.connected) sock.emit('signal', { to, msg }) }
const camMsg = (on: boolean): Signal => ({ t: 'cam', on, vid: on && !state.call.camOff })
const announce = (on: boolean) => live().forEach((id) => signal(id, camMsg(on)))
export const localMedia = () => localStream
/** How a connected call travels: 'host'/'srflx' are direct, 'relay' goes through TURN. */
async function routeOf(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await pc.getStats()
    let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined
    stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r })
    if (!pair) return 'unknown'
    const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : null
    const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null
    return `${local?.candidateType ?? '?'}/${remote?.candidateType ?? '?'}${local?.relayProtocol ? ` ${local.relayProtocol}` : ''}`
  } catch { return 'unknown' }
}
export const canCall = () => typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.RTCPeerConnection === 'function'

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

export async function joinCall() {
  if (state.call.busy || state.call.on) return
  if (!canCall()) { setCall({ note: "This browser can't share a camera." }); return }
  setCall({ busy: true, note: 'Asking for permission…', micOnly: false })
  await freshIce()
  try {
    let stream: MediaStream
    let micOnly = false
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_C, facingMode: 'user' }, audio: audioC() })
    } catch (e) {
      const n = (e as { name?: string })?.name || ''
      log('cam.error', { name: n, msg: String((e as Error)?.message || '').slice(0, 160) }, 'warn')
      if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
        setCall({ note: 'No camera found — joining with mic only…' })
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioC() })
          micOnly = true
        } catch (e2) {
          setCall({ note: (e2 as { name?: string })?.name === 'NotAllowedError' ? 'Mic blocked — allow it in your browser settings.' : 'Could not access the mic.' })
          return
        }
      } else {
        setCall({ note: n === 'NotAllowedError' ? 'Camera/mic blocked — allow it in your browser settings.' : n === 'NotReadableError' ? 'Camera is in use by another app.' : 'Could not start the camera.' })
        return
      }
    }
    void enumerate()
    localStream = stream
    // The mic is live as soon as you join; Mute is one tap away.
    setCall({ on: true, muted: false, camOff: false, micOnly, facing: 'user', note: '' })
    log('cam.on', { micOnly, tracks: stream.getTracks().map((t) => `${t.kind}:${t.readyState}`) })
    // A camera can be revoked mid-call; a mic can end on its own (phone call, iOS
    // background). Video ending hangs up; audio ending remounts just the mic.
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => { if (state.call.on) camStop() }))
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (state.call.on) void remountMic() }))
    meter('me', stream)
    const others = muteOtherCalls('watch')
    if (others.length) toast(`Muted your ${others.join(' and ')} mic while you're in Watch Party`, 'info')
    announce(true)
    live().forEach((id) => peer(id, true))
    Object.values(peers).forEach(syncTracks)
    bumpRtc()
  } finally {
    setCall({ busy: false })
  }
}
function camStop() {
  log('cam.off')
  setCall({ on: false, muted: false, camOff: false, micOnly: false })
  announce(false)
  for (const id of Object.keys(peers)) {
    // Keep the connection if they still send us video; otherwise drop it.
    if (remoteCam[id]) syncTracks(peers[id]!)
    else dropPeer(id)
  }
  localStream?.getTracks().forEach((t) => t.stop())
  localStream = null
  meterStop('me')
  bumpRtc()
}
export const leaveCall = () => { if (state.call.on) camStop() }
function endCall() { if (state.call.on) camStop() }

async function remountMic() {
  if (!state.call.on || !localStream) return
  let track: MediaStreamTrack | undefined
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: audioC() })
    track = fresh.getAudioTracks()[0]
  } catch {
    setCall({ note: 'Mic disconnected — tap Unmute to refresh.' })
    return
  }
  const ls = localStream
  if (!track || !state.call.on || !ls) return
  const nt = track
  // Swap into every sender without renegotiating (video keeps flowing).
  await Promise.all(Object.values(peers).map(async (p) => {
    const s = p.pc.getSenders().find((x) => x.track?.kind === 'audio')
    if (s) await s.replaceTrack(nt).catch(() => { /* */ })
  }))
  ls.getAudioTracks().forEach((t) => { try { t.stop() } catch { /* */ } ls.removeTrack(t) })
  ls.addTrack(nt)
  nt.enabled = !state.call.muted
  nt.addEventListener('ended', () => { if (state.call.on) void remountMic() })
  meterStop('me')
  meter('me', ls)
  setCall({ note: '' })
}
export function setMic(id: string) { set({ micId: id }); if (state.call.on) void remountMic() }
export function setSpeaker(id: string) { set({ speakerId: id }); applySink() }
function applySink() {
  type Sinkable = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  const els: Sinkable[] = [...Object.values(audioEls), ...(video ? [video] : [])]
  els.forEach((el) => { el.setSinkId?.(state.speakerId).catch(() => { /* */ }) })
}

export function toggleMute() {
  if (!state.call.on || !localStream) return
  const muted = !state.call.muted
  localStream.getAudioTracks().forEach((t) => { t.enabled = !muted })
  setCall({ muted })
}
registerCall('watch', { label: 'Watch', live: () => state.call.on && !state.call.muted, mute: toggleMute })
/** Camera off/on while staying in the call. Before joining, the same control joins. */
export function toggleVideo() {
  if (!state.call.on) { void joinCall(); return }
  if (state.call.micOnly || !localStream) return
  const camOff = !state.call.camOff
  localStream.getVideoTracks().forEach((t) => { t.enabled = !camOff })
  setCall({ camOff })
  announce(true)
  bumpRtc()
}
export async function flipCam() {
  if (!state.call.on || state.call.busy || !localStream) return
  setCall({ busy: true })
  const next = state.call.facing === 'environment' ? 'user' : 'environment'
  try {
    let track: MediaStreamTrack | undefined
    try {
      // {exact} first, for the true back/front camera on multi-camera phones.
      track = (await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_C, facingMode: { exact: next } } })).getVideoTracks()[0]
    } catch {
      try { track = (await navigator.mediaDevices.getUserMedia({ video: { ...VIDEO_C, facingMode: next } })).getVideoTracks()[0] } catch { setCall({ note: 'Could not flip camera.' }); return }
    }
    const ls = localStream
    if (!track || !ls) return
    const nt = track
    nt.enabled = !state.call.camOff
    await Promise.all(Object.values(peers).map(async (p) => {
      const s = p.pc.getSenders().find((x) => x.track?.kind === 'video')
      if (s) await s.replaceTrack(nt).catch(() => { /* */ })
    }))
    ls.getVideoTracks().forEach((t) => { try { t.stop() } catch { /* */ } ls.removeTrack(t) })
    ls.addTrack(nt)
    nt.addEventListener('ended', () => { if (state.call.on) camStop() })
    setCall({ facing: next })
    bumpRtc()
  } finally {
    setCall({ busy: false })
  }
}

// ── Peer connections (perfect negotiation) ──────────────────────────────────
function peer(id: string, create: boolean): Peer | null {
  const have = peers[id]
  if (have) return have
  if (!create || !id || id === state.clientId) return null
  const pc = new RTCPeerConnection({ iceServers: ICE, bundlePolicy: 'max-bundle' })
  // The "polite" peer yields on an offer collision; comparing ids agrees without a round trip.
  const p: Peer = { pc, polite: state.clientId > id, makingOffer: false, ignoreOffer: false, stream: null, discT: 0 }
  peers[id] = p
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true
      await pc.setLocalDescription()
      if (pc.localDescription) signal(id, { t: 'sdp', sdp: pc.localDescription.toJSON() as RTCSessionDescriptionInit })
    } catch { /* */ } finally { p.makingOffer = false }
  }
  pc.onicecandidate = (ev) => { if (ev.candidate) signal(id, { t: 'ice', ice: ev.candidate.toJSON() }) }
  pc.ontrack = (ev) => {
    log('peer.track', { peer: nameOf(id), kind: ev.track.kind, muted: ev.track.muted })
    p.stream = ev.streams[0] || p.stream
    // A remote track arrives muted and unmutes once media flows; re-render then.
    ;(['unmute', 'mute', 'ended'] as const).forEach((n) => ev.track.addEventListener(n, bumpRtc))
    if (p.stream) { meter(id, p.stream); playAudio(id, p.stream) }
    bumpRtc()
  }
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState
    log('peer.state', { peer: nameOf(id), st, ice: pc.iceConnectionState }, st === 'failed' || st === 'disconnected' ? 'warn' : 'info')
    if (st === 'connected') void routeOf(pc).then((via) => log('peer.route', { peer: nameOf(id), via }))
    if (st === 'failed') { window.clearTimeout(p.discT); dropPeer(id) }
    else if (st === 'disconnected') {
      // Five seconds to recover on its own, then an ICE restart.
      p.discT = window.setTimeout(() => {
        if (peers[id] && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
          log('peer.restart_ice', { peer: nameOf(id) }, 'warn')
          try { pc.restartIce() } catch { dropPeer(id) }
        }
      }, 5000)
    } else if (st === 'connected') window.clearTimeout(p.discT)
    bumpRtc()
  }
  syncTracks(p)
  return p
}
/** Idempotent: the peer's senders match what we're sending now. */
function syncTracks(p: Peer) {
  const want = state.call.on && localStream ? localStream.getTracks() : []
  p.pc.getSenders().forEach((s) => { if (s.track && !want.includes(s.track)) { try { p.pc.removeTrack(s) } catch { /* */ } } })
  want.forEach((t) => {
    if (p.pc.getSenders().some((s) => s.track === t)) return
    try {
      const sender = p.pc.addTrack(t, localStream!)
      if (t.kind === 'video') void capBitrate(sender)
    } catch { /* */ }
  })
}
async function capBitrate(sender: RTCRtpSender) {
  try {
    const prm = sender.getParameters()
    prm.encodings = prm.encodings?.length ? prm.encodings : [{}]
    prm.encodings[0]!.maxBitrate = CAM_BITRATE
    prm.encodings[0]!.maxFramerate = 20
    await sender.setParameters(prm)
  } catch { /* */ }
}
function dropPeer(id: string) {
  const p = peers[id]
  if (!p) return
  try {
    p.pc.onnegotiationneeded = null; p.pc.onicecandidate = null; p.pc.ontrack = null; p.pc.onconnectionstatechange = null
    p.pc.close()
  } catch { /* */ }
  delete peers[id]
  meterStop(id)
  stopAudio(id)
  bumpRtc()
}
function dropAllPeers() {
  Object.keys(peers).forEach(dropPeer)
  Object.keys(remoteCam).forEach((k) => delete remoteCam[k])
  Object.keys(remoteCamOff).forEach((k) => delete remoteCamOff[k])
  bumpRtc()
}
async function onSignal(from: string | undefined, msg: Signal | undefined) {
  if (!from || from === state.clientId || !msg) return
  if (msg.t === 'rx') { showRx(msg.e, nameOf(from)); return }
  if (msg.t === 'cam') {
    remoteCam[from] = !!msg.on
    if (msg.on && msg.vid === false) remoteCamOff[from] = true
    else delete remoteCamOff[from]
    if (msg.on) peer(from, true)
    else if (!state.call.on) dropPeer(from)
    bumpRtc()
    return
  }
  // Only negotiate with peers one of us actually wants media from.
  const p = peer(from, state.call.on || !!remoteCam[from])
  if (!p) return
  const pc = p.pc
  try {
    if (msg.t === 'sdp' && msg.sdp) {
      const collision = msg.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable')
      p.ignoreOffer = !p.polite && collision
      if (p.ignoreOffer) return
      await pc.setRemoteDescription(msg.sdp)
      if (msg.sdp.type === 'offer') {
        await pc.setLocalDescription()
        if (pc.localDescription) signal(from, { t: 'sdp', sdp: pc.localDescription.toJSON() as RTCSessionDescriptionInit })
      }
    } else if (msg.t === 'ice' && msg.ice) {
      try { await pc.addIceCandidate(msg.ice) } catch (e) { if (!p.ignoreOffer) throw e }
    }
  } catch { /* */ }
}
/** Roster changed: drop people who left, greet people who arrived. */
function reconcilePeers() {
  const alive = new Set(live())
  Object.keys(peers).forEach((id) => { if (!alive.has(id)) dropPeer(id) })
  Object.keys(remoteCam).forEach((id) => { if (!alive.has(id)) delete remoteCam[id] })
  Object.keys(remoteCamOff).forEach((id) => { if (!alive.has(id)) delete remoteCamOff[id] })
  if (state.call.on) {
    alive.forEach((id) => {
      if (peers[id]) return
      signal(id, camMsg(true))
      peer(id, true)
    })
  }
  bumpRtc()
}

export type PeerView = { stream: MediaStream | null; video: boolean; badge: string; connected: boolean; inCall: boolean }
/** What an orb shows for a peer right now. */
export function peerView(id: string): PeerView {
  const p = peers[id]
  const v = p?.stream?.getVideoTracks().find((t) => t.readyState === 'live' && !t.muted)
  const st = p?.pc.connectionState
  const badge = !p ? '' : st === 'connected' ? (p.stream ? '📷' : '') : st === 'failed' ? '⚠️' : remoteCam[id] || state.call.on ? '⋯' : ''
  return { stream: p?.stream ?? null, video: !!v && !remoteCamOff[id], badge, connected: st === 'connected', inCall: !!remoteCam[id] }
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

// ── Speaking detection ──────────────────────────────────────────────────────
type Meter = { ctx: AudioContext; an: AnalyserNode; data: Uint8Array<ArrayBuffer>; stream: MediaStream; loud: boolean }
const levels: Record<string, Meter> = {}
let meterT = 0
function meter(key: string, stream: MediaStream) {
  if (!stream.getAudioTracks().length) return
  if (levels[key]?.stream === stream) return // ontrack fires per track; meter once
  meterStop(key)
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* */ })
    const an = ctx.createAnalyser()
    an.fftSize = 512
    an.smoothingTimeConstant = 0.6
    ctx.createMediaStreamSource(stream).connect(an)
    levels[key] = { ctx, an, stream, data: new Uint8Array(an.frequencyBinCount), loud: false }
    if (!meterT) {
      // 8 Hz is plenty to drive a glow.
      meterT = window.setInterval(() => {
        const keys = Object.keys(levels)
        if (!keys.length) { window.clearInterval(meterT); meterT = 0; return }
        let changed = false
        const loud: Record<string, boolean> = {}
        keys.forEach((k) => {
          const m = levels[k]!
          m.an.getByteFrequencyData(m.data)
          let sum = 0
          for (let i = 0; i < m.data.length; i++) sum += m.data[i]!
          const l = sum / m.data.length > 18
          if (l !== m.loud) { m.loud = l; changed = true }
          loud[k] = l
        })
        if (changed) set({ loud })
      }, 120)
    }
  } catch { /* */ }
}
function meterStop(key: string) {
  const m = levels[key]
  if (!m) return
  try { void m.ctx.close() } catch { /* */ }
  delete levels[key]
  if (state.loud[key]) { const loud = { ...state.loud }; delete loud[key]; set({ loud }) }
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
  // Chrome offers this when you switch away from a playing video.
  enterpictureinpicture: () => {
    if (state.kind === 'file' && video && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      video.requestPictureInPicture().catch(() => { /* not allowed right now */ })
    }
  },
}

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
