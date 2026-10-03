// Picture in picture for calls (Huddle, the Watch Party call): one floating window that
// keeps showing a live camera (the person talking) while you're in another app.
//
// It's a hidden <video> whose srcObject follows whoever the call says is talking. A
// single live stream is what phones can float and keep playing in the background; a
// grid painted on a canvas would freeze there (hidden pages get throttled).
//
// Opening it needs a tap (Pop out). Leaving the app can open it by itself where the
// browser allows: Chrome's "enterpictureinpicture" media-session action (registered by
// the call while it's live) and WebKit's autopictureinpicture attribute (the iOS app).
type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitPresentationMode?: string
}

export type PipOwner = 'huddle' | 'watch'
let el: WebkitVideo | null = null
let current: MediaStream | null = null
let owner: PipOwner | null = null   // the call the window belongs to; the other leaves it alone

function video(): WebkitVideo {
  if (el) return el
  const v = document.createElement('video') as WebkitVideo
  v.muted = true          // the call's sound plays through its own audio elements
  v.playsInline = true
  v.autoplay = true
  v.setAttribute('autopictureinpicture', '')
  v.setAttribute('aria-hidden', 'true')
  // On the page but out of sight: PiP needs a real, attached, playing video.
  Object.assign(v.style, { position: 'fixed', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none', bottom: '0', right: '0' })
  document.body.appendChild(v)
  el = v
  return v
}

export function pipSupported(): boolean {
  if (typeof document === 'undefined') return false
  if (document.pictureInPictureEnabled) return true
  const v = document.createElement('video') as WebkitVideo
  return !!v.webkitSupportsPresentationMode?.('picture-in-picture')
}

export function inPip(): boolean {
  return !!el && (document.pictureInPictureElement === el || el.webkitPresentationMode === 'picture-in-picture')
}

/** Point the floating window at this stream (only the call that opened it). */
export function setPipStream(stream: MediaStream | null, who: PipOwner) {
  if (who !== owner || stream === current) return
  current = stream
  if (!el) return
  el.srcObject = stream
  if (stream) void el.play().catch(() => { /* muted autoplay; ignore the odd refusal */ })
}

/** Open the floating window on this stream. Needs a tap, or the browser's own "left the app". */
export async function openPip(stream: MediaStream | null, who: PipOwner): Promise<boolean> {
  if (!stream) return false
  const v = video()
  owner = who
  current = null
  setPipStream(stream, who)
  try {
    if (v.readyState < 1) await new Promise((res) => v.addEventListener('loadedmetadata', res, { once: true }))
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
      if (document.pictureInPictureElement !== v) await v.requestPictureInPicture()
      return true
    }
    if (v.webkitSupportsPresentationMode?.('picture-in-picture')) {
      v.webkitSetPresentationMode?.('picture-in-picture')
      return true
    }
  } catch { /* not allowed right now (no tap, or the browser said no) */ }
  return false
}

export function closePip() {
  if (!el) return
  if (document.pictureInPictureElement === el) void document.exitPictureInPicture().catch(() => {})
  else if (el.webkitPresentationMode === 'picture-in-picture') el.webkitSetPresentationMode?.('inline')
}

/** That call ended: close its window and leave nothing behind (another call's stays). */
export function stopPip(who: PipOwner) {
  if (owner !== who) return
  closePip()
  owner = null
  current = null
  if (el) { el.srcObject = null; el.remove(); el = null }
}

/** One MediaStream per track, so switching speakers doesn't rebuild streams each render. */
const streams = new WeakMap<MediaStreamTrack, MediaStream>()
export function streamOf(track: MediaStreamTrack | null | undefined): MediaStream | null {
  if (!track || track.readyState === 'ended') return null
  let s = streams.get(track)
  if (!s) { s = new MediaStream([track]); streams.set(track, s) }
  return s
}
