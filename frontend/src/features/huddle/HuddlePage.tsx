// PS-7 · Huddle: a video call for the squad, with an AI helper that reads the
// transcript. The call lives in ./session, so this page can unmount (navigate away)
// and the room keeps going; the call bar brings you back.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { useDesktop } from '../../lib/media'
import { RingSheet } from '../../components/RingSheet'
import { loginUrl } from '../../lib/session'
import { useSwipeDown } from '../../lib/gestures'
import { initials, tint } from '../../lib/watch'
import {
  askAi, canPopOut, canShare, join, leave, popOut, showNativeCall, pin, previewMedia, retryAi, setAiOpen, setCamId, setLayout, setMicId, setRoomName,
  spotlightTile, startAudio, startPreview, stopPreview, tileTrack, toggleBlur, toggleCam, toggleMic, toggleShare, toggleTranscript,
  react, setAutoTranscribe, setMusicVolume, setCallVolume, toggleHand, REACTIONS, useHuddle, type HuddleState, type Tile,
} from './session'
import { HelpLink } from '../../components/HelpLink'

export function HuddlePage() {
  useTitle('Huddle')
  const s = useHuddle()
  // A "started a Huddle" notification links /app/huddle?room=<room>: fill it in, don't join.
  const [params, setParams] = useSearchParams()
  const linkedRoom = params.get('room')
  useEffect(() => {
    if (!linkedRoom) return
    if (s.phase === 'pre') setRoomName(linkedRoom.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64))
    setParams((p) => { p.delete('room'); return p }, { replace: true })
  }, [linkedRoom]) // only when the link changes, not on every phase change
  // The pre-join preview runs only while this page shows; the camera light goes off when you leave.
  useEffect(() => {
    void startPreview()
    return () => stopPreview()
  }, [])
  const call = s.phase === 'live' || s.phase === 'reconnecting'
  return (
    <div className="page hu-page" data-call={call}>
      <div className="hu-head">
        <h1 className="page-h1" tabIndex={-1}>Huddle<HelpLink id="huddle" /></h1>
        <Link className="btn btn-ghost hu-notes-link" to="/huddle/notes"><Icon name="notes" />Meeting notes</Link>
      </div>
      {call ? <CallView s={s} /> : s.nativeRoom ? <NativeLive s={s} /> : <PreJoin s={s} />}
    </div>
  )
}

/** In the phone apps the call is native (full screen, picture in picture); this is what's
 *  behind it: back to the call, the AI helper (it reads the transcript the app records),
 *  your hand and reactions. */
function NativeLive({ s }: { s: HuddleState }) {
  const [ringing, setRinging] = useState(false)
  return (
    <div className="hu-native-wrap">
      <section className="glass hu-native" aria-live="polite">
        <p className="empty-title">You're in the Huddle · {s.nativeRoom}</p>
        <p className="meta">The call is open full screen. It keeps going if you leave the app, in a floating window.</p>
        <div className="hu-native-acts">
          <button type="button" className="btn btn-primary" onClick={showNativeCall}><Icon name="huddle" />Return to the call</button>
          <button type="button" className="btn btn-secondary" aria-haspopup="dialog" onClick={() => setRinging(true)}>
            <Icon name="phone" />Ring
          </button>
          <TranscriptButton s={s} />
          <HandButton s={s} />
          <ReactButton />
        </div>
        {/* The app's call screen has no Ring: ring everyone, or one person, from here. */}
        <RingSheet kind="huddle" room={s.nativeRoom} open={ringing} onOpenChange={setRinging} />
        {(s.hands.length > 0 || s.recorders.length > 0) && (
          <p className="meta hu-native-status" role="status">
            {s.hands.length > 0 && <span>✋ {s.hands.join(', ')}</span>}
            {s.recorders.length > 0 && <span className="hu-rec-chip"><span className="hu-rec-dot" aria-hidden="true" />Transcript on</span>}
          </p>
        )}
        <Reactions s={s} />
      </section>
      <section className="glass hu-vol-section" aria-label="Volume controls">
        <VolumePanel s={s} inline />
      </section>
      <section className="glass hu-ai-side hu-native-ai" aria-labelledby="hu-native-ai-h">
        <AiPanel s={s} titleId="hu-native-ai-h" inline />
      </section>
    </div>
  )
}

/** Music + call volume sliders shown when in a Huddle alongside the Slap player. */
function VolumePanel({ s, inline = false }: { s: HuddleState; inline?: boolean }) {
  return (
    <div className={`hu-vol-panel${inline ? ' hu-vol-panel--inline' : ''}`} aria-label="Volume controls">
      <label className="hu-vol-row">
        <Icon name="vol" className="nav-icon hu-vol-icon" aria-hidden="true" />
        <span className="hu-vol-label">Music</span>
        <input
          type="range" className="hu-vol-slider" min={0} max={1} step={0.05}
          value={s.musicVolume}
          aria-label="Music volume"
          onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
        />
        <span className="hu-vol-pct" aria-live="polite">{Math.round(s.musicVolume * 100)}%</span>
      </label>
      <label className="hu-vol-row">
        <Icon name="huddle" className="nav-icon hu-vol-icon" aria-hidden="true" />
        <span className="hu-vol-label">Huddle</span>
        <input
          type="range" className="hu-vol-slider" min={0} max={1} step={0.05}
          value={s.callVolume}
          aria-label="Huddle call volume"
          onChange={(e) => setCallVolume(parseFloat(e.target.value))}
        />
        <span className="hu-vol-pct" aria-live="polite">{Math.round(s.callVolume * 100)}%</span>
      </label>
    </div>
  )
}

/** Transcript on or off for everyone in the call; the meeting notes come from it. */
function TranscriptButton({ s, ctrl = false }: { s: HuddleState; ctrl?: boolean }) {
  const label = s.transcribing ? 'Stop the transcript' : 'Transcribe this call (meeting notes when it ends)'
  return ctrl ? (
    <button type="button" className="hu-ctrl" data-active={s.transcribing} aria-pressed={s.transcribing} aria-label={label} title={label}
      onClick={() => toggleTranscript({ open: false })}>
      <Icon name="notes" /><span className="hu-ctrl-label" aria-hidden="true">{s.transcribing ? 'Stop notes' : 'Notes'}</span>
    </button>
  ) : (
    <button type="button" className="btn btn-secondary" aria-pressed={s.transcribing} title={label} onClick={() => toggleTranscript({ open: false })}>
      <Icon name="notes" />{s.transcribing ? 'Stop transcript' : 'Transcribe'}
    </button>
  )
}

function HandButton({ s, ctrl = false }: { s: HuddleState; ctrl?: boolean }) {
  return ctrl ? (
    <button type="button" className="hu-ctrl" data-active={s.hand} aria-pressed={s.hand} aria-label={s.hand ? 'Lower your hand' : 'Raise your hand'} onClick={toggleHand}>
      <span className="hu-ctrl-emoji" aria-hidden="true">✋</span><span className="hu-ctrl-label" aria-hidden="true">{s.hand ? 'Lower' : 'Hand'}</span>
    </button>
  ) : (
    <button type="button" className="btn btn-secondary" aria-pressed={s.hand} onClick={toggleHand}>
      <span aria-hidden="true">✋</span>{s.hand ? 'Lower hand' : 'Raise hand'}
    </button>
  )
}

/** A row of quick reactions everyone in the call sees float up. */
function ReactButton({ ctrl = false }: { ctrl?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="hu-react">
      <button type="button" className={ctrl ? 'hu-ctrl' : 'btn btn-secondary'} aria-expanded={open} aria-label="Reactions" onClick={() => setOpen(!open)}>
        <Icon name="smile" />{ctrl ? <span className="hu-ctrl-label" aria-hidden="true">React</span> : 'React'}
      </button>
      {open && (
        <span className="glass hu-react-row" role="group" aria-label="Send a reaction">
          {REACTIONS.map((e) => (
            <button key={e} type="button" className="hu-react-btn" aria-label={`Send ${e}`} onClick={() => react(e)}>{e}</button>
          ))}
        </span>
      )}
    </span>
  )
}

function Reactions({ s }: { s: HuddleState }) {
  if (!s.reactions.length) return null
  return (
    <div className="hu-reactions" aria-live="polite">
      {s.reactions.map((r, i) => (
        <span key={r.id} className="hu-reaction" style={{ ['--hu-rx-x' as string]: `${12 + ((r.id * 37) % 70)}%`, ['--hu-rx-i' as string]: i }}>
          <span className="hu-reaction-e" aria-hidden="true">{r.e}</span>
          <span className="hu-reaction-name">{r.name}</span>
          <span className="sr-only">{r.name} reacted {r.e}</span>
        </span>
      ))}
    </div>
  )
}

// ── Pre-join (HU-01) ────────────────────────────────────────────────────────
function PreJoin({ s }: { s: HuddleState }) {
  const vid = useRef<HTMLVideoElement>(null)
  const joining = s.phase === 'joining'
  useEffect(() => {
    const el = vid.current
    if (el) el.srcObject = s.preview === 'on' ? previewMedia() : null
  }, [s.preview])
  const noCam = s.preview === 'blocked' || s.preview === 'none'
  function submit(e: FormEvent) {
    e.preventDefault()
    void join({ camera: !noCam })
  }
  return (
    <form className="glass hu-pre" onSubmit={submit} aria-labelledby="hu-pre-h" aria-busy={joining}>
      <div className="hu-preview" data-state={s.preview}>
        <video ref={vid} autoPlay muted playsInline hidden={s.preview !== 'on'} aria-label="Your camera preview" />
        {s.preview !== 'on' && (
          <div className="hu-preview-off">
            <Icon name="camOff" className="nav-icon hu-preview-icon" />
            <span>
              {s.preview === 'starting' ? 'Starting camera…'
                : s.preview === 'blocked' ? 'Camera blocked: allow it in your browser settings, or join without it.'
                : s.preview === 'none' ? 'No camera found. You can join with your mic.'
                : 'Camera off'}
            </span>
          </div>
        )}
      </div>
      <div className="hu-pre-form">
        <h2 className="section-h2" id="hu-pre-h">Ready to join?</h2>
        <JoinError s={s} />
        <div>
          <label className="field-label" htmlFor="hu-room">Room</label>
          <input
            id="hu-room" className="input" value={s.room} maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false}
            disabled={joining} onChange={(e) => setRoomName(e.target.value)} aria-describedby="hu-room-hint"
          />
          <p className="field-hint" id="hu-room-hint">Everyone in the same room is in the same call. Letters, numbers and dashes.</p>
        </div>
        {(s.mics.length > 1 || s.cams.length > 1) && (
          <div className="hu-devices">
            {s.mics.length > 1 && (
              <div>
                <label className="field-label" htmlFor="hu-mic">Microphone</label>
                <select id="hu-mic" className="input" value={s.micId} disabled={joining} onChange={(e) => setMicId(e.target.value)}>
                  <option value="">Default</option>
                  {s.mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </div>
            )}
            {s.cams.length > 1 && (
              <div>
                <label className="field-label" htmlFor="hu-cam">Camera</label>
                <select id="hu-cam" className="input" value={s.camId} disabled={joining} onChange={(e) => setCamId(e.target.value)}>
                  <option value="">Default</option>
                  {s.cams.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        <label className="hu-auto-tx">
          <input type="checkbox" checked={s.autoTranscribe} disabled={joining} onChange={(e) => setAutoTranscribe(e.target.checked)} />
          <span>
            <b>Transcribe and save meeting notes</b>
            <span className="field-hint">The transcript starts for everyone when you join; the AI writes the notes when the call ends.</span>
          </span>
        </label>
        <div className="hu-join-row">
          <button type="submit" className="btn btn-primary hu-join" disabled={joining}>
            <Icon name={noCam ? 'mic' : 'cam'} />
            {joining ? `Connecting to ${s.room.trim() || 'crcmz'}…` : s.error === 'dropped' ? 'Rejoin' : s.error === 'connect' ? 'Retry' : noCam ? 'Join without camera' : 'Join'}
          </button>
          {!noCam && (
            <button type="button" className="btn btn-secondary" disabled={joining} onClick={() => void join({ camera: false })}>
              <Icon name="camOff" />Join without camera
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

function JoinError({ s }: { s: HuddleState }) {
  switch (s.error) {
    case 'config':
      return <p className="banner" role="alert"><span style={{ fontWeight: 700 }}>Huddle isn't set up on this server.</span></p>
    case 'signin':
      return (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Sign in to join the call</span>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      )
    case 'connect':
      return <p className="banner" role="alert"><span style={{ fontWeight: 700 }}>Couldn't connect to the call.</span>{s.errorText && <span className="dim">{s.errorText}</span>}</p>
    case 'dropped':
      return <p className="banner" role="alert"><span style={{ fontWeight: 700 }}>The call dropped.</span></p>
    default:
      return null
  }
}

// ── In the call (HU-02 … HU-07) ─────────────────────────────────────────────
function CallView({ s }: { s: HuddleState }) {
  const desktop = useDesktop()
  const [ringing, setRinging] = useState(false)
  const stale = s.phase === 'reconnecting'
  const people = new Set(s.tiles.map((t) => t.pid)).size
  return (
    <div className="hu-call" data-ai={desktop && s.aiOpen}>
      <section className="hu-stage-col" aria-label="Call">
        <div className="hu-topbar">
          <span className="hu-room"><Icon name="huddle" />{s.room}</span>
          <span className="hu-count" role="status">{people === 1 ? 'Just you' : `${people} in call`}</span>
          {s.hands.length > 0 && (
            <span className="hu-hand-chip" role="status" title={`Hands up: ${s.hands.join(', ')}`}>✋ {s.hands.length}</span>
          )}
          {s.recorders.length > 0 && (
            <span className="hu-rec-chip" role="status" title={`Recording a transcript: ${s.recorders.join(', ')}`}>
              <span className="hu-rec-dot" aria-hidden="true" />Transcript on
            </span>
          )}
          <span className="hu-topbar-spacer" />
          {canPopOut(s) && desktop && (
            <button type="button" className="icon-btn" disabled={stale} aria-label="Pop out: keep the call in a floating window"
              title="Pop out" onClick={() => { void popOut().then((ok) => { if (!ok) toast("Pop out is not available right now", 'warning') }) }}>
              <Icon name="expand" />
            </button>
          )}
          <button
            type="button" className="icon-btn" disabled={stale}
            aria-label={s.layout === 'grid' ? 'Spotlight layout' : 'Grid layout'}
            onClick={() => setLayout(s.layout === 'grid' ? 'spotlight' : 'grid')}
          >
            <Icon name={s.layout === 'grid' ? 'spotlight' : 'grid'} />
          </button>
          <button
            type="button" className="btn btn-secondary hu-ai-btn" aria-haspopup="dialog"
            title="Ring everyone, or one person, into this call"
            onClick={() => setRinging(true)}
          >
            <Icon name="phone" />Ring
          </button>
          <RingSheet kind="huddle" room={s.room} open={ringing} onOpenChange={setRinging} />
          <button type="button" className="btn btn-secondary hu-ai-btn" aria-pressed={s.aiOpen} aria-expanded={s.aiOpen} onClick={() => setAiOpen(!s.aiOpen)}>
            <Icon name="ask" />AI
          </button>
        </div>
        {s.audioBlocked && (
          <div className="banner" role="alert">
            <span style={{ fontWeight: 700 }}>Your browser is holding the call's sound.</span>
            <button type="button" className="btn btn-secondary" onClick={startAudio}><Icon name="vol" />Tap to hear</button>
          </div>
        )}
        <div className="hu-stage-wrap" data-stale={stale}>
          {s.layout === 'grid' ? <Grid s={s} /> : <Spotlight s={s} />}
          <Reactions s={s} />
          {stale && (
            <div className="hu-stale" role="status">
              <span className="spinner" aria-hidden="true" />Reconnecting…
            </div>
          )}
        </div>
        <Controls s={s} disabled={stale} />
        <VolumePanel s={s} />
        {s.note && <p className="meta hu-note" role="status">{s.note}</p>}
      </section>
      {desktop ? (s.aiOpen && <aside className="glass hu-ai-side" aria-labelledby="hu-ai-h"><AiPanel s={s} titleId="hu-ai-h" /></aside>) : <AiSheet s={s} />}
    </div>
  )
}

function Spotlight({ s }: { s: HuddleState }) {
  const spot = spotlightTile(s)
  const alone = new Set(s.tiles.map((t) => t.pid)).size === 1
  return (
    <div className="hu-spot-layout">
      <div className="hu-spot">
        {spot && <TileView t={spot} big />}
        {alone && <p className="hu-alone">You're the only one here.</p>}
      </div>
      {s.tiles.length > 1 && (
        <ul className="hu-strip" aria-label="Everyone in the call">
          {s.tiles.map((t) => (
            <li key={t.key}>
              <button
                type="button" className="hu-strip-btn" aria-pressed={s.pinned === t.key} data-on={spot?.key === t.key}
                aria-label={`${s.pinned === t.key ? 'Unpin' : 'Pin'} ${label(t)}`} onClick={() => pin(t.key)}
              >
                <TileView t={t} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Grid({ s }: { s: HuddleState }) {
  const n = s.tiles.length
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4
  return (
    <ul className="hu-grid" style={{ ['--hu-cols' as string]: cols }} aria-label="Everyone in the call">
      {s.tiles.map((t) => (
        <li key={t.key}>
          <button type="button" className="hu-grid-btn" aria-label={`Spotlight ${label(t)}`} onClick={() => pin(t.key)}>
            <TileView t={t} />
          </button>
        </li>
      ))}
    </ul>
  )
}

const label = (t: Tile) => (t.screen ? `${t.local ? 'your' : `${t.name}'s`} screen` : t.local ? `${t.name} (you)` : t.name)

function TileView({ t, big = false }: { t: Tile; big?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const track = t.video ? tileTrack(t) : null
  useEffect(() => {
    const el = ref.current
    if (!el || !track) return
    track.attach(el)
    return () => { track.detach(el) }
  }, [track])
  return (
    <span className="hu-tile" data-speaking={t.speaking} data-screen={t.screen} data-big={big} data-hand={t.hand}>
      {t.hand && <span className="hu-tile-hand" aria-label={`${t.name} has a hand up`}>✋</span>}
      {track
        ? <video ref={ref} className="hu-tile-video" autoPlay muted playsInline data-mirror={t.local && !t.screen} aria-hidden="true" />
        : <span className="hu-tile-face" style={{ background: tint(t.name) }} aria-hidden="true">{initials(t.name)}</span>}
      <span className="hu-tile-name">
        {!t.screen && !t.micOn && <Icon name="micOff" className="nav-icon hu-tile-mic" />}
        <span>{t.screen ? (t.local ? 'Your screen' : `${t.name}'s screen`) : t.local ? `${t.name} (you)` : t.name}</span>
        {!t.screen && !t.micOn && <span className="sr-only">, muted</span>}
      </span>
    </span>
  )
}

function Controls({ s, disabled }: { s: HuddleState; disabled: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="hu-controls" role="toolbar" aria-label="Call controls">
      <button type="button" className="hu-ctrl" data-off={!s.mic} aria-pressed={!s.mic} aria-label={s.mic ? 'Mute' : 'Unmute'} disabled={disabled} onClick={() => void toggleMic()}>
        <Icon name={s.mic ? 'mic' : 'micOff'} /><span className="hu-ctrl-label" aria-hidden="true">{s.mic ? 'Mute' : 'Unmute'}</span>
      </button>
      <button type="button" className="hu-ctrl" data-off={!s.cam} aria-pressed={!s.cam} aria-label={s.cam ? 'Turn camera off' : 'Turn camera on'} disabled={disabled} onClick={() => void toggleCam()}>
        <Icon name={s.cam ? 'cam' : 'camOff'} /><span className="hu-ctrl-label" aria-hidden="true">Camera</span>
      </button>
      {canShare() && (
        <button type="button" className="hu-ctrl" data-active={s.share} aria-pressed={s.share} aria-label={s.share ? 'Stop sharing your screen' : 'Share your screen'} disabled={disabled} onClick={() => void toggleShare()}>
          <Icon name="screen" /><span className="hu-ctrl-label" aria-hidden="true">{s.share ? 'Stop' : 'Share'}</span>
        </button>
      )}
      <button type="button" className="hu-ctrl" data-active={s.blur} aria-pressed={s.blur} aria-label="Blur background" disabled={disabled || !s.cam} onClick={() => void toggleBlur()}>
        <Icon name="blur" /><span className="hu-ctrl-label" aria-hidden="true">Blur</span>
      </button>
      <TranscriptButton s={s} ctrl />
      <HandButton s={s} ctrl />
      <ReactButton ctrl />
      <button type="button" className="hu-ctrl" aria-label="Open the Slap player" title="Open Slap" onClick={() => navigate('/slap')}>
        <Icon name="slap" /><span className="hu-ctrl-label" aria-hidden="true">Slap</span>
      </button>
      <button type="button" className="hu-ctrl hu-ctrl-leave" aria-label="Leave the call" onClick={() => void leave()}>
        <Icon name="leave" /><span className="hu-ctrl-label" aria-hidden="true">Leave</span>
      </button>
    </div>
  )
}

// ── AI helper (HU-05 … HU-07) ───────────────────────────────────────────────
function AiSheet({ s }: { s: HuddleState }) {
  const swipe = useSwipeDown(() => setAiOpen(false))
  return (
    <Dialog.Root open={s.aiOpen} onOpenChange={setAiOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="sheet hu-ai-sheet" aria-describedby={undefined}>
          <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>
          <AiPanel s={s} titleId="hu-ai-sheet-h" sheet />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function AiPanel({ s, titleId, sheet = false, inline = false }: { s: HuddleState; titleId: string; sheet?: boolean; inline?: boolean }) {
  const [q, setQ] = useState('')
  // A question asked with the transcript off waits here while we ask to turn it on.
  const [pendingQ, setPendingQ] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.aiLog.length, s.aiBusy])
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!q.trim() || s.aiBusy) return
    if (!s.transcribing) { setPendingQ(q.trim()); return }
    if (askAi(q)) setQ('')
  }
  function answer(transcribe: boolean) {
    if (transcribe) toggleTranscript({ open: false })
    if (askAi(pendingQ)) setQ('')
    setPendingQ('')
  }
  const Title = sheet ? Dialog.Title : 'h2'
  return (
    <div className="hu-ai">
      <div className="sheet-title-row">
        {/* Radix names the sheet from its own Title id, so only the desktop h2 takes ours. */}
        <Title className={sheet ? 'sheet-title' : 'section-h2'} {...(sheet ? {} : { id: titleId })}>AI helper</Title>
        {!inline && <button type="button" className="icon-btn" aria-label="Close the AI helper" onClick={() => setAiOpen(false)}><Icon name="close" /></button>}
      </div>
      {s.aiSignedOut && (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Sign in to use the AI</span>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      )}
      <p className="meta hu-ai-tx" role="status">
        {s.transcribing
          ? <><span className="hu-rec-dot" aria-hidden="true" />Transcribing for everyone. The AI follows the call; notes are saved when it ends.</>
          : 'The transcript is off, so the AI only knows what you ask it.'}
      </p>
      <div className="hu-ai-log" ref={log} role="log" aria-live="polite" aria-label="AI helper messages" tabIndex={0}>
        {s.aiLog.length === 0 && !s.lines.length && (
          <p className="dim">Ask it anything about what's happening in-game. It reads the transcript.</p>
        )}
        {s.aiLog.map((m, i) => (
          <div key={i} className="hu-ai-msg" data-role={m.role}>
            <span>{m.text}</span>
            {m.retry && <button type="button" className="btn btn-ghost hu-ai-retry" onClick={() => retryAi(m.retry!)}><Icon name="refresh" />Try again</button>}
          </div>
        ))}
        {s.aiBusy && <div className="hu-ai-msg" data-role="note" role="status">Thinking…</div>}
      </div>
      {s.lines.length > 0 && (
        <details className="hu-lines">
          <summary>Transcript · {s.lines.length} {s.lines.length === 1 ? 'line' : 'lines'}</summary>
          <ol>{s.lines.slice(-60).map((l, i) => <li key={i}><b>{l.name}</b> {l.text}</li>)}</ol>
        </details>
      )}
      {pendingQ && (
        <div className="banner hu-ai-confirm" role="alertdialog" aria-labelledby={`${titleId}-tx-q`}>
          <span id={`${titleId}-tx-q`}><b>Start the transcript?</b> The AI follows the call through it, so it'll start for everyone in the call, and the meeting notes are saved when it ends.</span>
          <span className="hu-ai-confirm-acts">
            <button type="button" className="btn btn-primary" onClick={() => answer(true)}>Start and ask</button>
            <button type="button" className="btn btn-secondary" onClick={() => answer(false)}>Just ask</button>
          </span>
        </div>
      )}
      <form className="comment-form" onSubmit={submit}>
        <label className="sr-only" htmlFor={`${titleId}-in`}>Ask the AI</label>
        <input id={`${titleId}-in`} className="input" value={q} maxLength={1000} placeholder="Ask the AI" autoComplete="off" enterKeyHint="send" onChange={(e) => setQ(e.target.value)} onFocus={(e) => e.currentTarget.scrollIntoView({ behavior: 'smooth', block: 'nearest' })} />
        <button type="submit" className="btn btn-primary" disabled={!q.trim() || s.aiBusy} aria-label="Ask"><Icon name="send" /></button>
      </form>
    </div>
  )
}
