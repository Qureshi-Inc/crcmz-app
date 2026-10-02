// PS-6 · Watch Party: one screen, the whole squad. The Shell keeps this page
// mounted once the party starts (a moved iframe reloads, a detached <video>
// pauses), so leaving /watch keeps the video and the call going; the Watch bar
// brings you back.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip } from '../../components/states'
import { useDesktop } from '../../lib/media'
import { ringSquad } from '../../lib/ring'
import { loginUrl } from '../../lib/session'
import { Library, useMoviesOff } from './Library'
import { Orbs } from './Orbs'
import { Chat, PresencePill, ReactionsTray, Roster } from './Social'
import { Stage, usePlayerKeys } from './Stage'
export { OrbPosControl } from './Settings'
import {
  attachLayout, canCall, clearVideo, exitFs, joinCall, leave, rejoin, setTitle, setVideo, start, useWatch, videoLabel, type WatchState,
} from './session'
import { HelpLink } from '../../components/HelpLink'

export function WatchPage({ visible }: { visible: boolean }) {
  const s = useWatch()
  const desktop = useDesktop()
  const [rxOpen, setRxOpen] = useState(false)
  const moviesOff = useMoviesOff()
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  useEffect(() => { if (visible) start() }, [visible])
  // Fullscreen belongs to this page; navigating away ends it.
  useEffect(() => { if (!visible) exitFs() }, [visible])
  usePlayerKeys(visible, setRxOpen)

  // Fullscreen has no room outside the video: the cameras always float on it, like the classic player.
  const pos = s.fs && (s.orbPos === 'top' || s.orbPos === 'bottom') ? 'overBottom' : s.orbPos
  const onVideo = { over: 'side', overTop: 'top', overBottom: 'bottom' } as const
  const over = pos in onVideo ? <Orbs variant={onVideo[pos as keyof typeof onVideo]} /> : null
  return (
    <div className="page watch-page" data-hidden={!visible} inert={!visible} aria-hidden={!visible || undefined}>
      {visible && <WatchTitle />}
      <div className="wp-head">
        {!moviesOff && <Link className="btn btn-ghost wp-movies" to="/watch" aria-label="Back to Movies"><Icon name="left" />Movies</Link>}
        <h1 className="page-h1" tabIndex={-1}>Watch Party<HelpLink id="watch" /></h1>
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
            {pos === 'top' && <Orbs variant="strip" />}
            <Stage over={over} rxOpen={rxOpen} setRxOpen={setRxOpen} slot={desktop ? null : slot} />
            {pos === 'bottom' && <Orbs variant="strip" />}
          </div>
          {/* A phone's player is too short for the ⚙ panel: outside fullscreen it opens here. */}
          {!desktop && <div ref={setSlot} className="wp-set-slot" />}
          <VideoForm s={s} />
          <CallRow s={s} />
        </div>
        <aside className="wp-side" aria-label="Reactions and chat">
          <ReactionsTray disabled={s.status !== 'live'} />
          <Chat />
        </aside>
      </div>
      <Library />
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
  // "Paste a link" on the Movies home lands here with ?paste=1, and the Android app's
  // Share → CRCMZ with ?url= / ?text= (a YouTube or video link shared from another app):
  // go straight to the box, with the shared link already in it.
  const loc = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const q = new URLSearchParams(loc.search)
    if (!/^\/watch\/party/.test(loc.pathname) || !['paste', 'url', 'text'].some((k) => q.has(k))) return
    const shared = [q.get('url'), q.get('text')].map((v) => /https?:\/\/\S+/i.exec(v || '')?.[0]).find(Boolean)
    if (shared) setUrl(shared.replace(/[)\].,!?'"]+$/, ''))
    navigate({ pathname: loc.pathname, search: '' }, { replace: true })
    const t = window.setTimeout(() => {
      urlRef.current?.scrollIntoView({ block: 'center' })
      urlRef.current?.focus({ preventScroll: true })
    }, 250)
    return () => window.clearTimeout(t)
  }, [loc.pathname, loc.search, navigate])
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

function CallRow({ s }: { s: WatchState }) {
  const live = s.status === 'live'
  const c = s.call
  const [ringing, setRinging] = useState(false)
  return (
    <section className="glass wp-actions" aria-label="Call">
      <div className="wp-action-row">
        {!c.on && (
          <button type="button" className="btn btn-primary" disabled={!live || c.busy || !canCall()} onClick={() => void joinCall()}>
            <Icon name="cam" />{c.busy ? 'Starting…' : 'Join with camera'}
          </button>
        )}
        <button
          type="button" className="btn btn-secondary" disabled={!live || ringing} title="Ring everyone's phone into the Watch Party"
          onClick={() => { setRinging(true); void ringSquad('watch').finally(() => setRinging(false)) }}
        >
          <Icon name="phone" />{ringing ? 'Ringing…' : 'Ring everyone'}
        </button>
      </div>
      {c.note && <p className="meta wp-call-note" role="status">{c.note}</p>}
      {!c.on && live && !canCall() && <p className="meta">This browser can't share a camera.</p>}
      <p className="meta">Camera, mic, reactions and <Icon name="settings" className="nav-icon wp-inline-icon" /> settings (camera position, name, rally) are in the player.</p>
    </section>
  )
}
