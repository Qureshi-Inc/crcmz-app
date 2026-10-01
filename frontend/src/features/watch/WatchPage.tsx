// PS-6 · Watch Party: one screen, the whole squad. The Shell keeps this page
// mounted once the party starts (a moved iframe reloads, a detached <video>
// pauses), so leaving /watch keeps the video and the call going; the Watch bar
// brings you back.
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip } from '../../components/states'
import { toast } from '../../components/toast'
import { ConfirmDialog } from '../clips/ClipSheet'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { loginUrl } from '../../lib/session'
import { History } from './History'
import { Orbs } from './Orbs'
import { Chat, PresencePill, ReactionsTray, Roster } from './Social'
import { Stage, usePlayerKeys } from './Stage'
import {
  attachLayout, canCall, changeName, clearVideo, exitFs, flipCam, joinCall, leave, leaveCall, rally, rejoin, setMic, setOrbPos, setSpeaker,
  setTitle, setVideo, start, toggleMute, toggleVideo, useWatch, videoLabel, type OrbPos, type WatchState,
} from './session'
import { HelpLink } from '../../components/HelpLink'

export function WatchPage({ visible }: { visible: boolean }) {
  const s = useWatch()
  const desktop = useDesktop()
  const [rxOpen, setRxOpen] = useState(false)
  useEffect(() => { if (visible) start() }, [visible])
  // Fullscreen belongs to this page; navigating away ends it.
  useEffect(() => { if (!visible) exitFs() }, [visible])
  usePlayerKeys(visible, setRxOpen)

  const onVideo = { over: 'side', overTop: 'top', overBottom: 'bottom' } as const
  const over = s.orbPos in onVideo ? <Orbs variant={onVideo[s.orbPos as keyof typeof onVideo]} /> : null
  return (
    <div className="page watch-page" data-hidden={!visible} inert={!visible} aria-hidden={!visible || undefined}>
      {visible && <WatchTitle />}
      <div className="wp-head">
        <h1 className="page-h1" tabIndex={-1}>Watch<HelpLink id="watch" /></h1>
        <PresencePill s={s} />
        <Roster s={s} max={desktop ? 8 : 4} />
        {s.active && s.status !== 'idle' && (
          <button type="button" className="btn btn-secondary wp-leave" onClick={leave}><Icon name="signout" />Leave party</button>
        )}
      </div>
      <StatusBanner s={s} />
      <div className="wp-layout">
        <div className="wp-main">
          <div className="wp-screen" ref={attachLayout} data-fs={s.fs} data-orbs={s.orbPos}>
            {s.orbPos === 'top' && <Orbs variant="strip" />}
            <Stage over={over} rxOpen={rxOpen} setRxOpen={setRxOpen} />
            {s.orbPos === 'bottom' && <Orbs variant="strip" />}
          </div>
          <VideoForm s={s} />
          <ActionRow s={s} />
        </div>
        <aside className="wp-side" aria-label="Reactions and chat">
          <ReactionsTray disabled={s.status !== 'live'} />
          <Chat />
        </aside>
      </div>
      <History />
    </div>
  )
}

function WatchTitle() {
  useTitle('Watch')
  return null
}

function StatusBanner({ s }: { s: WatchState }) {
  switch (s.status) {
    case 'failed':
    case 'unavailable':
      return <ErrorStrip text={s.status === 'failed' && s.error ? s.error : 'Watch Party server unreachable'} onRetry={rejoin} />
    case 'forbidden':
      return (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Link your PSN account to join</span>
          <Link className="btn btn-secondary" to="/portal">Link PSN</Link>
        </div>
      )
    case 'kicked':
      return (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>A moderator removed you from the party.</span>
          <button type="button" className="btn btn-secondary" onClick={rejoin}>Join again</button>
        </div>
      )
    case 'signin':
      return (
        <div className="banner" role="alert">
          <span style={{ fontWeight: 700 }}>Sign in to rejoin</span>
          <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
        </div>
      )
    case 'idle':
      return (
        <div className="banner" role="status">
          <span style={{ fontWeight: 700 }}>You left the watch party.</span>
          <button type="button" className="btn btn-secondary" onClick={rejoin}>Join again</button>
        </div>
      )
    default:
      return null
  }
}

function VideoForm({ s }: { s: WatchState }) {
  const [url, setUrl] = useState('')
  const urlRef = useRef<HTMLInputElement>(null)
  const live = s.status === 'live'
  const wait = useCountdown(s.extractUntil)
  // Nothing on and we're in: put the cursor where the link goes (desktop only — on a
  // phone it would pop the keyboard over the video).
  const desktop = useDesktop()
  useEffect(() => { if (live && !s.video && desktop) urlRef.current?.focus({ preventScroll: true }) }, [live, s.video, desktop])
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (wait) return
    if (await setVideo(url)) setUrl('')
  }
  return (
    <form className="glass wp-form" onSubmit={submit} aria-labelledby="wp-form-h">
      <h2 className="section-h2" id="wp-form-h">What are we watching?</h2>
      <div>
        <label className="field-label" htmlFor="wp-title">Title <span className="dim">(optional)</span></label>
        <input id="wp-title" className="input" value={s.title} maxLength={200} placeholder={videoLabel(true) || 'Movie night'} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      </div>
      <div>
        <label className="field-label" htmlFor="wp-url">Video link</label>
        <div className="wp-url-row">
          <input
            id="wp-url" ref={urlRef} className="input" type="url" inputMode="url" value={url} placeholder="https://…" autoComplete="off"
            disabled={!live} aria-invalid={!!s.error || undefined} aria-describedby={s.error ? 'wp-url-err' : 'wp-url-hint'}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!live || !url.trim() || s.extracting || wait > 0}>
            <Icon name="play" />{s.extracting ? 'Finding…' : wait ? `Wait ${wait}s` : 'Play'}
          </button>
          {s.video && <button type="button" className="btn btn-secondary" onClick={clearVideo} disabled={!live}><Icon name="close" />Clear</button>}
        </div>
        {s.error
          ? <p className="field-err" id="wp-url-err" role="alert">{s.error}</p>
          : <p className="field-hint" id="wp-url-hint">{live ? 'YouTube, a video file, or a page with a video on it. Everyone sees it at once.' : 'Connecting to the party…'}</p>}
      </div>
    </form>
  )
}

function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= Date.now()) return
    const t = window.setInterval(() => { setNow(Date.now()); if (Date.now() >= until) window.clearInterval(t) }, 500)
    return () => window.clearInterval(t)
  }, [until])
  return Math.max(0, Math.ceil((until - now) / 1000))
}

const ORB_ROWS: { label: string; opts: { id: OrbPos; label: string; name: string }[] }[] = [
  { label: 'Outside the video', opts: [{ id: 'top', label: 'Above', name: 'Above the video' }, { id: 'bottom', label: 'Below', name: 'Below the video' }] },
  { label: 'On the video', opts: [{ id: 'overTop', label: 'Top', name: 'On the video, along the top' }, { id: 'overBottom', label: 'Bottom', name: 'On the video, along the bottom' }, { id: 'over', label: 'Side', name: 'On the video, down the side' }] },
]
const ORB_POS = ORB_ROWS.flatMap((r) => r.opts)
export function OrbPosControl({ id = 'wp-orbpos' }: { id?: string }) {
  const s = useWatch()
  // One radio group across both rows: one tab stop, arrows move and pick.
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    const i = ORB_POS.findIndex((p) => p.id === s.orbPos)
    const next = ORB_POS[(i + d + ORB_POS.length) % ORB_POS.length]!
    setOrbPos(next.id)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-pos="${next.id}"]`)?.focus()
  }
  return (
    <div className="wp-orbpos">
      <span className="field-label" id={id}>Cameras</span>
      <div className="wp-orbpos-rows" role="radiogroup" aria-labelledby={id} onKeyDown={onKey}>
        {ORB_ROWS.map((r) => (
          <div key={r.label} className="wp-orbpos-row">
            <span className="meta" aria-hidden="true">{r.label}</span>
            <div className={`seg ${r.opts.length === 3 ? 'seg-3' : ''}`}>
              {r.opts.map((p) => {
                const on = s.orbPos === p.id
                return (
                  <button
                    key={p.id} type="button" role="radio" className="seg-tab" data-pos={p.id} aria-checked={on} aria-label={p.name}
                    data-state={on ? 'active' : 'inactive'} tabIndex={on ? 0 : -1} onClick={() => setOrbPos(p.id)}
                  >{p.label}</button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ActionRow({ s }: { s: WatchState }) {
  const live = s.status === 'live'
  const [rallyOpen, setRallyOpen] = useState(false)
  const [nameOpen, setNameOpen] = useState(false)
  const [rallying, setRallying] = useState(false)
  const doRally = useCallback(async () => {
    setRallying(true)
    try {
      await rally()
      toast('Rally sent to the squad', 'success')
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "Couldn't send the rally", 'error')
    } finally {
      setRallying(false)
    }
  }, [])
  const c = s.call
  return (
    <section className="glass wp-actions" aria-label="Call and party">
      <div className="wp-action-row">
        {!c.on ? (
          <button type="button" className="btn btn-primary" disabled={!live || c.busy || !canCall()} onClick={() => void joinCall()}>
            <Icon name="cam" />{c.busy ? 'Starting…' : 'Join with camera + mic'}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" aria-pressed={c.muted} onClick={toggleMute}>
              <Icon name={c.muted ? 'micOff' : 'mic'} />{c.muted ? 'Unmute' : 'Mute'}
            </button>
            {!c.micOnly && (
              <button type="button" className="btn btn-secondary" aria-pressed={c.camOff} onClick={toggleVideo}>
                <Icon name={c.camOff ? 'cam' : 'camOff'} />{c.camOff ? 'Camera on' : 'Camera off'}
              </button>
            )}
            {!c.micOnly && <button type="button" className="icon-btn" aria-label="Flip camera" disabled={c.busy} onClick={() => void flipCam()}><Icon name="flip" /></button>}
            <button type="button" className="btn btn-danger" onClick={leaveCall}><Icon name="leave" />Leave call</button>
          </>
        )}
        <button type="button" className="btn btn-secondary" disabled={!live || rallying} onClick={() => setRallyOpen(true)}><Icon name="megaphone" />Rally</button>
        <button type="button" className="btn btn-secondary" disabled={!s.cfg} onClick={() => setNameOpen(true)}><Icon name="edit" />Display name</button>
      </div>
      {c.note && <p className="meta wp-call-note" role="status">{c.note}</p>}
      {!c.on && live && !canCall() && <p className="meta">This browser can't share a camera.</p>}
      {c.on && (s.mics.length > 1 || s.speakers.length > 1) && <Devices s={s} />}
      <OrbPosControl />
      <ConfirmDialog
        open={rallyOpen} onOpenChange={setRallyOpen} title="Rally the squad?" action="Send rally"
        body={<p>Posts to the squad's WhatsApp group: “@all … are on CRCMZ app {videoLabel() ? `watching ${videoLabel()}` : 'in the watch party'}. Join now!” with a link here.</p>}
        onConfirm={() => void doRally()}
      />
      <NameDialog s={s} open={nameOpen} onOpenChange={setNameOpen} />
    </section>
  )
}

function Devices({ s }: { s: WatchState }) {
  return (
    <div className="wp-devices">
      {s.mics.length > 1 && (
        <div>
          <label className="field-label" htmlFor="wp-mic">Microphone</label>
          <select id="wp-mic" className="input" value={s.micId} onChange={(e) => setMic(e.target.value)}>
            <option value="">Default</option>
            {s.mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </div>
      )}
      {s.speakers.length > 1 && (
        <div>
          <label className="field-label" htmlFor="wp-spk">Speaker</label>
          <select id="wp-spk" className="input" value={s.speakerId} onChange={(e) => setSpeaker(e.target.value)}>
            <option value="">Default</option>
            {s.speakers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </div>
      )}
    </div>
  )
}

function NameDialog({ s, open, onOpenChange }: { s: WatchState; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const name = await changeName(value.trim())
      toast(`You're ${name} in the party`, 'success')
      onOpenChange(false)
    } catch (err) {
      toast((err instanceof ApiError && err.detail) || "Couldn't change your name", 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (v) setValue(s.cfg?.viewer?.nickname || ''); onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="wp-name-desc">
          <Dialog.Title className="dialog-title">Display name</Dialog.Title>
          <p id="wp-name-desc" className="dim">What the room sees. Leave it empty to use {s.cfg?.viewer?.psnOnlineId || 'your account name'}.</p>
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="wp-name">Name</label>
            <input id="wp-name" className="input" value={value} maxLength={40} onChange={(e) => setValue(e.target.value)} autoFocus autoComplete="nickname" />
            <div className="dialog-actions">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
