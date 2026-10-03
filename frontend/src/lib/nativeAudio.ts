// Slap in the iOS app plays through the app's own audio player (ios/CRCMZ/NativeAudio.swift),
// not a page <audio>: iOS suspends a page in the background, so a page player stops at
// the end of a song with the phone locked. The app's player keeps going: it knows the
// next track and moves on by itself, and it drives the lock screen, Control Center and
// CarPlay's Now Playing.
//
// To the Slap player (features/slap/player.ts) this looks like an HTMLAudioElement: the
// same few properties, methods and events. Outside the iOS app none of this is used.
type Handler = { postMessage(m: unknown): void }
const handler = (): Handler | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { crcmzAudio?: Handler } } }).webkit?.messageHandlers?.crcmzAudio

export const nativeAudio = () => !!handler()
const post = (m: Record<string, unknown>) => handler()?.postMessage(m)
const abs = (u: string) => new URL(u, location.origin).href

export type NowPlaying = { title: string; artist: string; album: string; art: string | null }
export type Remote = 'play' | 'pause' | 'nexttrack' | 'previoustrack' | 'seekto'

type FromNative = {
  event: string
  time?: number
  duration?: number
  paused?: boolean
  action?: Remote
}

class NativeAudioElement extends EventTarget {
  preload = 'auto'
  private url = ''
  private t = 0
  private at = 0              // performance.now() of the last report, to run the clock between them
  private dur = Number.NaN
  private isPaused = true
  private ready = 0

  constructor() {
    super()
    window.__crcmzAudio = (m: FromNative) => this.fromNative(m)
  }

  get src() { return this.url }
  set src(v: string) {
    const url = v ? abs(v) : ''
    if (url === this.url) return
    this.url = url
    this.t = 0
    this.dur = Number.NaN
    this.ready = 0
    post(url ? { type: 'src', url } : { type: 'stop' })
  }
  getAttribute(name: string) { return name === 'src' && this.url ? this.url : null }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  load() { if (!this.url) post({ type: 'stop' }) }

  get currentTime() {
    return this.isPaused ? this.t : this.t + (performance.now() - this.at) / 1000
  }
  set currentTime(v: number) {
    this.t = v
    this.at = performance.now()
    post({ type: 'seek', time: v })
  }
  get duration() { return this.dur }
  get paused() { return this.isPaused }
  get readyState() { return this.ready }

  play(): Promise<void> {
    if (this.isPaused) { this.isPaused = false; this.at = performance.now(); this.fire('play') }
    post({ type: 'play' })
    return Promise.resolve()
  }
  pause() {
    if (!this.isPaused) { this.t = this.currentTime; this.isPaused = true; this.fire('pause') }
    post({ type: 'pause' })
  }

  private fire(type: string) { this.dispatchEvent(new Event(type)) }

  private fromNative(m: FromNative) {
    if (m.time != null) { this.t = m.time; this.at = performance.now() }
    if (m.duration != null && m.duration > 0 && m.duration !== this.dur) { this.dur = m.duration; this.fire('durationchange') }
    switch (m.event) {
      case 'loadedmetadata': this.ready = 4; this.fire('loadedmetadata'); break
      case 'playing': if (this.isPaused) { this.isPaused = false; this.fire('play') } this.fire('playing'); break
      case 'waiting': this.fire('waiting'); break
      case 'play': if (this.isPaused) { this.isPaused = false; this.fire('play') } break
      case 'pause': if (!this.isPaused) { this.isPaused = true; this.fire('pause') } break
      case 'timeupdate': this.fire('timeupdate'); break
      case 'seeked': this.fire('seeked'); break
      // The app already moved on to the next track it was told about; the player catches up
      // (and sets the same src, which the app ignores).
      case 'ended': this.isPaused = true; this.fire('ended'); break
      case 'advanced': if (m.paused === false) this.isPaused = false; break
      case 'error': this.fire('error'); break
      case 'remote': if (m.action) remote?.(m.action, m.time); break
    }
  }
}

declare global {
  interface Window { __crcmzAudio?: (m: FromNative) => void }
}

let remote: ((a: Remote, time?: number) => void) | null = null

/** The Slap player's element in the iOS app. */
export function nativeAudioElement(onRemote: (a: Remote, time?: number) => void): HTMLAudioElement {
  remote = onRemote
  return new NativeAudioElement() as unknown as HTMLAudioElement
}

/** What's playing and what comes next, so the app can show it and move on by itself. */
let lastMeta = ''
export function nativeNowPlaying(now: NowPlaying | null, next: { url: string } | null, together: boolean) {
  const m = { type: 'meta', now: now && { ...now, art: now.art ? abs(now.art) : null }, next: next ? abs(next.url) : null, together }
  const k = JSON.stringify(m)
  if (k === lastMeta) return
  lastMeta = k
  post(m)
}
