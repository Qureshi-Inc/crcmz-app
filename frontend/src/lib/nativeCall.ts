// Calls in the iOS app run natively (ios/CRCMZ/NativeCall.swift): the page still decides
// who you are and which room (it fetches the LiveKit token), then hands the call to the
// app, which shows it full screen with picture in picture and keeps it going in the
// background. Outside the iOS app none of this is used.
export type CallKind = 'huddle' | 'watch'
export type ToNative =
  | { type: 'start'; kind: CallKind; url: string; token: string; title: string; room: string; publish: boolean; camera: boolean; mic: boolean }
  | { type: 'show'; kind: CallKind }
  | { type: 'join'; kind: CallKind }
  | { type: 'end'; kind: CallKind }
  /** Publish on the call's data channel (Huddle: hands, reactions, transcript lines). */
  | { type: 'data'; kind: CallKind; payload: Record<string, unknown> }
  /** Huddle: the app records its own mic for the transcript (on) or stops (off). */
  | { type: 'transcript'; kind: CallKind; on: boolean }

type Handler = { postMessage(m: unknown): void }
const handler = (): Handler | undefined =>
  (window as unknown as { webkit?: { messageHandlers?: { crcmzCall?: Handler } } }).webkit?.messageHandlers?.crcmzCall

/** In the iOS app, with native calls. */
export const nativeCalls = () => !!handler()

export function toNative(m: ToNative) { handler()?.postMessage(m) }

declare global {
  interface Window {
    __crcmzCallEnded?: (kind: CallKind) => void
    /** The app passes on what arrives on the call's data channel, and its own transcript lines. */
    __crcmzCallData?: (kind: CallKind, payload: Record<string, unknown>, from: string, fromId: string) => void
  }
}
const data = new Set<(kind: CallKind, payload: Record<string, unknown>, from: string, fromId: string) => void>()
export function onNativeData(fn: (kind: CallKind, payload: Record<string, unknown>, from: string, fromId: string) => void) {
  data.add(fn)
  return () => { data.delete(fn) }
}
window.__crcmzCallData = (kind, payload, from, fromId) => { data.forEach((f) => f(kind, payload, from, fromId)) }
const ended = new Set<(kind: CallKind) => void>()
/** The app hung up (Leave, or the call dropped): the page goes back to its join screen. */
export function onNativeEnded(fn: (kind: CallKind) => void) {
  ended.add(fn)
  return () => { ended.delete(fn) }
}
window.__crcmzCallEnded = (kind) => { ended.forEach((f) => f(kind)) }
