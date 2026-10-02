// PS-7 · Huddle: a video call for the squad, with an AI helper that reads the
// transcript. The call lives in ./session, so this page can unmount (navigate away)
// and the room keeps going; the call bar brings you back.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useSearchParams } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { useDesktop } from '../../lib/media'
import { ringSquad } from '../../lib/ring'
import { loginUrl } from '../../lib/session'
import { useSwipeDown } from '../../lib/gestures'
import { initials, tint } from '../../lib/watch'
import {
  askAi, canShare, join, leave, meetingNotes, pin, previewMedia, retryAi, setAiOpen, setCamId, setLayout, setMicId, setRoomName,
  spotlightTile, startAudio, startPreview, stopPreview, tileTrack, toggleBlur, toggleCam, toggleMic, toggleShare, toggleTranscript,
  useHuddle, type HuddleState, type Tile,
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
      </div>
      {call ? <CallView s={s} /> : <PreJoin s={s} />}
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
          {s.recorders.length > 0 && (
            <span className="hu-rec-chip" role="status" title={`Recording a transcript: ${s.recorders.join(', ')}`}>
              <span className="hu-rec-dot" aria-hidden="true" />Transcript on
            </span>
          )}
          <span className="hu-topbar-spacer" />
          <button
            type="button" className="icon-btn" disabled={stale}
            aria-label={s.layout === 'grid' ? 'Spotlight layout' : 'Grid layout'}
            onClick={() => setLayout(s.layout === 'grid' ? 'spotlight' : 'grid')}
          >
            <Icon name={s.layout === 'grid' ? 'spotlight' : 'grid'} />
          </button>
          <button
            type="button" className="btn btn-secondary hu-ai-btn" disabled={ringing}
            title="Ring everyone's phone into this call"
            onClick={() => { setRinging(true); void ringSquad('huddle', s.room).finally(() => setRinging(false)) }}
          >
            <Icon name="phone" />{ringing ? 'Ringing…' : 'Ring'}
          </button>
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
          {stale && (
            <div className="hu-stale" role="status">
              <span className="spinner" aria-hidden="true" />Reconnecting…
            </div>
          )}
        </div>
        <Controls s={s} disabled={stale} />
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
    <span className="hu-tile" data-speaking={t.speaking} data-screen={t.screen} data-big={big}>
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

function AiPanel({ s, titleId, sheet = false }: { s: HuddleState; titleId: string; sheet?: boolean }) {
  const [q, setQ] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [s.aiLog.length, s.aiBusy])
  function submit(e: FormEvent) {
    e.preventDefault()
    if (askAi(q)) setQ('')
  }
  const Title = sheet ? Dialog.Title : 'h2'
  return (
    <div className="hu-ai">
      <div className="sheet-title-row">
        {/* Radix names the sheet from its own Title id, so only the desktop h2 takes ours. */}
        <Title className={sheet ? 'sheet-title' : 'section-h2'} {...(sheet ? {} : { id: titleId })}>AI helper</Title>
        <button type="button" className="icon-btn" aria-label="Close the AI helper" onClick={() => setAiOpen(false)}><Icon name="close" /></button>
      </div>
      {s.aiSignedOut && (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Sign in to use the AI</span>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      )}
      <div className="hu-ai-tools">
        <button type="button" className="btn btn-secondary" aria-pressed={s.transcribing} onClick={toggleTranscript}>
          <Icon name={s.transcribing ? 'micOff' : 'mic'} />{s.transcribing ? 'Stop transcript' : 'Transcript'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={s.aiBusy} onClick={meetingNotes}><Icon name="notes" />Notes</button>
      </div>
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
      <form className="comment-form" onSubmit={submit}>
        <label className="sr-only" htmlFor={`${titleId}-in`}>Ask the AI</label>
        <input id={`${titleId}-in`} className="input" value={q} maxLength={1000} placeholder="Ask the AI" autoComplete="off" enterKeyHint="send" onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={!q.trim() || s.aiBusy} aria-label="Ask"><Icon name="send" /></button>
      </form>
    </div>
  )
}
