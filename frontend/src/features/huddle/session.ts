// The Huddle session: a LiveKit room, the pre-join preview, the AI helper and the
// live transcript. It lives outside React (like Watch's session), so leaving
// /huddle keeps the call going and the call bar brings you back. A port of the
// classic client (server.py, huddle*), same endpoints:
//   POST /api/huddle/token {room} → {token, url, room}; the LiveKit client comes from jsDelivr
//   POST /api/huddle/ai {messages} → {message: {content}}
//   POST /api/huddle/transcribe (multipart file) → {text}
// Remote audio plays through <audio> elements owned here, so the page can unmount
// without cutting anyone off. Video tiles attach and detach their own tracks.
// Each person transcribes their own mic and shares the lines over the room's data
// channel, so everyone's AI sees the whole conversation and everyone sees the
// "Transcript on" chip while anyone records.
import { useSyncExternalStore } from 'react'
import { toast } from '../../components/toast'
import { muteOtherCalls, registerCall } from '../../lib/calls'
import { ApiError, request } from '../../lib/http'
import { nativeCalls, onNativeData, onNativeEnded, toNative } from '../../lib/nativeCall'
import { openPip, pipSupported, setPipStream, stopPip, streamOf } from '../../lib/pip'
import * as lockScreen from '../../lib/mediaSession'
import { markSignedOut } from '../../lib/session'
import { loadScript } from '../../lib/watch'

const LK_SRC = 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js'
const TOPIC = 'crcmz-huddle'
const CHUNK_MS = 6000

// ── The slice of livekit-client this file uses ──────────────────────────────
export type LkTrack = {
  kind: 'audio' | 'video'; source: string; sid?: string; isMuted: boolean
  mediaStreamTrack: MediaStreamTrack
  attach(el?: HTMLMediaElement): HTMLMediaElement
  detach(el?: HTMLMediaElement): HTMLMediaElement[] | HTMLMediaElement
  replaceTrack?(t: MediaStreamTrack, userProvided?: boolean): Promise<unknown>
}
type LkPub = { kind: 'audio' | 'video'; source: string; trackSid: string; isMuted: boolean; isSubscribed?: boolean; track?: LkTrack }
type LkParticipant = {
  identity: string; name?: string; isSpeaking: boolean; isLocal?: boolean
  trackPublications: Map<string, LkPub>
  getTrackPublication(source: string): LkPub | undefined
}
type LkLocal = LkParticipant & {
  isMicrophoneEnabled: boolean; isCameraEnabled: boolean; isScreenShareEnabled: boolean
  setMicrophoneEnabled(on: boolean, opts?: MediaTrackConstraints): Promise<unknown>
  setCameraEnabled(on: boolean, opts?: MediaTrackConstraints): Promise<unknown>
  setScreenShareEnabled(on: boolean): Promise<unknown>
  publishData(data: Uint8Array, opts: { reliable?: boolean; topic?: string }): Promise<void>
  unpublishTrack(t: LkTrack, stop?: boolean): Promise<unknown>
}
type LkRoom = {
  name?: string; state?: string; canPlaybackAudio?: boolean
  localParticipant: LkLocal
  remoteParticipants: Map<string, LkParticipant>
  on(ev: string, fn: (...a: never[]) => void): LkRoom
  connect(url: string, token: string): Promise<void>
  disconnect(): Promise<void>
  startAudio(): Promise<void>
}
type LkNs = {
  Room: new (o: Record<string, unknown>) => LkRoom
  RoomEvent: Record<string, string>
  Track: { Source: Record<string, string> }
  DisconnectReason?: Record<string, number>
}
declare global { interface Window { LivekitClient?: LkNs } }

const SRC = { cam: 'camera', mic: 'microphone', screen: 'screen_share', screenAudio: 'screen_share_audio' } as const

export type Phase = 'pre' | 'joining' | 'live' | 'reconnecting'
export type Preview = 'off' | 'starting' | 'on' | 'blocked' | 'none'
export type Device = { id: string; label: string }
/** One thing on the stage: a person's camera, or a screen they share. */
export type Tile = {
  key: string; pid: string; name: string; local: boolean; screen: boolean
  speaking: boolean; micOn: boolean; video: boolean
  /** Their hand is up. */
  hand: boolean
}
/** An emoji someone just sent; it floats up for a few seconds. */
export type Reaction = { id: number; name: string; e: string }
export const REACTIONS = ['👍', '😂', '🔥', '👏', '❤️', '😮'] as const
export type AiMsg = { role: 'user' | 'assistant' | 'note' | 'error'; text: string; retry?: AiRequest }
type AiRequest = { kind: 'ask'; text: string } | { kind: 'notes' }
export type Line = { name: string; text: string; ts: number }

export type HuddleState = {
  phase: Phase
  /** The room field before joining; the joined room after. */
  room: string
  /** Pre-join message: why the last join failed, or that the call dropped. */
  error: '' | 'config' | 'signin' | 'connect' | 'dropped'
  errorText: string
  preview: Preview
  mics: Device[]
  cams: Device[]
  micId: string
  camId: string
  mic: boolean
  cam: boolean
  share: boolean
  blur: boolean
  /** The camera couldn't start in the call: say so beside the controls. */
  note: string
  tiles: Tile[]
  /** Bumped on any track change; tiles re-attach on it. */
  tracks: number
  layout: 'spotlight' | 'grid'
  pinned: string
  speaker: string
  audioBlocked: boolean
  aiOpen: boolean
  aiBusy: boolean
  aiLog: AiMsg[]
  /** 401 from the AI or the transcriber while the call itself carries on. */
  aiSignedOut: boolean
  transcribing: boolean
  /** Everyone recording a transcript right now, you included. */
  recorders: string[]
  lines: Line[]
  /** In the iOS app the call runs natively: the room it's in, '' when none. */
  nativeRoom: string
  /** Your hand is up. */
  hand: boolean
  /** Everyone else with a hand up, by name (oldest first). */
  hands: string[]
  reactions: Reaction[]
  /** Start the transcript (for everyone) as soon as you join; saved notes come of it. */
  autoTranscribe: boolean
}

let state: HuddleState = {
  phase: 'pre', room: 'crcmz', error: '', errorText: '', preview: 'off', mics: [], cams: [], micId: '', camId: '',
  mic: false, cam: false, share: false, blur: false, note: '', tiles: [], tracks: 0, layout: 'spotlight', pinned: '', speaker: '',
  audioBlocked: false, aiOpen: false, aiBusy: false, aiLog: [], aiSignedOut: false, transcribing: false, recorders: [], lines: [], nativeRoom: '',
  hand: false, hands: [], reactions: [], autoTranscribe: readAuto(),
}
function readAuto(): boolean { try { return localStorage.getItem('crcmz.huddle.transcribe') === '1' } catch { return false } }
export function setAutoTranscribe(on: boolean) {
  try { localStorage.setItem('crcmz.huddle.transcribe', on ? '1' : '0') } catch { /* */ }
  set({ autoTranscribe: on })
}
const listeners = new Set<() => void>()
function set(patch: Partial<HuddleState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
  syncLockScreen()
  queueSave()
  sendAiToNative()
}

// The call screen in the apps has its own AI chat: it shows this page's chat, and asks
// through the page (ai_ask below), so there's one history wherever you open it.
let aiSent = ''
function sendAiToNative() {
  if (!state.nativeRoom) { aiSent = ''; return }
  const m = {
    type: 'ai' as const, kind: 'huddle' as const, busy: state.aiBusy, transcribing: state.transcribing,
    log: state.aiLog.slice(-80).map((x) => ({ role: x.role, text: x.text })),
  }
  const key = JSON.stringify(m)
  if (key === aiSent) return
  aiSent = key
  toNative(m)
}
export function getHuddle(): HuddleState { return state }
export function useHuddle(): HuddleState {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => state)
}

let room: LkRoom | null = null
let lk: LkNs | null = null
let previewStream: MediaStream | null = null
let previewWanted = false
const audioEls = new Map<string, HTMLMediaElement>()
let audioBox: HTMLDivElement | null = null
const remoteRecorders = new Map<string, string>()

export const canShare = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
export const inCall = () => state.phase === 'live' || state.phase === 'reconnecting'

registerCall('huddle', { label: 'Huddle', live: () => inCall() && state.mic, mute: () => void toggleMic() })

// ── Pre-join ────────────────────────────────────────────────────────────────
export function setRoomName(v: string) { set({ room: v }) }
export function setMicId(id: string) { set({ micId: id }) }
export function setCamId(id: string) {
  set({ camId: id })
  if (previewWanted && !room) void startPreview()
}

/** The camera preview on the pre-join screen. Fetching LiveKit starts here too, so Join is quick. */
export async function startPreview() {
  previewWanted = true
  void loadLk().catch(() => { /* Join reports it */ })
  if (room) return
  if (!navigator.mediaDevices?.getUserMedia) { set({ preview: 'none' }); return }
  stopTracks(previewStream)
  previewStream = null
  set({ preview: 'starting' })
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: state.camId ? { deviceId: { exact: state.camId } } : true, audio: false })
    // Left the page (or joined) while the camera was starting.
    if (!previewWanted || room) { stopTracks(s); return }
    previewStream = s
    set({ preview: 'on' })
  } catch (e) {
    const n = (e as { name?: string })?.name || ''
    set({ preview: n === 'NotAllowedError' || n === 'SecurityError' ? 'blocked' : 'none' })
  }
  void enumerate()
}
export function stopPreview() {
  previewWanted = false
  stopTracks(previewStream)
  previewStream = null
  if (state.preview !== 'blocked' && state.preview !== 'none') set({ preview: 'off' })
}
export const previewMedia = () => previewStream

async function enumerate() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    const list = (kind: MediaDeviceKind, word: string) =>
      devs.filter((d) => d.kind === kind && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }))
    set({ mics: list('audioinput', 'Mic'), cams: list('videoinput', 'Camera') })
  } catch { /* */ }
}

function stopTracks(s: MediaStream | null) { s?.getTracks().forEach((t) => t.stop()) }

async function loadLk(): Promise<LkNs> {
  if (lk) return lk
  await loadScript(LK_SRC)
  if (!window.LivekitClient) throw new Error('LiveKit did not load')
  lk = window.LivekitClient
  return lk
}

// ── Join and leave ──────────────────────────────────────────────────────────
export async function join({ camera = true }: { camera?: boolean } = {}) {
  if (state.phase !== 'pre') return
  const wanted = state.room.trim() || 'crcmz'
  set({ phase: 'joining', error: '', errorText: '', note: '' })
  stopTracks(previewStream)
  previewStream = null
  if (nativeCalls()) { await joinNative(wanted, camera); return }
  let r: LkRoom | null = null
  try {
    const ns = await loadLk()
    const t = await request<{ token: string; url: string; room: string }>('/api/huddle/token', { body: { room: wanted }, quiet401: true })
    r = new ns.Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: false })
    wire(r, ns)
    room = r
    await r.connect(t.url, t.token)
    set({ phase: 'live', room: t.room, layout: 'spotlight', pinned: '', speaker: r.localParticipant.identity, audioBlocked: r.canPlaybackAudio === false })
    try {
      await r.localParticipant.setMicrophoneEnabled(true, state.micId ? { deviceId: { exact: state.micId } } : undefined)
    } catch { set({ note: "Couldn't start your mic. Check your browser settings." }) }
    if (camera) {
      try {
        await r.localParticipant.setCameraEnabled(true, state.camId ? { deviceId: { exact: state.camId } } : undefined)
      } catch (e) {
        set({ note: (e as { name?: string })?.name === 'NotAllowedError' ? 'Camera blocked: allow it in your browser settings.' : "Couldn't start your camera." })
      }
    }
    // Ask the room to repeat who has a hand up / is recording: a message sent while we
    // were still connecting would otherwise be missed.
    void sendData({ t: 'sync' })
    const others = muteOtherCalls('huddle')
    if (others.length && state.mic) toast(`Muted your ${others.join(' and ')} mic while you're in Huddle`, 'info')
    sync()
    if (state.autoTranscribe && !state.transcribing) toggleTranscript({ open: false })
  } catch (e) {
    if (r) { try { await r.disconnect() } catch { /* */ } }
    room = null
    if (e instanceof ApiError && e.status === 401) { markSignedOut(); set({ phase: 'pre', error: 'signin' }) }
    else if (e instanceof ApiError && e.status === 503) set({ phase: 'pre', error: 'config' })
    else set({ phase: 'pre', error: 'connect', errorText: e instanceof ApiError ? e.detail : '' })
    if (previewWanted) void startPreview()
  }
}

/** The iOS app: fetch the token here, then the app runs the call (full screen, PiP). */
async function joinNative(wanted: string, camera: boolean) {
  try {
    const t = await request<{ token: string; url: string; room: string }>('/api/huddle/token', { body: { room: wanted }, quiet401: true })
    muteOtherCalls('huddle')
    toNative({ type: 'start', kind: 'huddle', url: t.url, token: t.token, room: t.room, title: `Huddle · ${t.room}`, publish: true, camera, mic: true })
    set({ phase: 'pre', nativeRoom: t.room })
    if (state.autoTranscribe) nativeTranscriptOn()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { markSignedOut(); set({ phase: 'pre', error: 'signin' }) }
    else if (e instanceof ApiError && e.status === 503) set({ phase: 'pre', error: 'config' })
    else set({ phase: 'pre', error: 'connect', errorText: e instanceof ApiError ? e.detail : '' })
  }
}
export const showNativeCall = () => toNative({ type: 'show', kind: 'huddle' })
onNativeEnded((kind) => {
  if (kind !== 'huddle') return
  remoteRecorders.clear()
  remoteHands.clear()
  set({ nativeRoom: '', transcribing: false, recorders: [], hand: false, hands: [], reactions: [] })
  if (previewWanted) void startPreview()
})

export async function leave() {
  const r = room
  if (!r) return
  room = null
  stopTranscript(false)
  stopBlur()
  try { await r.disconnect() } catch { /* */ }
  teardown()
  set({ phase: 'pre', error: '', errorText: '' })
  if (previewWanted) void startPreview()
}

function teardown() {
  audioEls.forEach((el) => el.remove())
  audioEls.clear()
  remoteRecorders.clear()
  stopRecorder()
  stopBlur()
  set({
    tiles: [], mic: false, cam: false, share: false, blur: false, note: '', pinned: '', speaker: '', audioBlocked: false,
    aiOpen: false, aiBusy: false, aiLog: [], aiSignedOut: false, transcribing: false, recorders: [], lines: [],
    hand: false, hands: [], reactions: [],
  })
  remoteHands.clear()
}

function wire(r: LkRoom, ns: LkNs) {
  const E = ns.RoomEvent
  const on = (ev: string | undefined, fn: (...a: never[]) => void) => { if (ev) r.on(ev, fn) }
  on(E.TrackSubscribed, ((track: LkTrack, _pub: LkPub, p: LkParticipant) => {
    if (track.kind === 'audio') playAudio(p.identity + ':' + track.source, track)
    sync()
  }) as never)
  on(E.TrackUnsubscribed, ((track: LkTrack, _pub: LkPub, p: LkParticipant) => {
    const k = p.identity + ':' + track.source
    const el = audioEls.get(k)
    if (el) { track.detach(el); el.remove(); audioEls.delete(k) }
    sync()
  }) as never)
  for (const ev of [E.ParticipantConnected, E.LocalTrackPublished, E.LocalTrackUnpublished, E.TrackMuted, E.TrackUnmuted, E.TrackPublished, E.TrackUnpublished]) on(ev, () => sync())
  on(E.ParticipantConnected, () => {
    if (state.transcribing) void sendData({ t: 'rec', on: true })
    if (state.hand) void sendData({ t: 'hand', up: true })
  })
  on(E.ParticipantDisconnected, ((p: LkParticipant) => {
    remoteRecorders.delete(p.identity)
    remoteHands.delete(p.identity)
    if (state.pinned === p.identity) set({ pinned: '' })
    sync()
  }) as never)
  on(E.ActiveSpeakersChanged, ((speakers: LkParticipant[]) => {
    const top = speakers[0]
    if (top) set({ speaker: top.identity })
    sync()
  }) as never)
  on(E.DataReceived, ((payload: Uint8Array, p?: LkParticipant, _kind?: unknown, topic?: string) => {
    if (topic && topic !== TOPIC) return
    let m: Record<string, unknown>
    try { m = JSON.parse(new TextDecoder().decode(payload)) } catch { return }
    if (!p) return
    onData(m, nameOf(p), p.identity)
  }) as never)
  on(E.AudioPlaybackStatusChanged, () => set({ audioBlocked: r.canPlaybackAudio === false }))
  on(E.Reconnecting, () => { if (room === r) set({ phase: 'reconnecting' }) })
  on(E.SignalReconnecting, () => { if (room === r) set({ phase: 'reconnecting' }) })
  on(E.Reconnected, () => { if (room === r) { set({ phase: 'live' }); sync() } })
  on(E.Disconnected, ((reason?: number) => {
    if (room !== r) return
    room = null
    teardown()
    const self = ns.DisconnectReason?.CLIENT_INITIATED
    set({ phase: 'pre', error: reason !== undefined && reason === self ? '' : 'dropped', errorText: '' })
    if (previewWanted) void startPreview()
  }) as never)
}

function playAudio(key: string, track: LkTrack) {
  if (!audioBox) {
    audioBox = document.createElement('div')
    audioBox.hidden = true
    audioBox.dataset.huddleAudio = ''
    document.body.appendChild(audioBox)
  }
  audioEls.get(key)?.remove()
  const el = track.attach()
  el.autoplay = true
  audioBox.appendChild(el)
  audioEls.set(key, el)
}

/** Some browsers hold remote audio until a tap. */
export function startAudio() {
  void room?.startAudio().then(() => set({ audioBlocked: false })).catch(() => { /* */ })
}

const nameOf = (p: LkParticipant) => p.name || p.identity

/** Re-reads the room into state: the tile list, the control states, who records. */
function sync() {
  const r = room
  if (!r) return
  const lp = r.localParticipant
  const people: [LkParticipant, boolean][] = [[lp, true], ...[...r.remoteParticipants.values()].map((p) => [p, false] as [LkParticipant, boolean])]
  const tiles: Tile[] = []
  for (const [p, local] of people) {
    const mic = p.getTrackPublication(SRC.mic)
    const cam = p.getTrackPublication(SRC.cam)
    const base = { pid: p.identity, name: nameOf(p), local, speaking: p.isSpeaking, micOn: !!mic && !mic.isMuted,
      hand: local ? state.hand : remoteHands.has(p.identity) }
    tiles.push({ ...base, key: p.identity, screen: false, video: !!cam?.track && !cam.isMuted })
    const scr = p.getTrackPublication(SRC.screen)
    if (scr?.track) tiles.push({ ...base, key: p.identity + ':screen', screen: true, video: true, speaking: false })
  }
  const recorders = [...remoteRecorders.values()]
  if (state.transcribing) recorders.unshift(nameOf(lp))
  set({
    tiles, tracks: state.tracks + 1, recorders, hands: [...remoteHands.values()],
    mic: lp.isMicrophoneEnabled, cam: lp.isCameraEnabled, share: lp.isScreenShareEnabled,
  })
}

/** The live track for a tile (null when it has none, e.g. the camera is off). */
export function tileTrack(t: Tile): LkTrack | null {
  const r = room
  if (!r) return null
  const p = t.local ? r.localParticipant : r.remoteParticipants.get(t.pid)
  const pub = p?.getTrackPublication(t.screen ? SRC.screen : SRC.cam)
  return pub?.track && !pub.isMuted ? pub.track : null
}

/** Who fills the spotlight: a pin, else a shared screen, else whoever spoke last. */
export function spotlightTile(s: HuddleState): Tile | null {
  const t = s.tiles
  return t.find((x) => x.key === s.pinned)
    ?? t.find((x) => x.screen)
    ?? t.find((x) => !x.screen && x.pid === s.speaker && !x.local && t.length > 1)
    ?? t.find((x) => !x.local && !x.screen)
    ?? t[0] ?? null
}

// ── Controls ────────────────────────────────────────────────────────────────
const busy = new Set<string>()
async function once(key: string, fn: () => Promise<void>) {
  if (busy.has(key)) return
  busy.add(key)
  try { await fn() } finally { busy.delete(key); sync() }
}
export function toggleMic() {
  return once('mic', async () => {
    const lp = room?.localParticipant
    if (!lp) return
    try { await lp.setMicrophoneEnabled(!lp.isMicrophoneEnabled) } catch { toast("Couldn't change your mic", 'error') }
  })
}
export function toggleCam() {
  return once('cam', async () => {
    const lp = room?.localParticipant
    if (!lp) return
    const on = !lp.isCameraEnabled
    // Blurred: unpublishing the blurred track is turning the camera off.
    if (!on && state.blur) { await setBlur(false, false); return }
    try {
      await lp.setCameraEnabled(on, on && state.camId ? { deviceId: { exact: state.camId } } : undefined)
      set({ note: '' })
    } catch (e) {
      set({ note: (e as { name?: string })?.name === 'NotAllowedError' ? 'Camera blocked: allow it in your browser settings.' : "Couldn't start your camera." })
    }
  })
}
export function toggleShare() {
  return once('share', async () => {
    const lp = room?.localParticipant
    if (!lp) return
    if (!canShare()) { toast("This browser can't share its screen", 'warning'); return }
    try { await lp.setScreenShareEnabled(!lp.isScreenShareEnabled) } catch (e) {
      if ((e as { name?: string })?.name !== 'NotAllowedError') toast("Couldn't share your screen", 'error')
    }
  })
}
export function setLayout(layout: 'spotlight' | 'grid') { set({ layout }) }
export function pin(key: string) { set({ pinned: state.pinned === key ? '' : key, layout: 'spotlight' }) }

// Background blur: a clone of the camera feeds a blurred canvas, and the published
// track is swapped for the canvas's. Undo unpublishes it and starts the camera fresh,
// which works whatever LiveKit did with the original track.
let blurCtx: { stop: () => void } | null = null
export function toggleBlur() { return once('blur', () => setBlur(!state.blur)) }
async function setBlur(on: boolean, restore = true) {
  const lp = room?.localParticipant
  const track = lp?.getTrackPublication(SRC.cam)?.track
  if (on) {
    if (!lp?.isCameraEnabled || !track?.replaceTrack) { toast('Turn your camera on first', 'warning'); return }
    const orig = track.mediaStreamTrack
    const src = orig.clone()
    const v = document.createElement('video')
    v.srcObject = new MediaStream([src])
    v.muted = true
    v.playsInline = true
    await v.play().catch(() => { /* */ })
    const { width = 640, height = 360 } = src.getSettings()
    const cv = document.createElement('canvas')
    cv.width = width
    cv.height = height
    const ctx = cv.getContext('2d')
    const blurred = ctx && cv.captureStream ? cv.captureStream(30).getVideoTracks()[0] : undefined
    if (!ctx || !blurred) { src.stop(); toast("This browser can't blur the background", 'warning'); return }
    let raf = 0
    const frame = () => {
      ctx.filter = 'blur(10px)'
      ctx.drawImage(v, -12, -12, width + 24, height + 24)
      raf = requestAnimationFrame(frame)
    }
    frame()
    const stop = () => { cancelAnimationFrame(raf); v.srcObject = null; src.stop(); blurred.stop() }
    try {
      await track.replaceTrack(blurred, true)
      orig.stop() // the clone feeds the canvas now
      blurCtx = { stop }
      set({ blur: true })
    } catch {
      stop()
      toast("Couldn't blur the background", 'error')
    }
  } else {
    if (lp && track && blurCtx) {
      try { await lp.unpublishTrack(track, true) } catch { /* */ }
      stopBlur()
      if (restore) {
        try { await lp.setCameraEnabled(true, state.camId ? { deviceId: { exact: state.camId } } : undefined) } catch { set({ note: "Couldn't restart your camera." }) }
      }
    } else stopBlur()
  }
}
function stopBlur() {
  blurCtx?.stop()
  blurCtx = null
  if (state.blur) set({ blur: false })
}

// ── AI helper ───────────────────────────────────────────────────────────────
export function setAiOpen(aiOpen: boolean) { set({ aiOpen }) }

function context(max = 40): string {
  return state.lines.slice(-max).map((l) => `${l.name}: ${l.text}`).join('\n')
}

export function askAi(text: string) {
  const q = text.trim()
  if (!q || state.aiBusy) return false
  set({ aiLog: [...state.aiLog, { role: 'user', text: q }] })
  void runAi({ kind: 'ask', text: q })
  return true
}
export function meetingNotes() {
  if (state.aiBusy) return
  set({ aiOpen: true })
  if (!state.lines.length) {
    set({ aiLog: [...state.aiLog, { role: 'note', text: 'No transcript yet. Turn on Transcript first, then ask for notes.' }] })
    return
  }
  set({ aiLog: [...state.aiLog, { role: 'user', text: 'Meeting notes, please.' }] })
  void runAi({ kind: 'notes' })
}
export function retryAi(req: AiRequest) {
  set({ aiLog: state.aiLog.filter((m) => m.retry !== req) })
  void runAi(req)
}

async function runAi(req: AiRequest) {
  set({ aiBusy: true })
  const ctx = context()
  const messages = req.kind === 'notes'
    ? [
        { role: 'system', content: 'Write clean, organised meeting notes from this call transcript: a short summary, decisions, and follow-ups with who owns them.' },
        { role: 'user', content: 'Transcript:\n\n' + context(400) },
      ]
    : [
        { role: 'system', content: 'You are the AI helper in a squad video call. Be concise.' + (ctx ? '\n\nThe call so far:\n' + ctx : '') },
        // The last few turns, so follow-ups make sense.
        ...state.aiLog.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-7, -1)
          .map((m) => ({ role: m.role, content: m.text })),
        { role: 'user', content: req.text },
      ]
  try {
    const d = await request<{ message?: { content?: string }; response?: string }>('/api/huddle/ai', { body: { messages }, timeoutMs: 75_000, quiet401: true })
    const text = (d.message?.content || d.response || '').trim()
    set({ aiLog: [...state.aiLog, text ? { role: 'assistant', text } : { role: 'error', text: "AI didn't answer", retry: req }], aiSignedOut: false })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) set({ aiSignedOut: true })
    else set({ aiLog: [...state.aiLog, { role: 'error', text: e instanceof ApiError && e.status === 503 ? "The AI isn't set up on this server." : "AI didn't answer", retry: e instanceof ApiError && e.status === 503 ? undefined : req }] })
  } finally {
    set({ aiBusy: false })
  }
}

// ── Live transcript ─────────────────────────────────────────────────────────
let recorder: MediaRecorder | null = null
let chunkTimer = 0

function addLine(name: string, text: string) {
  set({ lines: [...state.lines, { name, text, ts: Date.now() }].slice(-500) })
}

async function sendData(m: Record<string, unknown>) {
  // In the app the call is native: it publishes for us.
  if (state.nativeRoom) { toNative({ type: 'data', kind: 'huddle', payload: m }); return }
  try { await room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(m)), { reliable: true, topic: TOPIC }) } catch { /* */ }
}

// ── Hands and reactions (and everything else on the data channel) ───────────
const remoteHands = new Map<string, string>()   // identity -> name
let rxSeq = 0
let rxSent: number[] = []

/** One message from the room's data channel (or relayed by the app). */
function onData(m: Record<string, unknown>, name: string, id: string) {
  if (m.t === 'sync') {
    if (state.hand) void sendData({ t: 'hand', up: true })
    if (state.transcribing && !state.nativeRoom) void sendData({ t: 'rec', on: true })
    return
  }
  if (m.t === 'rec') {
    if (m.on) remoteRecorders.set(id, name)
    else remoteRecorders.delete(id)
    if (state.nativeRoom) set({ recorders: [...remoteRecorders.values(), ...(state.transcribing ? ['You'] : [])] })
    else sync()
    // The transcript is for the whole call: someone turning it on (or off) does it for
    // everyone, so the notes have what everybody said, not just them.
    if (m.all && !!m.on !== state.transcribing) {
      set({ aiLog: [...state.aiLog, { role: 'note', text: `${name} turned the transcript ${m.on ? 'on' : 'off'} for everyone.` }] })
      if (m.on) toggleTranscript({ open: false, quiet: true, echo: false })
      else if (state.nativeRoom) toNative({ type: 'transcript', kind: 'huddle', on: false })
      else stopTranscript(false, false)
    }
  } else if (m.t === 'line' && typeof m.text === 'string' && m.text) {
    addLine(name, m.text.slice(0, 2000))
  } else if (m.t === 'hand') {
    if (m.up) remoteHands.set(id, name)
    else remoteHands.delete(id)
    if (state.nativeRoom) set({ hands: [...remoteHands.values()] })
    else sync()
    if (m.up) toast(`✋ ${name} raised a hand`, 'info')
  } else if (m.t === 'rx' && typeof m.e === 'string' && (REACTIONS as readonly string[]).includes(m.e)) {
    showReaction(name, m.e)
  }
}

function showReaction(name: string, e: string) {
  const id = ++rxSeq
  set({ reactions: [...state.reactions.slice(-11), { id, name, e }] })
  window.setTimeout(() => set({ reactions: state.reactions.filter((r) => r.id !== id) }), 3200)
}

export function toggleHand() {
  const up = !state.hand
  set({ hand: up })
  void sendData({ t: 'hand', up })
  if (!state.nativeRoom) sync()
}

export function react(e: string) {
  if (!(REACTIONS as readonly string[]).includes(e)) return
  const now = Date.now()
  rxSent = rxSent.filter((t) => now - t < 3000)
  if (rxSent.length >= 6) return   // a burst guard: 6 every 3 seconds
  rxSent.push(now)
  showReaction('You', e)
  void sendData({ t: 'rx', e })
}

// The app relays the native call's data channel, and its own transcript.
onNativeData((kind, m, from, fromId) => {
  if (kind !== 'huddle' || !state.nativeRoom) return
  if (m.t === 'transcribing') {
    // Asked for right after joining, the app's mic may not be up yet: try again shortly.
    if (!m.on && nativeTries > 0 && /unmute/i.test(String(m.note || ''))) {
      nativeTries--
      window.setTimeout(() => toNative({ type: 'transcript', kind: 'huddle', on: true }), 1500)
      return
    }
    if (m.on) nativeTries = 0
    set({ transcribing: !!m.on, recorders: [...remoteRecorders.values(), ...(m.on ? ['You'] : [])] })
    if (typeof m.note === 'string' && m.note) set({ aiLog: [...state.aiLog, { role: 'note', text: m.on ? NOTE_ON : m.note }] })
    // The app tells the call it's recording; this makes it everyone's transcript.
    if (nativeAnnounce) { void sendData({ t: 'rec', on: !!m.on, all: true }); nativeAnnounce = false }
    return
  }
  if (m.t === 'line' && fromId === 'me') { addLine(from || 'You', String(m.text || '').slice(0, 2000)); return }
  // The call screen's AI sheet: a question (and whether to start the transcript first),
  // or "send me the chat" when it opens.
  if (fromId === 'me' && m.t === 'ai_ask') {
    if (m.transcribe === true && !state.transcribing) toggleTranscript({ open: false })
    if (typeof m.text === 'string') askAi(m.text)
    return
  }
  if (fromId === 'me' && m.t === 'ai_open') { aiSent = ''; sendAiToNative(); return }
  if (fromId === 'me' && m.t === 'ai_retry') {
    const last = [...state.aiLog].reverse().find((x) => x.retry)
    if (last?.retry) retryAi(last.retry)
    return
  }
  if (m.t === 'hand_self') { set({ hand: !!m.up }); return }   // the call screen's own hand button
  onData(m, from, fromId)
})

const NOTE_ON = "Transcript on for everyone in the call. The meeting notes are saved when the call ends."
let nativeTries = 0
let nativeAnnounce = false
function nativeTranscriptOn() {
  nativeTries = 6
  nativeAnnounce = true
  toNative({ type: 'transcript', kind: 'huddle', on: true })
}

/** Transcript on or off for the whole call. `open`: show the AI helper; `echo`: tell the room. */
export function toggleTranscript({ open = true, quiet = false, echo = true }: { open?: boolean; quiet?: boolean; echo?: boolean } = {}) {
  if (state.nativeRoom) {
    // The app records its own mic (the page has none in a native call).
    if (open) set({ aiOpen: true })
    if (state.transcribing) { nativeAnnounce = echo; toNative({ type: 'transcript', kind: 'huddle', on: false }); return }
    nativeTries = 6
    nativeAnnounce = echo
    toNative({ type: 'transcript', kind: 'huddle', on: true })
    return
  }
  if (state.transcribing) { stopTranscript(true, echo); return }
  const lp = room?.localParticipant
  const mst = lp?.getTrackPublication(SRC.mic)?.track?.mediaStreamTrack
  if (open) set({ aiOpen: true })
  if (!lp || !mst || !lp.isMicrophoneEnabled) {
    set({ aiLog: [...state.aiLog, { role: 'note', text: 'Unmute your mic to start the transcript.' }] })
    return
  }
  if (typeof MediaRecorder === 'undefined') {
    set({ aiLog: [...state.aiLog, { role: 'note', text: "This browser can't record a transcript." }] })
    return
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || ''
  let rec: MediaRecorder
  try { rec = new MediaRecorder(new MediaStream([mst]), mime ? { mimeType: mime } : undefined) } catch {
    set({ aiLog: [...state.aiLog, { role: 'note', text: "Couldn't start the transcript." }] })
    return
  }
  const me = nameOf(lp)
  let chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })
    chunks = []
    // Each chunk is a whole file, so restart right away and send this one.
    if (recorder === rec && state.transcribing) {
      try { rec.start(); chunkTimer = window.setTimeout(() => { if (rec.state === 'recording') rec.stop() }, CHUNK_MS) } catch { /* */ }
    }
    if (blob.size > 2000) void transcribe(blob, me)
  }
  recorder = rec
  set({ transcribing: true, ...(quiet ? {} : { aiLog: [...state.aiLog, { role: 'note' as const, text: NOTE_ON }] }) })
  try { rec.start() } catch { stopTranscript(false); return }
  chunkTimer = window.setTimeout(() => { if (rec.state === 'recording') rec.stop() }, CHUNK_MS)
  void sendData({ t: 'rec', on: true, ...(echo ? { all: true } : {}) })
  sync()
}

function stopRecorder() {
  window.clearTimeout(chunkTimer)
  const rec = recorder
  recorder = null
  if (rec && rec.state !== 'inactive') { try { rec.stop() } catch { /* */ } }
}
function stopTranscript(say: boolean, echo = false) {
  if (!state.transcribing) return
  stopRecorder()
  set({ transcribing: false })
  if (say) set({ aiLog: [...state.aiLog, { role: 'note', text: 'Transcript off.' }] })
  void sendData({ t: 'rec', on: false, ...(echo ? { all: true } : {}) })
  sync()
}

async function transcribe(blob: Blob, me: string) {
  const fd = new FormData()
  const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
  fd.append('file', blob, `audio.${ext}`)
  fd.append('room', state.room)   // the meeting the notes come from
  try {
    const r = await fetch('/api/huddle/transcribe', { method: 'POST', body: fd, credentials: 'same-origin' })
    if (r.status === 401) { set({ aiSignedOut: true }); stopTranscript(false); return }
    if (!r.ok) {
      // One failed chunk is noise; say it once, not every six seconds.
      if (!state.aiLog.some((m) => m.text === "Couldn't transcribe the last few seconds")) {
        set({ aiLog: [...state.aiLog, { role: 'error', text: "Couldn't transcribe the last few seconds" }] })
      }
      if (r.status === 503 || r.status === 400) stopTranscript(false)
      return
    }
    const d = (await r.json()) as { text?: string }
    const text = (d.text || '').trim()
    if (!text) return
    addLine(me, text)
    void sendData({ t: 'line', text })
  } catch { /* the next chunk tries again */ }
}

// ── Lock screen (Media Session) ─────────────────────────────────────────────
// Joining takes the lock screen; Slap or a Watch Party started during the call
// takes it over, and hanging up hands it back. Chrome adds mic, camera and
// hang-up buttons for a call; elsewhere it is just the card.
// ── Picture in picture ──────────────────────────────────────────────────────
/** What floats: a shared screen, else whoever's talking, else anyone with a camera on. */
function pipStream(): MediaStream | null {
  const theirs = state.tiles.filter((t) => !t.local && t.video)
  const pick = theirs.find((t) => t.screen) ?? theirs.find((t) => t.pid === state.speaker) ?? theirs[0]
  return pick ? streamOf(tileTrack(pick)?.mediaStreamTrack) : null
}
/** Pop out: the call in a floating window you can keep while using other apps. */
export const popOut = () => openPip(pipStream(), 'huddle')
export const canPopOut = (s: HuddleState) => pipSupported() && s.tiles.some((t) => !t.local && t.video)

const lockHandlers: lockScreen.Handlers = {
  togglemicrophone: () => { void toggleMic() },
  togglecamera: () => { void toggleCam() },
  hangup: () => { void leave() },
  // Chrome's "the page went to the background": float the call by itself.
  enterpictureinpicture: () => { void popOut() },
}

function syncLockScreen() {
  if (!inCall()) { lockScreen.release('huddle'); stopPip('huddle'); return }
  setPipStream(pipStream(), 'huddle')
  const others = state.tiles.filter((t) => !t.local && !t.screen).length
  const spec: lockScreen.Spec = {
    title: `Huddle · ${state.room}`,
    artist: state.phase === 'reconnecting' ? 'Reconnecting…' : others ? `${others + 1} in the call` : 'Waiting for the squad',
    album: 'CRCMZ',
    playing: true,
    handlers: lockHandlers,
    position: null,
    mic: state.mic,
    camera: state.cam,
  }
  if (lockScreen.holds('huddle')) lockScreen.update('huddle', spec)
  else lockScreen.claim('huddle', spec)
}

// ── Surviving a reload ──────────────────────────────────────────────────────
// A refresh (or the app reloading its page) used to drop you back at Join, and the AI
// chat and transcript with it. While you're in a call this tab remembers the room, the
// AI chat and the transcript. On the way back: in the apps the call never stopped (it's
// native), so once the server confirms you're still in the room the page picks it up
// again; in a browser the reload ended the call, so it joins the same room again.
const SAVE_KEY = 'crcmz.huddle'
const SAVE_FOR_MS = 15 * 60_000
type Saved = { room: string; native: boolean; camera: boolean; at: number; aiLog: AiMsg[]; lines: Line[]; transcribing: boolean }
let saveT = 0
function queueSave() {
  if (saveT) return
  saveT = window.setTimeout(() => {
    saveT = 0
    try {
      const native = !!state.nativeRoom
      if (!native && !inCall()) { if (state.phase === 'pre') sessionStorage.removeItem(SAVE_KEY); return }
      const saved: Saved = {
        room: native ? state.nativeRoom : state.room, native, camera: state.cam, at: Date.now(),
        aiLog: state.aiLog.slice(-40), lines: state.lines.slice(-300), transcribing: state.transcribing,
      }
      sessionStorage.setItem(SAVE_KEY, JSON.stringify(saved))
    } catch { /* private mode or full: nothing to keep */ }
  }, 500)
}
function readSaved(): Saved | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(SAVE_KEY) || 'null') as Saved | null
    return s && typeof s.room === 'string' && Date.now() - s.at < SAVE_FOR_MS ? s : null
  } catch { return null }
}
async function restore() {
  const saved = readSaved()
  if (!saved || state.phase !== 'pre' || state.nativeRoom) return
  const back = { aiLog: Array.isArray(saved.aiLog) ? saved.aiLog : [], lines: Array.isArray(saved.lines) ? saved.lines : [] }
  if (saved.native) {
    if (!nativeCalls()) return
    try {
      const r = await request<{ live: boolean }>(`/api/huddle/live?room=${encodeURIComponent(saved.room)}`, { quiet401: true })
      if (!r.live || state.nativeRoom || state.phase !== 'pre') { sessionStorage.removeItem(SAVE_KEY); return }
      set({ ...back, room: saved.room, nativeRoom: saved.room, transcribing: !!saved.transcribing })
    } catch { /* can't tell: leave it at Join */ }
    return
  }
  if (nativeCalls()) return
  set({ ...back, room: saved.room })
  await join({ camera: saved.camera })
}
if (typeof window !== 'undefined') window.setTimeout(() => void restore(), 0)
