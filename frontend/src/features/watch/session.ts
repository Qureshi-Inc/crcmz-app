// The Watch Party session: socket, synced player, the camera call and history
// pings. It lives outside React, like Slap's player, so leaving /watch keeps the
// party going. A port of the classic client (server.py, wp*), same wire protocol:
//   socket   WatchParty over socket.io, a fresh Watch Ticket per connect
//   sync     REC:host/play/pause/seek in, CMD:* out; remote applies are fenced by
//            `applying` so they never echo back; only our own controls send seeks;
//            whoever is behind the room catches up (nudge, or a seek past 8 s)
//   call     a WebRTC mesh over the `signal` relay with perfect negotiation, STUN only;
//            peer audio plays through hidden <audio> elements owned here, so the UI
//            can re-render (or the page can hide) without touching sound
import { useSyncExternalStore } from 'react'
import { toast } from '../../components/toast'
import { muteOtherCalls, registerCall } from '../../lib/calls'
import { ApiError, request } from '../../lib/http'
import { startActivity, stopActivity } from '../../lib/activity'
import { readLocal, writeLocal } from '../../lib/media'
import { isMovieStream } from '../../lib/movies'
import { isTV } from '../../lib/tv'
import { openPip, pipElement, pipSupported, setPipStream, stopPip, streamOf } from '../../lib/pip'
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
type HlsErr = { fatal?: boolean; type?: string; details?: string; reason?: string; frag?: { sn?: number | string; start?: number }; response?: { code?: number }; error?: { message?: string } }
type HlsInst = { loadSource(u: string): void; attachMedia(v: HTMLVideoElement): void; destroy(): void; on(e: string, f: (ev: unknown, d: HlsErr) => void): void; once(e: string, f: () => void): void }
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
  /** Companion mode (on a phone): the id of this person's TV this phone is the camera,
   *  mic and remote of; '' when off. */
  companion: string
  /** This person's TV (or other device), in the party right now ('' if none): the phone can be its companion. */
  myTv: string
  /** …and it says it's a TV. */
  myTvIsTv: boolean
  /** On the TV: a phone is its companion right now. */
  hasCompanion: boolean
  /** The room's play state, for a companion's remote (it has no video of its own). */
  roomPlaying: boolean
  /** You're in the party on a newer device too, so this one plays no call audio. */
  quiet: boolean
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
  // "Mute for me" lasts this visit only: kept forever (by name) it silenced people for
  // weeks after one stray tap. Volumes are kept.
  prefs: Object.fromEntries(Object.entries(readLocal<Record<string, { v: number; m: boolean }>>(PREFS_KEY, {}))
    .filter(([, p]) => p && Number.isFinite(p.v) && p.v !== 1).map(([k, p]) => [k, { v: p.v, m: false }])),
  fs: false, subs: [], sub: null, ytCc: false, extracting: false, extractUntil: 0, title: '', needGesture: false, histTick: 0,
  mics: [], speakers: [], micId: '', speakerId: '', orbPos: readOrbPos(),
  companion: '', myTv: '', myTvIsTv: false, hasCompanion: false, roomPlaying: false, quiet: false,
}
let clock: Clock = { t: 0, dur: NaN, buf: 0, live: false }
const listeners = new Set<() => void>()
const clockListeners = new Set<() => void>()
function set(patch: Partial<WatchState>) {
  state = { ...state, ...patch }
  if (patch.loud || patch.rtc) { setPipStream(callPipStream(), 'watch'); pipAttach() }
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
const devRing: { type: string; data?: unknown }[] = []   // dev builds: what the call test reads (the ring is sent and cleared)
function log(type: string, data?: unknown, level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  ring.push({ ts: Date.now(), type, level, ...(data === undefined ? {} : { data }) })
  if (import.meta.env.DEV) { devRing.push({ type, data }); if (devRing.length > 500) devRing.shift() }
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
const snap = () => ({
  status: state.status, video: short(state.video), kind: state.kind, t: time(), playing: isPlaying(), call: state.call.on, peers: Object.keys(peers).length,
  // In the call: my mic, and everyone's mic as the call server last measured it (0..1).
  ...(lkRoom ? {
    me: { mic: !state.call.muted && state.call.on, lvl: Math.round(micLive * 100) / 100 },
    // Per voice: what this device does with it (its <audio>) and what it receives (rx).
    hear: Object.values(audioEls).map((a) => ({
      n: nameOf(clientOf(a.p)), play: !a.el.paused, mute: a.el.muted, vol: Math.round(a.el.volume * 100) / 100, forMe: peerPref(clientOf(a.p)).m,
      tr: `${a.track.mediaStreamTrack.readyState}${a.track.mediaStreamTrack.muted ? '/nodata' : ''}`,
    })),
    rx: rxSummary(),
    cams: { vol: state.camVol, mute: state.camMuted }, gesture: state.needGesture,
    talk: [...lkRoom.remoteParticipants.values()].map((p) => ({ n: nameOf(clientOf(p)), mic: !!p.getTrackPublication(SRC.mic) && !p.getTrackPublication(SRC.mic)!.isMuted, lvl: Math.round(((p as { audioLevel?: number }).audioLevel ?? 0) * 100) / 100 })),
  } : {}),
})
function logError(msg: string) {
  const k = msg.slice(0, 80)
  errSeen[k] = (errSeen[k] || 0) + 1
  if (errSeen[k]! <= 3) log('js.error', { msg: msg.slice(0, 200) }, 'error')
}

// ── Playback diagnostics: why a film stops playing (often after a pause) ───
// Native HLS (Safari, Android) reports only an error code, so record what led up to it:
// the engine, how long it sat paused, what's buffered, and the last segment fetches,
// including whether the browser served them from its cache.
let engine: '' | 'native' | 'hls.js' | 'direct' = ''
let pausedAt = 0
let lastResume: { pausedFor: number; t: number | null; at: number } | null = null
let waitLogT = 0
const segRing: { seg: string; ms: number; kb: number; cached: boolean; st?: number; at: number }[] = []
const r1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null)
function ranges(r?: TimeRanges): string {
  const out: string[] = []
  if (r) for (let i = 0; i < r.length && i < 6; i++) out.push(`${r.start(i).toFixed(1)}-${r.end(i).toFixed(1)}`)
  return out.join(',')
}
function mediaSnap(el: HTMLVideoElement) {
  return {
    t: r1(el.currentTime), dur: r1(el.duration), rs: el.readyState, ns: el.networkState, buf: ranges(el.buffered), engine,
    pausedFor: pausedAt ? Math.round((Date.now() - pausedAt) / 1000) : 0,
  }
}
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceResourceTiming & { responseStatus?: number })[]) {
      if (!e.name.includes('/api/watch/movies/stream/')) continue
      segRing.push({
        seg: (e.name.split('?')[0] || '').split('/').pop() || '', ms: Math.round(e.duration), kb: Math.round(e.transferSize / 1024),
        cached: e.transferSize === 0 && e.decodedBodySize > 0, st: e.responseStatus, at: Date.now(),
      })
      if (segRing.length > 8) segRing.shift()
    }
  }).observe({ type: 'resource' })
} catch { /* no Resource Timing: the error still logs everything else */ }
const recentSegs = () => segRing.map((s) => ({ ...s, ago: Math.round((Date.now() - s.at) / 1000), at: undefined }))
const uaKind = () => {
  const ua = navigator.userAgent
  if (/Android/.test(ua)) return /; wv\)/.test(ua) ? 'android-webview' : 'android-browser'
  if (/iPhone|iPad/.test(ua)) return /Safari\//.test(ua) ? 'ios-safari' : 'ios-webview'
  return /Firefox\//.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other'
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
// After any seek, give everyone's reported times a few seconds to catch up before the
// drift check acts on them: comparing against the old positions dragged a scrub back.
let settleUntil = 0
const settle = (ms = 6000) => { settleUntil = Math.max(settleUntil, Date.now() + ms) }
// Our own seeks, so the room repeating them back to us doesn't seek us again.
let sentSeeks: { to: number; at: number }[] = []
let seekEmitT = 0

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
  el.addEventListener('pause', () => {
    syncPlaying(); if (echo() && !document.hidden) sock?.emit('CMD:pause')
    if (!pausedAt && el.getAttribute('src')) pausedAt = Date.now()
  })
  el.addEventListener('ended', syncPlaying)
  el.addEventListener('playing', () => {
    syncPlaying(); if (state.unblock) set({ unblock: '' })
    if (pausedAt) {
      const pausedFor = Math.round((Date.now() - pausedAt) / 1000)
      pausedAt = 0
      lastResume = { pausedFor, t: r1(el.currentTime), at: Date.now() }
      if (pausedFor >= 15) log('video.resume', { pausedFor, t: lastResume.t, buf: ranges(el.buffered), engine })
    }
  })
  // Seeks reach the room from userSeek only: a 'seeked' echo also fired for the room's own
  // seeks once a slow stream seek outlasted the echo window, and pulled everyone back.
  el.addEventListener('error', () => {
    if (!el.getAttribute('src')) return
    const e = el.error
    log('video.error', {
      code: e?.code, msg: (e?.message || '').slice(0, 300), video: short(state.video), ...mediaSnap(el), ua: uaKind(),
      resumed: lastResume ? { ...lastResume, ago: Math.round((Date.now() - lastResume.at) / 1000), at: undefined } : null,
      segs: recentSegs(),
    }, 'error')
    // A decode error on a library film is almost always a transcode that restarted under
    // us: pick it up again on a fresh one, once, before showing anyone an error.
    if (e?.code === 3 && autoRetry('decode')) return
    set({ mediaError: 'failed' })
  })
  el.addEventListener('stalled', () => log('video.stalled', { ...mediaSnap(el), segs: recentSegs().slice(-3) }, 'warn'))
  el.addEventListener('waiting', () => {
    if (waitLogT && Date.now() - waitLogT < 5000) return
    waitLogT = Date.now()
    log('video.waiting', mediaSnap(el))
  })
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
  settle()
  // Already there: seeking again would only make the stream fetch again.
  const cur = time()
  if (cur !== null && Math.abs(cur - ts) < 0.75) return
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
  settle()
  if (state.kind === 'file' && video) video.currentTime = to
  else if (state.kind === 'yt' && yt) { try { yt.seekTo(to, true) } catch { /* */ } }
  // Tell the room once the seeking stops (quick taps of ±10 s send one seek, not five).
  window.clearTimeout(seekEmitT)
  seekEmitT = window.setTimeout(() => {
    seekEmitT = 0
    const now = Date.now()
    sentSeeks = [...sentSeeks.filter((x) => now - x.at < 5000), { to, at: now }]
    sock?.emit('CMD:seek', to)
  }, 300)
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
  engine = ''
  pausedAt = 0
  lastResume = null
  set({ video: url, kind: '', ytFresh: false, playing: false, unblock: '', mediaError: '', subs: [], sub: null, ytCc: false })
  // A companion is the camera, mic and remote of a TV that plays the movie: no video here.
  if (state.companion || companionPending > Date.now()) { void movieTitle(url); return }
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
    engine = 'direct'
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
// A library film is one transcode per viewer on the server. Retrying asks for a fresh one
// (/stream/<id>~<gen>/…): the old one may be half gone (Jellyfin stops an idle transcode,
// e.g. after a long pause, and a restarted one's chunks don't line up with what's
// buffered: "Parsed buffers not in DTS sequence").
let streamGen = 0
const srcFor = (url: string) => (streamGen && isMovieStream(url) ? url.replace(/(\/stream\/[0-9a-f]{32})\//, `$1~${streamGen}/`) : url)
const streamId = (url: string) => /\/stream\/([0-9a-f]{32})\//.exec(url)?.[1] ?? ''
let autoRetryAt = 0

function mountHls(url: string) {
  const v = video
  if (!v) return
  const src = srcFor(url)
  const which = (e: typeof engine) => { engine = e; log('video.engine', { engine: e, ua: uaKind(), resumeAt: pendingTS ? r1(pendingTS) : 0 }) }
  if (v.canPlayType('application/vnd.apple.mpegurl')) { which('native'); v.src = src; seekOnMeta(); return }
  loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => {
    const H = window.Hls
    if (state.video !== url) return
    if (!H || !H.isSupported()) { which('native'); v.src = src; return }
    which('hls.js')
    const h = new H()
    hls = h
    const seen: Record<string, number> = {}
    h.on(H.Events.ERROR, (_ev, d) => {
      if (!d) return
      // Every fatal one, and the first few of each non-fatal kind (they repeat in bursts).
      const k = `${d.details}`
      seen[k] = (seen[k] || 0) + 1
      if (d.fatal || seen[k]! <= 3) {
        log('hls.error', {
          type: d.type, details: d.details, fatal: !!d.fatal, n: seen[k], reason: d.reason, err: d.error?.message?.slice(0, 200),
          sn: d.frag?.sn, fragAt: d.frag?.start != null ? r1(d.frag.start) : undefined, http: d.response?.code, ...mediaSnap(v),
          ...(d.fatal ? { segs: recentSegs() } : {}),
        }, d.fatal ? 'error' : 'warn')
      }
      if (d.fatal && !(d.type === 'mediaError' && autoRetry('hls.' + d.details))) set({ mediaError: 'failed' })
    })
    h.loadSource(src)
    h.attachMedia(v)
    if (pendingTS) { const t = pendingTS; pendingTS = 0; h.once(H.Events.MANIFEST_PARSED, () => { v.currentTime = t }) }
  }).catch(() => { which('native'); v.src = src })
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
  if (first && pendingHost) {
    const want = pendingHost
    pendingHost = null
    if (want !== url) { log('host.pending', { video: short(want) }); sock?.emit('CMD:host', want); return }
    // The room is already watching it: join where they are, no restart and no resume.
    log('host.already_on', { video: short(want), ts: Number(h.videoTS) || 0 })
    resume = null
  }
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
      if (L.t && L.t > 3) userSeek(L.t)
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
  _startIntervals()
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
    startActivity('watch')
    void connectRoom()   // listen to the party's call (cameras of whoever's in it)
    syncCallAttrs()      // already in it: say which party socket this is now
    s.emit('watch:presence:get')
    s.emit('CMD:askHost')
    // A video picked before we connected is put on once we know what the room has
    // (applyHost): hosting the one already on would start it over for everyone.
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
    rawRoster = []
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
  s.on('watch:presence', (d: Presence) => { rawPresence = { count: Number(d?.count) || 0, viewers: Array.isArray(d?.viewers) ? d.viewers : [] }; showPeople() })
  // nameMap only supplies names; it is never pruned. `roster` is the live list.
  s.on('REC:nameMap', (m: Record<string, string>) => set({ names: m || {} }))
  s.on('roster', (arr: RosterEntry[]) => { rawRoster = Array.isArray(arr) ? arr : []; showPeople(); reconcilePeers() })
  s.on('signal', (d: { from?: string; msg?: { t?: string; e?: string } }) => onSignal(d?.from, d?.msg))
  s.on('REC:host', (h: { video?: string; videoTS?: number; paused?: boolean }) => {
    h = h || {}
    log('rec.host', { video: short(h.video || ''), prev: short(state.video), ts: Number(h.videoTS) || 0, paused: !!h.paused, first: awaitHost }, !h.video && state.video ? 'warn' : 'info')
    roomAt = { t: Number(h.videoTS) || 0, at: Date.now() }
    set({ roomPlaying: !!h.video && !h.paused })
    applyHost(h)
  })
  s.on('REC:play', (url: string) => { log('rec.play', { t: time() }); set({ roomPlaying: true }); roomAt.at = Date.now(); if (url && url !== state.video) mount(url); remote(play) })
  s.on('REC:pause', () => { log('rec.pause', { t: time() }); set({ roomPlaying: false }); roomAt.t = roomTime(); roomAt.at = Date.now(); remote(pause) })
  s.on('REC:seek', (ts: number) => {
    const to = Number(ts)
    log('rec.seek', { to, t: time() })
    // The room repeating our own seek, or one we've already moved on from: stay put.
    const now = Date.now()
    if (sentSeeks.some((x) => now - x.at < 5000 && Math.abs(x.to - to) < 0.5)) return
    if (now - intent < 1500 && seekEmitT) return
    remote(() => seek(to))
  })
  s.on('REC:playbackRate', (r: number) => { if (video && Number(r)) { video.playbackRate = Number(r); nudging = Number(r) } })
  // Stay in step with the room. The map is everyone's last reported time (each client
  // reports every second, the server sends the map every second), so compare OUR entry in
  // it with the others' median: like with like. Comparing our live time with their
  // seconds-old reports made everyone look 3-4 s off, and the seeks it caused restarted
  // the movie's transcode and stalled everyone (the "out of sync" feeling).
  // Small drift: play 4% faster or slower until back in step (no seek, nothing reloads).
  // Big drift (> 8 s, a rejoin or a long stall): seek.
  s.on('REC:tsMap', (map: Record<string, number>) => {
    // Where the room is (everyone else's median), for a companion's remote.
    const all = Object.entries(map || {}).filter(([id]) => id !== state.clientId).map(([, t]) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
    if (all.length) roomAt = { t: all[Math.floor(all.length / 2)]!, at: Date.now() }
    if (!map || applying || Date.now() < settleUntil || video?.seeking) return
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
      // To where the others are, not "our time + the gap": right after a seek our own
      // entry in the map is stale, and adding the gap overshot and ratcheted the room on.
      remote(() => seek(med + (isPlaying() ? 0.5 : 0)))
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
  stopActivity('watch')
  _stopIntervals()
  disconnectRoom()
  window.clearTimeout(retryT)
  window.clearTimeout(recoverT)
  dropSock()
  mount('')
  lockScreen.release('watch')
  exitFs()
  rawRoster = []; rawPresence = { count: 0, viewers: [] }
  set({ status: 'idle', roster: [], presence: { count: 0, viewers: [] }, chat: [], error: '', companion: '', myTv: '', myTvIsTv: false, hasCompanion: false })
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
    // Already on for the room: you join where they are (hosting it again restarts it).
    if (state.video === url || roomVideo === url) { resume = null; return }
    sock.emit('CMD:host', url)
    return
  }
  pendingHost = url
}
export function clearVideo() { set({ error: '' }); sock?.emit('CMD:host', '') }
/** Once per 20 s: retry a library film by itself instead of showing the error. */
function autoRetry(why: string): boolean {
  if (!isMovieStream(state.video) || Date.now() - autoRetryAt < 20_000) return false
  autoRetryAt = Date.now()
  log('video.autoretry', { why, t: r1(time() ?? 0) }, 'warn')
  retryMedia()
  return true
}
/** Reload this viewer's stream without touching the room. Fixes transient Jellyfin errors. */
export function retryMedia() {
  const url = state.video
  if (!url) return
  const ts = time()
  if (ts !== null && ts > 5) pendingTS = ts
  streamGen = Date.now() % 1_000_000_000
  log('video.retry', { video: short(url), ts, gen: streamGen })
  mount(url)
}

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
  const src = burn === null ? srcFor(state.video) : `${srcFor(state.video)}?burn=${burn}`
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
// Intervals only run while a Watch Party is active; idling the whole time burned CPU.
let _tickIv = 0, _flushIv = 0, _heartIv = 0
function _startIntervals() {
  if (_tickIv) return
  _tickIv  = window.setInterval(tick, 250)
  _flushIv = window.setInterval(() => { flushLog() }, 10_000)
  _heartIv = window.setInterval(() => { log('heartbeat', snap(), 'debug') }, 30_000)
  _keepIv = window.setInterval(keepTranscode, 20_000)
  _stallIv = window.setInterval(stallWatch, 1000)
}
let _stallIv = 0
// Playing (not paused) a library film, and the picture hasn't moved for 15 s: the stream
// is stuck without ever raising an error (a stalled transcode). Pick it up on a fresh one.
let progress = { t: -1, at: 0 }
function stallWatch() {
  const v = video
  if (!state.active || state.kind !== 'file' || !v || v.paused || v.ended || !isMovieStream(state.video) || state.mediaError) { progress = { t: -1, at: 0 }; return }
  if (Math.abs(v.currentTime - progress.t) > 0.2) { progress = { t: v.currentTime, at: Date.now() }; return }
  if (Date.now() - progress.at < 15_000) return
  log('video.stuck', { ...mediaSnap(v), segs: recentSegs().slice(-3) }, 'warn')
  progress = { t: -1, at: 0 }
  if (!autoRetry('stall')) set({ mediaError: 'failed' })
}
let _keepIv = 0
/** Paused on a library film: tell the server we're still here, so Jellyfin keeps this
 *  viewer's transcode instead of stopping it (a restarted one breaks the stream). */
function keepTranscode() {
  if (!state.active || state.kind !== 'file' || !video?.paused || !isMovieStream(state.video)) return
  void request('/api/watch/movies/keepalive', { body: { id: streamId(state.video), gen: streamGen }, quiet401: true })
    .catch((e: unknown) => log('stream.keepalive_failed', { msg: String((e as Error)?.message || e).slice(0, 120) }, 'warn'))
}
function _stopIntervals() {
  window.clearInterval(_tickIv);  _tickIv  = 0
  window.clearInterval(_flushIv); _flushIv = 0
  window.clearInterval(_heartIv); _heartIv = 0
  window.clearInterval(_keepIv); _keepIv = 0
  window.clearInterval(_stallIv); _stallIv = 0
}
window.addEventListener('pagehide', () => { if (!state.active) return; if (wasPlaying) postHistory(); log('pagehide', snap()); flushLog(); if (state.call.on) camStop() })
document.addEventListener('visibilitychange', () => {
  if (!state.active) return
  log('visibility', { v: document.visibilityState }, 'debug')
  if (document.visibilityState === 'hidden') {
    if (wasPlaying) postHistory()
    flushLog()
    // Pause the 1s sync timer; it will restart on visible
    window.clearInterval(tsTimer); tsTimer = 0
  }
  if (document.visibilityState === 'visible') {
    // Restart the ts sync timer if we're in an active socket session
    if (!tsTimer && state.active) {
      const s = sock
      if (s) tsTimer = window.setInterval(() => { if (!s.connected) return; const t = time(); if (t !== null) s.emit('CMD:ts', t) }, 1000)
    }
    // Auto-reconnect when the app returns to foreground and the socket died while backgrounded.
    const s = state.status
    if (s === 'failed' || s === 'reconnecting' ||
        (s !== 'idle' && s !== 'signin' && s !== 'forbidden' && s !== 'kicked' && !sock?.connected)) {
      log('visibility.reconnect', { status: s })
      tries = 0
      window.clearTimeout(retryT)
      void connect()
    }
  }
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
// publishes your camera, and Talk your mic.
//   identity   person#device: a per-device id kept in localStorage, so a reload or a
//              socket reconnect is the same participant (not a new one, which left
//              ghosts and made everyone re-subscribe). Attributes say who it is in the
//              party: "socket" (this page's party socket) and "client" (whose viewer its
//              camera lands on: itself, or a companion phone's TV). Kick still works.
//   mic        published once, on the first Talk; Mute mutes that publication (the track
//              stops, so Bluetooth leaves headset mode) and Talk unmutes it: the same
//              track SID for everyone, so nobody re-subscribes and first words aren't cut.
//   audio      one <audio> per remote audio track (LiveKit attach), keyed by track SID,
//              made once and removed only when unsubscribed; cameras never touch it.
//   recovery   the mic restarts when it ends, when the OS takes it, when it sends exact
//              silence or stops sending packets; every listener checks each voice it
//              should hear is arriving and re-subscribes it when it isn't.
// The iOS app runs Huddle natively; the Watch Party call is this page, in the apps too.
type Signal = { t: 'rx'; e: string }
type LkTrack = {
  kind: 'audio' | 'video'; source: string; sid?: string; isMuted: boolean; mediaStreamTrack: MediaStreamTrack
  attach(el?: HTMLMediaElement): HTMLMediaElement
  detach(el?: HTMLMediaElement): unknown
  restartTrack?(o?: MediaTrackConstraints): Promise<unknown>
  replaceTrack?(t: MediaStreamTrack, userProvided?: boolean): Promise<unknown>
  sender?: RTCRtpSender
  receiver?: RTCRtpReceiver
}
type LkPub = {
  kind: 'audio' | 'video'; source: string; trackSid: string; isMuted: boolean; isSubscribed?: boolean; track?: LkTrack
  setSubscribed?(on: boolean): void
}
type LkParticipant = {
  identity: string; name?: string; isSpeaking: boolean; attributes?: Record<string, string>; joinedAt?: Date
  trackPublications: Map<string, LkPub>
  getTrackPublication(source: string): LkPub | undefined
}
type LkLocal = LkParticipant & {
  setMicrophoneEnabled(on: boolean, opts?: MediaTrackConstraints): Promise<unknown>
  setCameraEnabled(on: boolean, opts?: MediaTrackConstraints): Promise<unknown>
  unpublishTrack(t: LkTrack, stop?: boolean): Promise<unknown>
  setAttributes?(a: Record<string, string>): Promise<void>
}
type LkRoom = {
  localParticipant: LkLocal
  remoteParticipants: Map<string, LkParticipant>
  canPlaybackAudio?: boolean
  on(ev: string, fn: (...a: never[]) => void): LkRoom
  connect(url: string, token: string): Promise<void>
  disconnect(): Promise<void>
  startAudio(): Promise<void>
  switchActiveDevice(kind: MediaDeviceKind, id: string, exact?: boolean): Promise<boolean>
}
type LkNs = { Room: new (o: Record<string, unknown>) => LkRoom; RoomEvent: Record<string, string>; DisconnectReason?: Record<string, number> }
const LK_SRC = 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js'
const SRC = { cam: 'camera', mic: 'microphone' } as const
/** A viewer in the call: who stands for them (the participant with the camera) and their camera, video only. */
type Peer = { p: LkParticipant; stream: MediaStream | null; key: string; cam: LkTrack | null }

let lkRoom: LkRoom | null = null
let lkConnecting: Promise<LkRoom | null> | null = null
let lkNs: LkNs | null = null
let localStream: MediaStream | null = null
const peers: Record<string, Peer> = {}     // by party viewer id ("client")
/** Left the call because this device joined it from another tab: wait for "Hear the call here". */
let replaced = false

const live = () => state.roster.map((u) => u?.id).filter((id): id is string => !!id && id !== state.clientId)
export const nameOf = (id: string) => state.names[id] || 'Viewer'
function signal(to: string, msg: Signal) { if (sock?.connected) sock.emit('signal', { to, msg }) }
export const localMedia = () => localStream
export const canCall = () => typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.RTCPeerConnection === 'function'
/** Whose viewer a participant is: its "client" attribute (older pages: the identity's suffix). */
const clientOf = (p: LkParticipant) => p.attributes?.client || p.identity.split('#')[1] || p.identity
/** The party socket a participant is, for leaving companions out of the viewer list. */
const socketOf = (p: LkParticipant) => p.attributes?.socket || p.identity.split('#')[1] || ''

/** This device's id in the call: the identity is person#device, so reconnects keep it. */
function deviceId(): string {
  try {
    let id = localStorage.getItem('crcmzWatchDevice')
    if (!id) { id = crypto.randomUUID().replace(/-/g, '').slice(0, 16); localStorage.setItem('crcmzWatchDevice', id) }
    return id
  } catch { return '' }
}

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
  lkNs = w.LivekitClient ?? null
  return lkNs
}
const wait = (ms: number) => new Promise((res) => window.setTimeout(res, ms))
const errMsg = (e: unknown) => String((e as Error)?.message || e).slice(0, 160)

// The party's camera call runs here, in the page, in the phone apps too: the cameras sit
// over the video or beside it where your settings put them (Orbs), which a native call
// panel can't do. (Huddle is native in the apps; the Watch Party is not.)
/** The party's call room, connected listening (once per party visit). A network failure
 *  (the token fetch or the connect) is retried with backoff instead of giving up. */
function connectRoom(): Promise<LkRoom | null> {
  if (lkRoom) return Promise.resolve(lkRoom)
  if (lkConnecting) return lkConnecting
  lkConnecting = (async () => {
    try {
      const ns = await loadLk()
      if (!ns || !state.active) return null
      for (let i = 0; ; i++) {
        try {
          const t = await request<{ token: string; url: string; room: string }>('/api/watch/call/token', {
            body: {
              room: state.room || 'crcmz', client: state.clientId, deviceId: deviceId(),
              ...(isTV() ? { device: 'tv' } : {}), ...(state.companion ? { companion: state.companion } : {}),
            }, quiet401: true })
          const r = new ns.Room({
            // Tiles are small: subscribe to the layer that fits, pause what nobody can see
            // (the cameras attach their own <video>, see attachCam). Not in a hidden tab:
            // picture in picture shows the call from there.
            adaptiveStream: { pauseVideoInBackground: false }, dynacast: true, stopLocalTrackOnUnpublish: true,
            // Off: setSinkId (the speaker picker) and iOS Safari playback are per element.
            webAudioMix: false,
            videoCaptureDefaults: { resolution: { width: 320, height: 320, frameRate: 15 } },
            publishDefaults: {
              simulcast: true, videoEncoding: { maxBitrate: CAM_BITRATE, maxFramerate: 20 },   // the top layer stays capped
              stopMicTrackOnMute: true, dtx: true, red: true,
            },
          })
          wire(r, ns)
          await r.connect(t.url, t.token)
          if (!state.active) { void r.disconnect(); return null }
          lkRoom = r
          replaced = false
          log('call.room', { room: t.room, tries: i })
          startRxCheck()
          syncPeers()
          return r
        } catch (e) {
          // A refusal won't change on a retry; a network blip or a 5xx might.
          if ((e instanceof ApiError && e.status < 500) || i >= 4 || !state.active) throw e
          log('call.room_retry', { n: i + 1, msg: errMsg(e) }, 'warn')
          await wait(1000 * 2 ** i)
        }
      }
    } catch (e) {
      log('call.room_failed', { msg: errMsg(e) }, 'warn')
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
  stopRxCheck()
  Object.keys(peers).forEach((id) => { delete peers[id] })
  Object.keys(audioEls).forEach(detachAudio)
  if (state.loud && Object.keys(state.loud).length) set({ loud: {} })
  if (r) void r.disconnect().catch(() => { /* */ })
  bumpRtc()
}
/** The party socket reconnected: keep this participant's "socket"/"client" attributes current. */
function syncCallAttrs() {
  const lp = lkRoom?.localParticipant
  if (!lp?.setAttributes) return
  const want = { client: state.companion || state.clientId, socket: state.clientId }
  if (lp.attributes?.client === want.client && lp.attributes?.socket === want.socket) return
  void lp.setAttributes({ ...(lp.attributes || {}), ...want })
    .then(() => log('call.attrs', want)).catch((e: unknown) => log('call.attrs_failed', { msg: errMsg(e) }, 'warn'))
}

let lastSpeakers = ''
function wire(r: LkRoom, ns: LkNs) {
  const E = ns.RoomEvent
  const on = (ev: string | undefined, fn: (...a: never[]) => void) => { if (ev) r.on(ev, fn) }
  on(E.TrackSubscribed, ((track: LkTrack, pub: LkPub, p: LkParticipant) => {
    if (track.kind === 'audio') attachAudio(track, pub, p)
    syncPeers()
  }) as never)
  on(E.TrackUnsubscribed, ((track: LkTrack, pub: LkPub) => {
    if (track.kind === 'audio') detachAudio(pub.trackSid)
    syncPeers()
  }) as never)
  for (const ev of [E.TrackMuted, E.TrackUnmuted, E.TrackPublished, E.TrackUnpublished,
    E.ParticipantConnected, E.ParticipantDisconnected, E.LocalTrackPublished, E.LocalTrackUnpublished, E.ParticipantAttributesChanged]) {
    on(ev, () => syncPeers())
  }
  on(E.ActiveSpeakersChanged, ((speakers: LkParticipant[]) => {
    const loud: Record<string, boolean> = {}
    for (const sp of speakers) loud[sp === r.localParticipant ? 'me' : clientOf(sp)] = true
    set({ loud })
    // Who the call server hears talking (it decides from the levels each mic sends).
    const who = speakers.map((sp) => (sp === r.localParticipant ? 'me' : nameOf(clientOf(sp)))).sort().join(',')
    if (who !== lastSpeakers) { lastSpeakers = who; if (who) log('call.speakers', { who }) }
  }) as never)
  // The browser held our audio until a tap (or let it play again).
  on(E.AudioPlaybackStatusChanged, () => {
    const ok = r.canPlaybackAudio !== false
    log('audio.playback', { ok })
    if (!ok) needGesture()
    else if (state.needGesture) set({ needGesture: false })
  })
  on(E.MediaDevicesChanged, () => { void devicesChanged() })
  on(E.Reconnecting, () => log('call.reconnecting', undefined, 'warn'))
  on(E.Reconnected, () => { log('call.reconnected'); syncPeers() })
  on(E.Disconnected, ((reason?: number) => {
    if (lkRoom !== r) return
    lkRoom = null
    stopRxCheck()
    if (state.call.on) camStop()
    Object.keys(peers).forEach((id) => { delete peers[id] })
    Object.keys(audioEls).forEach(detachAudio)
    bumpRtc()
    // This device joined the call from another tab (same identity): that one has it now.
    if (reason !== undefined && reason === ns.DisconnectReason?.DUPLICATE_IDENTITY) {
      replaced = true
      log('call.replaced', undefined, 'warn')
      syncPeers()
      return
    }
    log('call.disconnected', { reason })
    // Still in the party: listen again shortly (the server restarted, the network blipped).
    if (state.active) window.setTimeout(() => { if (state.active && !lkRoom && !replaced) void connectRoom() }, 3000)
  }) as never)
}

/** Rebuild who's in the call from the room: per viewer, the participant that stands for
 *  them and their camera (video only: voices have their own elements, see attachAudio).
 *  A TV and its companion phone are one viewer (the phone's camera carries the TV's id),
 *  so their tracks merge; the phone's own socket is hidden from the viewer list. */
function syncPeers() {
  const r = lkRoom
  const seen = new Set<string>()
  const comps = new Set<string>()
  let tv = '', tvIsTv = false, mine = false, quiet = false
  if (r) {
    const me = r.localParticipant.identity.split('#')[0]
    const byId: Record<string, LkParticipant[]> = {}
    for (const p of r.remoteParticipants.values()) {
      const id = clientOf(p)
      ;(byId[id] ||= []).push(p)
      if (p.attributes?.companion === '1') comps.add(socketOf(p))
      if (p.identity.split('#')[0] === me) {
        // My other device in the party: a TV first, else any (a TV still on an older
        // page doesn't say it's a TV yet; a laptop works the same way).
        if (p.attributes?.companion !== '1' && id !== state.clientId && (!tv || p.attributes?.device === 'tv')) { tv = id; tvIsTv = p.attributes?.device === 'tv' }
        if (p.attributes?.companion === '1' && id === state.clientId) mine = true
        // The same person on two ordinary devices (two tabs, a phone and a laptop): only
        // the newest plays the call, or they hear everyone twice, out of step.
        const mj = r.localParticipant.joinedAt?.getTime() ?? 0, pj = p.joinedAt?.getTime() ?? 0
        if (!isTV() && !state.companion && p.attributes?.companion !== '1' && p.attributes?.device !== 'tv' && pj > mj) quiet = true
      }
    }
    for (const [id, ps] of Object.entries(byId)) {
      seen.add(id)
      // The one with the camera stands for the viewer (a TV listening, its phone sending).
      const p = ps.find((x) => x.getTrackPublication(SRC.cam)?.track) ?? ps.find((x) => x.getTrackPublication(SRC.mic)?.track) ?? ps[0]!
      const cam = ps.map((x) => x.getTrackPublication(SRC.cam)?.track).find((t) => !!t && t.mediaStreamTrack.readyState === 'live') ?? null
      const key = cam ? cam.mediaStreamTrack.id : ''
      const have = peers[id]
      // A new MediaStream only when the camera track itself changes.
      const stream = have && have.key === key ? have.stream : (cam ? new MediaStream([cam.mediaStreamTrack]) : null)
      peers[id] = { p, stream, key, cam }
    }
  }
  Object.keys(peers).forEach((id) => { if (!seen.has(id)) delete peers[id] })
  const camT = r?.localParticipant.getTrackPublication(SRC.cam)?.track?.mediaStreamTrack
  localStream = state.call.on ? (camT && camT.readyState === 'live' ? streamOf(camT) : localStream && !camT ? localStream : null) : null
  const compsKey = [...comps].sort().join(',')
  if (compsKey !== companionsKey) { companionsKey = compsKey; companions = comps; showPeople() }
  quiet = quiet || replaced
  if (quiet !== state.quiet) { log(quiet ? 'call.quiet_dupe' : 'call.unquiet', { replaced }); set({ quiet }) }
  if (tv !== state.myTv || tvIsTv !== state.myTvIsTv || mine !== state.hasCompanion) {
    if (mine !== state.hasCompanion) log(mine ? 'companion.joined' : 'companion.left')
    if (tv !== state.myTv) log('companion.found', { other: tv.slice(0, 8), tv: tvIsTv })
    set({ myTv: tv, myTvIsTv: tvIsTv, hasCompanion: mine })
  }
  applyPeerAudio()       // who this device should hear may have changed (quiet, companion)
  bumpRtc()
}

/** A remote camera into its tile's <video> (LiveKit attach, so adaptive stream knows its
 *  size and whether it's on screen). null when there's no such camera: use srcObject. */
export function attachCam(id: string, el: HTMLVideoElement): (() => void) | null {
  const cam = peers[id]?.cam
  if (!cam) return null
  cam.attach(el)
  return () => { cam.detach(el) }
}

// ── Who hears whom: every 5 s, is each voice this device should hear arriving? ──
// A silent speaker still sends packets (DTX comfort noise), so "no packets while that
// mic is unmuted" means it's broken for this listener: re-subscribe it.
type Rx = { pk: number; d: number; st: string; stalled: boolean; resubAt: number; who: string }
const rxState: Record<string, Rx> = {}
let rxT = 0
function startRxCheck() { stopRxCheck(); rxT = window.setInterval(() => { void rxCheck() }, 5000) }
function stopRxCheck() { window.clearInterval(rxT); rxT = 0; Object.keys(rxState).forEach((k) => delete rxState[k]) }
async function rxCheck() {
  const r = lkRoom
  if (!r) return
  const seen = new Set<string>()
  for (const p of r.remoteParticipants.values()) {
    const pub = p.getTrackPublication(SRC.mic)
    if (!pub) continue
    const sid = pub.trackSid
    seen.add(sid)
    const rs = (rxState[sid] ||= { pk: -1, d: -1, st: '', stalled: false, resubAt: 0, who: nameOf(clientOf(p)) })
    rs.who = nameOf(clientOf(p))
    if (pub.isMuted) { rs.st = 'muted'; rs.pk = -1; rs.d = -1; continue }
    const tr = pub.track
    if (!pub.isSubscribed || !tr?.receiver) { rs.st = 'unsub'; rs.pk = -1; continue }
    let pk = -1
    try {
      (await tr.receiver.getStats()).forEach((s: { type?: string; kind?: string; packetsReceived?: number }) => {
        if (s.type === 'inbound-rtp' && (s.kind === 'audio' || !s.kind)) pk = s.packetsReceived ?? -1
      })
    } catch { continue }
    if (pk < 0) continue
    const d = rs.pk < 0 || pk < rs.pk ? -1 : pk - rs.pk     // -1: a new baseline (first look, or re-subscribed)
    rs.pk = pk; rs.d = d
    if (d === 0) {
      rs.st = 'stalled'
      if (!rs.stalled) { rs.stalled = true; log('audio.rx_stalled', { who: rs.who, sid }, 'warn') }
      if (Date.now() - rs.resubAt > 15_000 && pub.setSubscribed) {
        rs.resubAt = Date.now()
        log('audio.resubscribe', { who: rs.who, sid }, 'warn')
        pub.setSubscribed(false)
        window.setTimeout(() => { pub.setSubscribed?.(true) }, 600)
      }
    } else if (d > 0) {
      rs.st = 'ok'
      if (rs.stalled) { rs.stalled = false; log('audio.rx_recovered', { who: rs.who, sid }) }
    }
  }
  Object.keys(rxState).forEach((k) => { if (!seen.has(k)) delete rxState[k] })
}
/** For the heartbeat: per voice, what this device receives (d = packets in the last 5 s). */
const rxSummary = () => Object.entries(rxState).map(([sid, r]) => ({ n: r.who, s: sid.slice(-6), st: r.st, d: r.d }))

// ── Companion mode ──────────────────────────────────────────────────────────
// Watching on the TV, the same person's phone can be its camera, mic and remote: chat
// and reactions from the phone, play/pause/skip for the room. The phone stays in the
// party (its socket) but plays no video, and its socket is left out of the viewer list.
let hearHere = false
/** "Hear the call here" on a device that went quiet for a newer one of yours. */
export function hearCallHere() {
  hearHere = true
  log('call.hear_here', { replaced })
  // This tab was bumped out of the call by another tab of this device: take it back.
  if (replaced) { replaced = false; void connectRoom() }
  syncPeers()
}
let rawRoster: RosterEntry[] = []
let rawPresence: Presence = { count: 0, viewers: [] }
let companions = new Set<string>()
let companionsKey = ''
function showPeople() {
  const keep = (id: string) => !companions.has(id)
  const viewers = rawPresence.viewers.filter((v) => keep(v.id))
  set({
    roster: rawRoster.filter((u) => keep(u.id)),
    presence: { count: Math.max(viewers.length, rawPresence.count - (rawPresence.viewers.length - viewers.length)), viewers },
  })
}
/** The room's position right now, as everyone else reports it (a companion has no video). */
let roomAt = { t: 0, at: 0 }
export function roomTime(): number {
  return roomAt.t + (state.roomPlaying && roomAt.at ? (Date.now() - roomAt.at) / 1000 : 0)
}
/** Coming from "Use as companion": hold the movie back while we look for the TV (12 s),
 *  so the phone never starts playing it. No TV by then: play it here as usual. */
let companionPending = 0
export function expectCompanion() {
  companionPending = Date.now() + 12_000
  window.setTimeout(() => {
    if (!companionPending || Date.now() < companionPending) return
    companionPending = 0
    if (!state.companion) { log('companion.no_tv', undefined, 'warn'); mount(state.video) }
  }, 12_500)
}
export async function startCompanion() {
  const tv = state.myTv
  companionPending = 0
  if (!tv || state.companion) return
  log('companion.start', { tv: tv.slice(0, 8) })
  set({ companion: tv })
  mount(state.video)             // drops this phone's own copy of the movie
  disconnectRoom()
  await connectRoom()            // back into the call as the TV's camera and mic
  if (!lkRoom) { set({ companion: '' }); toast("Couldn't connect to your TV's call", 'error'); void connectRoom(); return }
  await joinCall()
}
export async function stopCompanion() {
  if (!state.companion) return
  log('companion.stop')
  endCall()
  set({ companion: '' })
  disconnectRoom()
  void connectRoom()
  // And the movie again, where the room is.
  const at = roomTime()
  if (at > 5) pendingTS = at
  mount(state.video)
  if (sock?.connected) sock.emit('CMD:askHost')
}
/** On the go: the movie (and the call) on this phone instead; the camera stays on if it was. */
export async function watchHere() {
  const cam = state.call.on && !state.call.camOff
  await stopCompanion()
  if (cam) await joinCall()
}
/** The companion's remote: play/pause and skip for the whole room. */
export function companionPlay() { if (sock?.connected) sock.emit(state.roomPlaying ? 'CMD:pause' : 'CMD:play') }
export function companionSkip(by: number) {
  if (!sock?.connected) return
  const to = Math.max(0, roomTime() + by)
  roomAt = { t: to, at: Date.now() }
  sock.emit('CMD:seek', to)
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
      // is opened on the first Talk, and released again while muted.
      await r.localParticipant.setCameraEnabled(true, { facingMode: 'user' })
    } catch (e) {
      const n = (e as { name?: string })?.name || ''
      log('cam.error', { name: n, msg: errMsg(e) }, 'warn')
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
  pipDetach()
  stopPip('watch')
  micGen++
  stopMicWatch()
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
/** Talk: publish the mic the first time, unmute that same publication after (LiveKit
 *  re-acquires the device it released on mute). Returns false if the mic couldn't open. */
async function micOpen(): Promise<boolean> {
  const lp = lkRoom?.localParticipant
  if (!state.call.on || !lp) return false
  const gen = ++micGen
  const before = lp.getTrackPublication(SRC.mic)?.trackSid
  try {
    await lp.setMicrophoneEnabled(true, audioC())
  } catch (e) {
    const n = (e as { name?: string })?.name
    log('mic.error', { name: n, msg: errMsg(e) }, 'warn')
    setCall({ note: n === 'NotAllowedError' ? 'Mic blocked — allow it in your browser settings.' : n === 'NotFoundError' ? 'No mic found.' : 'Could not access the mic.' })
    return false
  }
  // Muted or left while the permission prompt was up.
  if (gen !== micGen || !state.call.on) { micClose(); return false }
  void enumerate()
  setCall({ note: '' })
  const pub = lp.getTrackPublication(SRC.mic)
  log('mic.published', { sid: pub?.trackSid, first: !before, same: !!before && before === pub?.trackSid })
  watchMic(pub?.track)
  return true
}
/** Mute: the publication stays (same SID, nobody re-subscribes); its track stops, so the
 *  device is released and Bluetooth leaves headset (HFP) mode. */
function micClose() {
  micGen++
  stopMicWatch()
  const lp = lkRoom?.localParticipant
  if (lp?.getTrackPublication(SRC.mic)) void lp.setMicrophoneEnabled(false).catch((e: unknown) => log('mic.mute_failed', { msg: errMsg(e) }, 'warn'))
}

// ── The mic while you talk: what it is, how loud, and is it really sending? ──────
// Logged on open (mic.open), its level for half a minute (mic.level), and a live level for
// the TV's meter. Restarted (mic.restart) on signals that don't depend on anyone talking:
// the track ended, the OS took it (muted for 3 s), exact digital silence for 3 s (a real
// mic always has a noise floor), or no packets sent for 5 s. Some devices only ever give
// silence (a TV remote's mic is kept for the voice assistant): after 10 s with nothing at
// all, one hint.
type MicWatch = { t: MediaStreamTrack; lt: LkTrack; ctx: AudioContext | null; probeT: number; statsT: number; muteT: number; off: () => void }
let mw: MicWatch | null = null
let micLive = 0
export const micLevel = () => micLive
/** Per Talk (reset on unmute): what the recovery has done already, so it never loops. */
let micTalk = { since: 0, heard: false, silentRestarted: false, hinted: false }
let micRestartAt = 0
function watchMic(lt: LkTrack | undefined) {
  stopMicWatch()
  const t = lt?.mediaStreamTrack
  if (!lt || !t) { log('mic.open', { track: false }, 'warn'); return }
  const st = t.getSettings?.() ?? {}
  log('mic.open', {
    label: t.label.slice(0, 80), ready: t.readyState, muted: t.muted, enabled: t.enabled,
    rate: st.sampleRate, ch: st.channelCount, ec: st.echoCancellation, agc: st.autoGainControl, ns: st.noiseSuppression,
    mics: state.mics.map((m) => m.label.slice(0, 40)),
  })
  const w: MicWatch = { t, lt, ctx: null, probeT: 0, statsT: 0, muteT: 0, off: () => { /* */ } }
  const onEnded = () => { log('mic.track_ended', { label: t.label.slice(0, 60) }, 'warn'); void restartMic('ended') }
  const onMute = () => {
    log('mic.track_muted', { label: t.label.slice(0, 60) }, 'warn')
    window.clearTimeout(w.muteT)
    w.muteT = window.setTimeout(() => { if (t.muted) void restartMic('os_mute') }, 3000)
  }
  const onUnmute = () => { log('mic.track_unmuted'); window.clearTimeout(w.muteT) }
  t.addEventListener('ended', onEnded)
  t.addEventListener('mute', onMute)
  t.addEventListener('unmute', onUnmute)
  w.off = () => { t.removeEventListener('ended', onEnded); t.removeEventListener('mute', onMute); t.removeEventListener('unmute', onUnmute) }
  // Sending? packetsSent must keep climbing while unmuted (DTX sends even in silence).
  let lastSent = -1
  w.statsT = window.setInterval(() => {
    const snd = lt.sender
    if (!snd || state.call.muted) return
    void snd.getStats().then((rep) => {
      let sent = -1
      rep.forEach((s: { type?: string; packetsSent?: number }) => { if (s.type === 'outbound-rtp') sent = s.packetsSent ?? -1 })
      if (sent < 0) return
      if (lastSent >= 0 && sent === lastSent) { log('mic.tx_stalled', { sent }, 'warn'); void restartMic('tx_stalled') }
      lastSent = sent
    }).catch(() => { /* */ })
  }, 5000)
  // Level: the TV's meter, mic.level for the first 30 s, exact silence, the 10 s hint.
  try {
    const C = window.AudioContext || window.webkitAudioContext
    if (C) {
      const ctx = new C()
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      ctx.createMediaStreamSource(new MediaStream([t])).connect(an)
      void ctx.resume().catch(() => { /* */ })
      w.ctx = ctx
      const buf = new Float32Array(an.fftSize)
      const until = Date.now() + 30_000
      let lastLog = Date.now(), peak = 0, sum = 0, n = 0, zeroMs = 0
      w.probeT = window.setInterval(() => {
        an.getFloatTimeDomainData(buf)
        let sq = 0, max = 0
        for (const x of buf) { sq += x * x; const a = Math.abs(x); if (a > max) max = a }
        const rms = Math.sqrt(sq / buf.length)
        micLive = Math.min(1, rms * 8)
        peak = Math.max(peak, rms); sum += rms; n++
        if (max > 0) { micTalk.heard = true; zeroMs = 0 } else zeroMs += 100
        if (zeroMs >= 3000 && ctx.state === 'running' && !state.call.muted && !micTalk.silentRestarted) {
          micTalk.silentRestarted = true
          zeroMs = 0
          log('mic.digital_silence', { label: t.label.slice(0, 60) }, 'warn')
          void restartMic('digital_silence')
        }
        if (!micTalk.heard && !micTalk.hinted && micTalk.since && Date.now() - micTalk.since > 10_000 && !state.call.muted) {
          micTalk.hinted = true
          log('mic.silent', { label: t.label.slice(0, 60) }, 'warn')
          toast("We can't hear your mic. Check it isn't muted on the device, or pick another mic in ⚙ Settings.", 'warning')
        }
        if (Date.now() - lastLog >= 5000 && Date.now() < until) {
          log('mic.level', { peak: Math.round(peak * 1000) / 1000, avg: Math.round((sum / n) * 1000) / 1000, ctx: ctx.state, ready: t.readyState, muted: t.muted })
          lastLog = Date.now(); peak = 0; sum = 0; n = 0
        }
      }, 100)
    }
  } catch (e) {
    log('mic.probe_failed', { msg: errMsg(e) }, 'warn')
  }
  mw = w
}
function stopMicWatch() {
  micLive = 0
  const w = mw
  mw = null
  if (!w) return
  w.off()
  window.clearInterval(w.probeT)
  window.clearInterval(w.statsT)
  window.clearTimeout(w.muteT)
  void w.ctx?.close().catch(() => { /* */ })
}
/** Get the mic going again in place (same publication), at most once every 5 s. */
async function restartMic(reason: string) {
  const lp = lkRoom?.localParticipant
  if (!state.call.on || state.call.muted || !lp) return
  if (Date.now() - micRestartAt < 5000) return
  micRestartAt = Date.now()
  const pub = lp.getTrackPublication(SRC.mic)
  const lt = pub?.track
  try {
    if (lt?.restartTrack) await lt.restartTrack(audioC())
    else { await lp.setMicrophoneEnabled(false); await lp.setMicrophoneEnabled(true, audioC()) }
    log('mic.restart', { reason, ok: true, sid: pub?.trackSid, same: lp.getTrackPublication(SRC.mic)?.trackSid === pub?.trackSid })
  } catch (e) {
    const n = (e as { name?: string })?.name
    log('mic.restart', { reason, ok: false, name: n, msg: errMsg(e) }, 'warn')
    // The chosen mic is gone: go back to the default one.
    if ((n === 'NotFoundError' || n === 'OverconstrainedError') && state.micId) { set({ micId: '' }); micRestartAt = 0; void restartMic('fallback_default'); return }
  }
  if (!state.call.muted) watchMic(lp.getTrackPublication(SRC.mic)?.track)
}
/** A device came or went. The mic in use vanished: back to the default, and say which. */
async function devicesChanged() {
  await enumerate()
  log('mic.devices', { mics: state.mics.length })
  if (!state.micId || state.mics.some((m) => m.id === state.micId)) return
  set({ micId: '' })
  log('mic.device_gone', undefined, 'warn')
  const r = lkRoom
  if (!r || !state.call.on) return
  try { await r.switchActiveDevice('audioinput', 'default') } catch { /* */ }
  if (state.call.muted) return
  const label = r.localParticipant.getTrackPublication(SRC.mic)?.track?.mediaStreamTrack.label
  toast(`Your mic changed: now using ${label || 'the default mic'}`, 'info')
  watchMic(r.localParticipant.getTrackPublication(SRC.mic)?.track)
}
/** Pick a mic: switch the published track's device in place (no new track). */
export function setMic(id: string) {
  set({ micId: id })
  log('mic.switch', { muted: state.call.muted })
  const r = lkRoom
  if (!r || !state.call.on) return
  void r.switchActiveDevice('audioinput', id)
    .then(() => { if (!state.call.muted) watchMic(r.localParticipant.getTrackPublication(SRC.mic)?.track) })
    .catch((e: unknown) => log('mic.switch_failed', { msg: errMsg(e) }, 'warn'))
}
export function setSpeaker(id: string) { set({ speakerId: id }); applySink() }
function applySink() {
  type Sinkable = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  const els: Sinkable[] = [...Object.values(audioEls).map((a) => a.el), ...(video ? [video] : [])]
  els.forEach((el) => { el.setSinkId?.(state.speakerId).catch(() => { /* */ }) })
}

export async function toggleMute() {
  if (!state.call.on || !lkRoom) return
  if (!state.call.muted) { log('mic.mute'); micClose(); setCall({ muted: true }); return }
  log('mic.unmute', { micOnly: state.call.micOnly })
  micTalk = { since: Date.now(), heard: false, silentRestarted: false, hinted: false }
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

// ── Peer audio: one <audio> per remote audio track, keyed by its SID ────────────
// Made once when the track is subscribed (LiveKit attach) and removed only when it's
// unsubscribed. Mute, volume and "don't play this one" are properties of the element, so
// nothing about a peer's camera, a mute or a companion ever swaps what it's playing.
type PeerAudio = { el: HTMLMediaElement; track: LkTrack; p: LkParticipant; tries: number }
const audioEls: Record<string, PeerAudio> = {}
let audioBox: HTMLDivElement | null = null
function attachAudio(track: LkTrack, pub: LkPub, p: LkParticipant) {
  const sid = pub.trackSid
  if (audioEls[sid]?.track === track) return
  if (audioEls[sid]) detachAudio(sid)
  if (!audioBox) { audioBox = document.createElement('div'); audioBox.hidden = true; audioBox.dataset.wpAudio = ''; document.body.appendChild(audioBox) }
  const el = track.attach()
  el.autoplay = true
  audioBox.appendChild(el)
  audioEls[sid] = { el, track, p, tries: 0 }
  log('audio.peer', { who: nameOf(clientOf(p)), sid, muted: track.mediaStreamTrack.muted })
  applyPeerAudio()
  if (state.speakerId) applySink()
  playAudio(sid)
}
/** play(), retried on AbortError (a load interrupted it: try again shortly, up to 3 times);
 *  NotAllowedError (no tap yet) goes to the tap-to-enable path. */
function playAudio(sid: string) {
  const a = audioEls[sid]
  if (!a) return
  a.el.play().then(() => {
    if (a.tries) log('audio.retry_ok', { who: nameOf(clientOf(a.p)), tries: a.tries })
    a.tries = 0
  }).catch((e: unknown) => {
    const n = (e as { name?: string })?.name
    if (audioEls[sid] !== a) return
    if (n === 'AbortError' && a.tries < 3) {
      a.tries++
      log('audio.retry', { who: nameOf(clientOf(a.p)), n: a.tries }, 'warn')
      window.setTimeout(() => playAudio(sid), 250 * 2 ** (a.tries - 1))
      return
    }
    log('audio.play_failed', { who: nameOf(clientOf(a.p)), name: n, tries: a.tries }, 'warn')
    if (n === 'NotAllowedError') needGesture()
  })
}
function detachAudio(sid: string) {
  const a = audioEls[sid]
  if (!a) return
  try { a.track.detach(a.el) } catch { /* */ }
  a.el.remove()
  delete audioEls[sid]
}
/** Browsers refuse to start audio without a tap; take the next one anywhere (a key, for a TV remote). */
function needGesture() {
  if (state.needGesture) return
  log('audio.need_gesture', undefined, 'warn')
  set({ needGesture: true })
  const go = () => {
    window.removeEventListener('pointerdown', go, true)
    window.removeEventListener('keydown', go, true)
    set({ needGesture: false })
    void lkRoom?.startAudio().then(() => log('audio.started')).catch((e: unknown) => log('audio.start_failed', { msg: errMsg(e) }, 'warn'))
    Object.keys(audioEls).forEach((sid) => { const a = audioEls[sid]; if (a) { a.tries = 0; playAudio(sid) } })
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
  writeLocal(PREFS_KEY, Object.fromEntries(Object.entries(all).filter(([, p]) => p.v !== 1).map(([kk, p]) => [kk, { v: p.v, m: false }])))
  log('peer.pref', { who: nameOf(id), v: cur.v, m: cur.m })
  set({ prefs: all })
  applyPeerAudio()
}
/** Should this device play a viewer's voice? Never a person's own voice back to them: not
 *  my companion phone's mic on my TV (it sits in front of it: echo), nothing on a companion
 *  phone (the TV plays the call), and not on the older of my two devices (quiet). */
const hearsOf = (id: string) => id !== state.clientId && !state.companion && !(state.quiet && !hearHere)
function applyPeerAudio() {
  for (const a of Object.values(audioEls)) {
    const id = clientOf(a.p)
    const pr = peerPref(id)
    a.el.muted = !hearsOf(id) || state.camMuted || pr.m
    try { a.el.volume = Math.max(0, Math.min(1, state.camVol * pr.v)) } catch { /* iOS */ }
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
  log('cams.mute', { mute: state.camMuted, vol: state.camVol })
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
function pipPeer(): string {
  const withVideo = Object.keys(peers).filter((id) => peerView(id).video)
  const talking = withVideo.find((id) => state.loud[id])
  if (talking) lastTalker = talking
  return (withVideo.includes(lastTalker) ? lastTalker : withVideo[0]) ?? ''
}
function callPipStream(): MediaStream | null {
  const pick = pipPeer()
  return pick ? streamOf(peers[pick]?.stream?.getVideoTracks().find((t) => t.readyState === 'live')) : null
}
// With adaptive stream LiveKit only sends a camera an attached, visible element shows, so
// the floating window's <video> is attached too (LiveKit counts a PiP element as visible).
let pipTrack: LkTrack | null = null
function pipAttach() {
  const el = pipElement('watch')
  const want = el ? peers[pipPeer()]?.cam ?? null : null
  if (pipTrack && pipTrack !== want && el) { try { pipTrack.detach(el) } catch { /* */ } }
  if (want && want !== pipTrack && el) want.attach(el)
  pipTrack = want
}
function pipDetach() {
  const el = pipElement('watch')
  if (pipTrack && el) { try { pipTrack.detach(el) } catch { /* */ } }
  pipTrack = null
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
  const ok = await openPip(callPipStream(), 'watch')
  if (ok) pipAttach()
  return ok
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

// Dev builds only: the multi-client call test drives the call and reads what each page
// hears from here. Not in production builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__watchDebug = {
    snap: () => snap(), state: () => state, joinCall, toggleMute, leaveCall,
    identity: () => lkRoom?.localParticipant.identity ?? '',
    micSid: () => lkRoom?.localParticipant.getTrackPublication(SRC.mic)?.trackSid ?? '',
    remote: () => [...(lkRoom?.remoteParticipants.values() ?? [])].map((p) => ({ id: p.identity, client: clientOf(p), mic: p.getTrackPublication(SRC.mic)?.trackSid ?? '', muted: !!p.getTrackPublication(SRC.mic)?.isMuted })),
    logs: (n = 80) => devRing.slice(-n).map((e) => `${e.type} ${JSON.stringify(e.data ?? '')}`.slice(0, 160)),
    txStats: async () => { const r = await mw?.lt.sender?.getStats(); const out: unknown[] = []; r?.forEach((x: { type?: string; packetsSent?: number }) => { if (x.type === 'outbound-rtp') out.push(x.packetsSent) }); return out },
    // Break things on purpose: the mic stops sending (still unmuted), or its track ends.
    breakMic: () => mw?.lt.sender?.replaceTrack(null),
    endMic: () => { const t = mw?.t; t?.stop(); t?.dispatchEvent(new Event('ended')) },
  }
}
