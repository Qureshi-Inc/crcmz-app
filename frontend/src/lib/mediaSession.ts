// One lock screen, three things that can play: Slap music, a Watch Party video
// and a Huddle call. The page has a single navigator.mediaSession, so each
// activity claims it when it starts. The latest claim wins, and when that
// activity stops, the one before it gets the lock screen back.
export type Owner = 'slap' | 'watch' | 'huddle'

// The call actions (togglemicrophone…) are newer than the DOM typings.
type Action = MediaSessionAction | 'togglemicrophone' | 'togglecamera' | 'hangup' | 'enterpictureinpicture'
export type Handlers = Partial<Record<Action, MediaSessionActionHandler>>

export type Spec = {
  title: string
  artist?: string
  album?: string
  /** Artwork URLs, small to large: a number is a square, a string is "WxH". The app icon when empty. */
  art?: { src: string; size: number | string }[]
  playing: boolean
  handlers: Handlers
  /** Seconds. Leave out for a call or a live stream: the OS then shows no scrubber. */
  position?: { at: number; duration: number } | null
  mic?: boolean
  camera?: boolean
}

const ALL: Action[] = ['play', 'pause', 'stop', 'nexttrack', 'previoustrack', 'seekto', 'seekbackward', 'seekforward',
  'togglemicrophone', 'togglecamera', 'hangup', 'enterpictureinpicture']
const FALLBACK_ART = [{ src: '/app/pwa/icon-192.png', size: 192 }, { src: '/app/pwa/icon-512.png', size: 512 }]

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator
const stack: Owner[] = []            // most recent last
const specs = new Map<Owner, Spec>()
let shown: Owner | null = null
let shownMeta = ''
let shownHandlers: Handlers | null = null
let shownPos: { at: number; duration: number; when: number; playing: boolean } | null = null

export const owner = (): Owner | null => stack[stack.length - 1] ?? null
export const holds = (o: Owner) => specs.has(o)

/** Take the lock screen (or move back on top of it) with this card. */
export function claim(o: Owner, spec: Spec) {
  const i = stack.indexOf(o)
  if (i >= 0) stack.splice(i, 1)
  stack.push(o)
  specs.set(o, spec)
  apply()
}

/** Refresh what `o` shows. Cheap to call often: unchanged parts are skipped. */
export function update(o: Owner, spec: Spec) {
  if (!specs.has(o)) return
  specs.set(o, spec)
  if (owner() === o) apply()
}

/** `o` stopped: hand the lock screen to whoever had it before. */
export function release(o: Owner) {
  if (!specs.delete(o)) return
  stack.splice(stack.indexOf(o), 1)
  apply()
}

function apply() {
  if (!supported()) return
  const ms = navigator.mediaSession
  const top = owner()
  const spec = top ? specs.get(top)! : null
  if (top !== shown) {
    // A new owner starts clean: no scrubber left over from the last one.
    shownMeta = ''; shownHandlers = null; shown = top
    if (shownPos) { shownPos = null; try { ms.setPositionState() } catch { /* */ } }
  }
  if (!spec) {
    ms.metadata = null
    ms.playbackState = 'none'
    for (const a of ALL) setHandler(a, null)
    try { ms.setPositionState() } catch { /* */ }
    return
  }

  const art = spec.art?.length ? spec.art : FALLBACK_ART
  const metaKey = JSON.stringify([spec.title, spec.artist, spec.album, art])
  if (metaKey !== shownMeta) {
    shownMeta = metaKey
    try {
      ms.metadata = new MediaMetadata({
        title: spec.title, artist: spec.artist ?? '', album: spec.album ?? '',
        artwork: art.map((a) => ({ src: a.src, sizes: typeof a.size === 'string' ? a.size : `${a.size}x${a.size}`, type: a.src.endsWith('.png') ? 'image/png' : 'image/jpeg' })),
      })
    } catch { /* older browsers */ }
  }
  ms.playbackState = spec.playing ? 'playing' : 'paused'

  if (spec.handlers !== shownHandlers) {
    shownHandlers = spec.handlers
    for (const a of ALL) setHandler(a, spec.handlers[a] ?? null)
  }

  setPosition(spec)
  const m = ms as MediaSession & { setMicrophoneActive?: (on: boolean) => void; setCameraActive?: (on: boolean) => void }
  if (spec.mic !== undefined) { try { m.setMicrophoneActive?.(spec.mic) } catch { /* */ } }
  if (spec.camera !== undefined) { try { m.setCameraActive?.(spec.camera) } catch { /* */ } }
}

function setHandler(a: Action, fn: MediaSessionActionHandler | null) {
  try { navigator.mediaSession.setActionHandler(a as MediaSessionAction, fn) } catch { /* unsupported action */ }
}

/** The OS runs the scrubber on its own while playing, so only correct it when it would be off. */
function setPosition(spec: Spec) {
  const ms = navigator.mediaSession
  const p = spec.position
  if (!p || !Number.isFinite(p.duration) || p.duration <= 0) {
    if (shownPos) { shownPos = null; try { ms.setPositionState() } catch { /* */ } }
    return
  }
  const now = performance.now()
  if (shownPos && shownPos.duration === p.duration && shownPos.playing === spec.playing) {
    const guess = shownPos.at + (spec.playing ? (now - shownPos.when) / 1000 : 0)
    if (Math.abs(guess - p.at) < 1.5) return
  }
  const at = Math.max(0, Math.min(p.at, p.duration))
  shownPos = { at, duration: p.duration, when: now, playing: spec.playing }
  try { ms.setPositionState({ duration: p.duration, position: at, playbackRate: 1 }) } catch { /* */ }
}
