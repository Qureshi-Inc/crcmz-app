// The TV player: the party, full screen. The video fills the screen and the party's
// cameras sit along its side (whoever's on camera; this TV joins with its own camera and
// mic only if it has them). Reactions float up, chat lines float in. The remote:
//   OK            play / pause, and bring up the controls
//   ← →           back / forward 10 s (presses add up, then it seeks once)
//   ↑ ↓           the controls; then the arrows move between them
//   Back          close a panel, hide the controls, then ask before leaving
//   ⏯ ⏪ ⏩        play/pause, ±30 s, any time
// The controls: the seek bar, then play and skip, subtitles, reactions, chat, camera, mic
// and ⚙ settings (everything about the cameras, sound, subtitles and the party).
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, type IconName } from '../../components/Icon'
import { toast } from '../../components/toast'
import { readLocal, writeLocal } from '../../lib/media'
import { loginUrl } from '../../lib/session'
import { fmtTime, REACTIONS } from '../../lib/watch'
import { exitGuarded, focusEl, focusFirst, useBackGuard } from '../../lib/tv'
import { Face, useTiles } from '../watch/Orbs'
import { FsChat, RxLayer } from '../watch/Stage'
import {
  attachVideo, attachYt, forceSync, getWatch, joinCall, leave, leaveCall, nameOf, rally, react, rejoin, retryMedia, sendChat, setCamVol, setMic,
  setPlayerVol, setSubtitle, start, time, toggleCamsMute, toggleMute, togglePlay, togglePlayerMute, toggleVideo, unblock, userSeek,
  useWatch, useWatchClock, videoLabel, type WatchState,
} from '../watch/session'

// ── Settings that belong to this TV ──────────────────────────────────────────
type Prefs = { cams: boolean; pos: 'right' | 'left' | 'bottom'; size: 's' | 'm' | 'l'; chat: boolean; rx: boolean; sub: 's' | 'm' | 'l'; hideAfter: number }
const PREFS_KEY = 'tv.player'
const DEFAULTS: Prefs = { cams: true, pos: 'right', size: 'm', chat: true, rx: true, sub: 'm', hideAfter: 5 }
function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const [p, setP] = useState<Prefs>(() => ({ ...DEFAULTS, ...readLocal<Partial<Prefs>>(PREFS_KEY, {}) }))
  const patch = (x: Partial<Prefs>) => setP((cur) => { const n = { ...cur, ...x }; writeLocal(PREFS_KEY, n); return n })
  return [p, patch]
}

/** Whether this TV has a camera / mic at all (most don't). */
function useDevices() {
  const [d, setD] = useState({ cam: true, mic: true })
  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices?.()
      .then((l) => setD({ cam: l.some((x) => x.kind === 'videoinput'), mic: l.some((x) => x.kind === 'audioinput') }))
      .catch(() => { /* unknown: offer both, joinCall copes */ })
  }, [])
  return d
}

/** Skips add up while the button is pressed again and again, then seek once: every seek
 *  restarts the film's transcode on the server, so five quick presses must be one seek. */
function useScrub() {
  const [target, setTarget] = useState<number | null>(null)
  const tgt = useRef<number | null>(null)
  const t = useRef(0)
  const by = (d: number) => {
    const base = tgt.current ?? time() ?? 0
    tgt.current = Math.max(0, base + d)
    setTarget(tgt.current)
    window.clearTimeout(t.current)
    t.current = window.setTimeout(() => {
      const to = tgt.current
      tgt.current = null
      setTarget(null)
      if (to !== null) userSeek(to)
    }, 700)
  }
  useEffect(() => () => window.clearTimeout(t.current), [])
  return { target, by }
}

type Panel = '' | 'rx' | 'chat' | 'cc' | 'settings' | 'leave'

export function TvPlayer() {
  const s = useWatch()
  const navigate = useNavigate()
  const [prefs, setPrefs] = usePrefs()
  const dev = useDevices()
  const scrub = useScrub()
  const [shown, setShown] = useState(true)
  const [peek, setPeek] = useState(false)
  const [panel, setPanelState] = useState<Panel>('')
  const opener = useRef('')
  const root = useRef<HTMLDivElement>(null)
  const hideT = useRef(0)
  const peekT = useRef(0)

  // The party runs while the player is open: joining, the room's video, the call (listening).
  useEffect(() => {
    start()
    return () => { if (getWatch().active) leave() }
  }, [])

  const card = statusCard(s)
  const pinned = !s.playing || !!s.unblock
  const chrome = !card && (shown || pinned || panel !== '')

  const live = useRef({ shown, panel, card: !!card, prefs })
  live.current = { shown, panel, card: !!card, prefs }

  const armHide = () => {
    window.clearTimeout(hideT.current)
    hideT.current = window.setTimeout(() => {
      const st = getWatch()
      if (st.playing && !st.unblock && !live.current.panel) hide()
    }, live.current.prefs.hideAfter * 1000)
  }
  const show = (focus = true) => {
    setPeek(false)
    setShown(true)
    armHide()
    if (focus) window.setTimeout(() => focusEl(document.getElementById('tvp-play') ?? root.current?.querySelector<HTMLElement>('.tvp-ctl')), 30)
  }
  const hide = () => { setShown(false); (document.activeElement as HTMLElement | null)?.blur?.() }
  const peekNow = () => {
    if (live.current.shown) { armHide(); return }
    setPeek(true)
    window.clearTimeout(peekT.current)
    peekT.current = window.setTimeout(() => setPeek(false), 2500)
  }
  useEffect(() => () => { window.clearTimeout(hideT.current); window.clearTimeout(peekT.current) }, [])
  // Playing again after a pause: the controls fade on their own.
  useEffect(() => { if (s.playing) armHide() }, [s.playing]) // eslint-disable-line react-hooks/exhaustive-deps

  const setPanel = (p: Panel, from = '') => {
    if (p) opener.current = from || (document.activeElement as HTMLElement | null)?.id || ''
    setPanelState(p)
    if (!p) window.setTimeout(() => { focusEl(document.getElementById(opener.current) ?? document.getElementById('tvp-play')); armHide() }, 30)
  }
  const exit = () => { leave(); exitGuarded(() => navigate('/tv', { replace: true })) }

  const onBack = () => {
    const { panel: p, shown: sh } = live.current
    if (p === 'leave') { setPanel(''); return }
    if (p) { setPanel(''); return }
    if (sh && getWatch().playing) { hide(); return }
    setPanel('leave')
  }
  useBackGuard(true, onBack)

  // The remote, before the focus mover sees it (capture phase).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key
      const { shown: sh, panel: p, card: cd } = live.current
      if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') { e.preventDefault(); togglePlay(); peekNow(); return }
      if (k === 'MediaFastForward' || k === 'MediaTrackNext') { e.preventDefault(); scrub.by(30); peekNow(); return }
      if (k === 'MediaRewind' || k === 'MediaTrackPrevious') { e.preventDefault(); scrub.by(-30); peekNow(); return }
      if (k === 'Escape' || k === 'GoBack' || k === 'BrowserBack') { e.preventDefault(); onBack(); return }
      if (p || cd) return                       // a panel or a message: the arrows move inside it
      const st = getWatch()
      if (!sh && st.kind && st.playing) {
        if (k === 'Enter' || k === ' ') { e.preventDefault(); togglePlay(); show(); return }
        if (k === 'ArrowLeft') { e.preventDefault(); scrub.by(-10); peekNow(); return }
        if (k === 'ArrowRight') { e.preventDefault(); scrub.by(10); peekNow(); return }
        if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); show(); return }
        return
      }
      // Controls up: any key keeps them there a while longer; nothing focused yet, focus play.
      armHide()
      if (!root.current?.contains(document.activeElement) && k.startsWith('Arrow')) { e.preventDefault(); show() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // A message on screen (connecting, an error, nothing on): its first button gets focus.
  const cardKey = card?.key ?? ''
  useEffect(() => {
    if (!cardKey) { show(); return }
    const t = window.setTimeout(() => focusFirst(root.current?.querySelector('.tvp-card') ?? undefined), 40)
    return () => window.clearTimeout(t)
  }, [cardKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="tvp" ref={root} data-chrome={chrome} data-cams={prefs.cams ? prefs.pos : 'off'} data-camsize={prefs.size} data-sub={prefs.sub}>
      <video ref={attachVideo} className="tvp-video" playsInline preload="auto" hidden={s.kind !== 'file'} />
      <div ref={attachYt} className="tvp-yt" hidden={s.kind !== 'yt'} />
      {prefs.cams && <Cams s={s} />}
      {prefs.rx && <RxLayer />}
      {prefs.chat && panel !== 'chat' && <div className="tvp-floatchat"><FsChat /></div>}
      {card && <StatusCard card={card} onExit={exit} />}
      {!card && s.unblock && (
        <button type="button" className="tv-btn tv-btn-primary tvp-unblock" data-tv-autofocus onClick={unblock}>
          <Icon name={s.unblock === 'unmute' ? 'vol' : 'play'} />{s.unblock === 'unmute' ? 'Press OK for sound' : 'Press OK to play with the room'}
        </button>
      )}
      {chrome && <Chrome s={s} dev={dev} scrub={scrub} panel={panel} setPanel={setPanel} />}
      {!chrome && peek && !card && <PeekBar s={s} target={scrub.target} />}
      {panel === 'rx' && <RxPanel online={s.status === 'live'} />}
      {panel === 'chat' && <ChatPanel s={s} />}
      {panel === 'cc' && <CcPanel s={s} onDone={() => setPanel('')} />}
      {panel === 'settings' && <SettingsPanel s={s} prefs={prefs} setPrefs={setPrefs} dev={dev} onLeave={() => setPanel('leave')} />}
      {panel === 'leave' && (
        <div className="tv-scrim">
          <div className="tv-dialog" role="dialog" aria-modal="true" aria-label="Leave the watch party?" data-tv-trap>
            <h2 className="tv-dialog-h">Leave the watch party?</h2>
            <p>The movie keeps going for everyone else. You can join again from the home screen.</p>
            <div className="tv-dialog-acts">
              <AutoFocus><button type="button" className="tv-btn tv-btn-primary" onClick={() => setPanel('')}>Keep watching</button></AutoFocus>
              <button type="button" className="tv-btn" onClick={exit}><Icon name="leave" />Leave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Focuses its child when it mounts. */
function AutoFocus({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => { const t = window.setTimeout(() => focusEl(ref.current?.querySelector<HTMLElement>('button, input')), 30); return () => window.clearTimeout(t) }, [])
  return <span ref={ref} className="tv-contents">{children}</span>
}

// ── Messages instead of the video ───────────────────────────────────────────
type Card = { key: string; title: string; text?: string; busy?: boolean; acts: { label: string; icon?: IconName; run: 'retry' | 'rejoin' | 'signin' | 'exit' }[] }
function statusCard(s: WatchState): Card | null {
  switch (s.status) {
    case 'connecting': case 'idle':
      return { key: 'connecting', title: 'Joining the party…', busy: true, acts: [{ label: 'Back to movies', run: 'exit' }] }
    case 'reconnecting':
      return s.kind ? null : { key: 'reconnecting', title: 'Reconnecting…', busy: true, acts: [{ label: 'Back to movies', run: 'exit' }] }
    case 'signin':
      return { key: 'signin', title: 'Sign in again', text: 'Your sign-in on this TV ran out.', acts: [{ label: 'Sign in', run: 'signin' }, { label: 'Back to movies', run: 'exit' }] }
    case 'forbidden':
      return { key: 'forbidden', title: 'Link your PSN account to join', text: s.error || 'Do it in the CRCMZ app on your phone (Settings → PSN), then come back.', acts: [{ label: 'Back to movies', run: 'exit' }] }
    case 'kicked':
      return { key: 'kicked', title: 'A moderator removed you from the party', acts: [{ label: 'Join again', run: 'rejoin' }, { label: 'Back to movies', run: 'exit' }] }
    case 'failed': case 'unavailable':
      return { key: 'failed', title: "Can't reach the watch party", text: s.status === 'failed' && s.error ? s.error : 'The Watch Party server is not answering.', acts: [{ label: 'Try again', icon: 'refresh', run: 'rejoin' }, { label: 'Back to movies', run: 'exit' }] }
  }
  if (s.mediaError) {
    return s.mediaError === 'unsupported'
      ? { key: 'unsupported', title: "This isn't a video the TV can play", acts: [{ label: 'Back to movies', run: 'exit' }] }
      : { key: 'media', title: 'The stream dropped', text: 'Retry picks it up where it stopped.', acts: [{ label: 'Retry', icon: 'refresh', run: 'retry' }, { label: 'Back to movies', run: 'exit' }] }
  }
  if (!s.video) return { key: 'empty', title: "Nothing's playing yet", text: 'Pick a movie and it starts for everyone in the party.', acts: [{ label: 'Pick a movie', icon: 'left', run: 'exit' }] }
  return null
}

function StatusCard({ card, onExit }: { card: Card; onExit: () => void }) {
  const run = (r: Card['acts'][number]['run']) => {
    if (r === 'retry') retryMedia()
    else if (r === 'rejoin') rejoin()
    else if (r === 'signin') location.assign(loginUrl('/app/tv'))
    else onExit()
  }
  return (
    <div className="tvp-card-wrap">
      <div className="tvp-card" role="alert" data-tv-trap>
        {card.busy && <span className="tv-spinner" aria-hidden="true" />}
        <h2 className="tv-dialog-h">{card.title}</h2>
        {card.text && <p>{card.text}</p>}
        <div className="tv-dialog-acts">
          {card.acts.map((a, i) => (
            <button key={a.run} type="button" className={`tv-btn${i === 0 && !card.busy ? ' tv-btn-primary' : ''}`} onClick={() => run(a.run)}>
              {a.icon && <Icon name={a.icon} />}{a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── The cameras ─────────────────────────────────────────────────────────────
function Cams({ s }: { s: WatchState }) {
  const tiles = useTiles(s)
  if (!tiles.length) return null
  return (
    <ul className="tvp-cams" aria-label="Cameras">
      {tiles.map((t) => (
        <li key={t.id} className="tvp-cam" data-loud={!!s.loud[t.me ? 'me' : t.id]}>
          <Face t={t} s={s} mirror={t.me && s.call.facing === 'user'} />
          <span className="tvp-cam-name">{t.me ? 'You' : t.name}<span aria-hidden="true">{t.badge}</span></span>
        </li>
      ))}
    </ul>
  )
}

// ── The controls ────────────────────────────────────────────────────────────
type Dev = { cam: boolean; mic: boolean }
type Scrub = ReturnType<typeof useScrub>

function Chrome({ s, dev, scrub, panel, setPanel }: { s: WatchState; dev: Dev; scrub: Scrub; panel: Panel; setPanel: (p: Panel, from?: string) => void }) {
  const c = useWatchClock()
  const label = videoLabel()
  const isLive = c.live || !Number.isFinite(c.dur)
  const names = s.presence.viewers.map((v) => v.name).filter(Boolean)
  const hasCc = s.kind === 'yt' || s.subs.length > 0
  const ccOn = s.sub !== null || s.ytCc
  const toggle = (p: Panel, id: string) => setPanel(panel === p ? '' : p, id)
  const camLabel = !dev.cam ? (s.call.on ? 'In the call' : 'Join the call') : !s.call.on ? 'Join with camera' : s.call.micOnly ? 'No camera' : s.call.camOff ? 'Camera on' : 'Camera off'
  const micLabel = !dev.mic ? 'No mic on this TV' : !s.call.on || s.call.muted ? 'Talk' : 'Mute'
  async function mic() {
    if (!s.call.on) { await joinCall(); if (!getWatch().call.on) return }
    await toggleMute()
  }
  return (
    <div className="tvp-chrome">
      <div className="tvp-top">
        <div>
          <p className="tvp-title">{label || 'Watch Party'}</p>
          <p className="tvp-sub">
            <span className="tv-dot" aria-hidden="true" />{s.presence.count || 1} watching{names.length ? ` · ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}` : ''}
          </p>
        </div>
        {s.call.note && <p className="tvp-note" role="status">{s.call.note}</p>}
      </div>
      <div className="tvp-bottom">
        {!isLive && s.kind && <Seek t={c.t} dur={c.dur} buf={c.buf} target={scrub.target} onScrub={scrub.by} />}
        {isLive && s.kind && <p className="tvp-live"><span className="tv-dot" aria-hidden="true" />LIVE</p>}
        <div className="tvp-row" role="toolbar" aria-label="Player">
          <Ctl icon="back10" label="Back 10 s" onClick={() => scrub.by(-10)} disabled={isLive || !s.kind} />
          <Ctl id="tvp-play" icon={s.playing ? 'pause' : 'play'} label={s.playing ? 'Pause' : 'Play'} onClick={togglePlay} big disabled={!s.kind} />
          <Ctl icon="fwd10" label="Forward 10 s" onClick={() => scrub.by(10)} disabled={isLive || !s.kind} />
          <span className="tvp-gap" />
          {hasCc && <Ctl id="tvp-cc" icon="cc" label={ccOn ? 'Subtitles on' : 'Subtitles'} pressed={ccOn} onClick={() => (s.kind === 'yt' ? setSubtitle(s.ytCc ? null : 0) : toggle('cc', 'tvp-cc'))} />}
          <Ctl id="tvp-rx" icon="smile" label="React" pressed={panel === 'rx'} onClick={() => toggle('rx', 'tvp-rx')} />
          <Ctl id="tvp-chat" icon="chat" label="Chat" pressed={panel === 'chat'} onClick={() => toggle('chat', 'tvp-chat')} />
          <Ctl id="tvp-cam" icon={s.call.on && !s.call.camOff && !s.call.micOnly ? 'cam' : 'camOff'} label={camLabel}
            pressed={s.call.on && !s.call.camOff && !s.call.micOnly} disabled={s.call.busy || (s.call.on && (s.call.micOnly || !dev.cam))}
            onClick={() => (s.call.on ? toggleVideo() : void joinCall())} />
          <Ctl id="tvp-mic" icon={s.call.on && !s.call.muted ? 'mic' : 'micOff'} label={micLabel} pressed={s.call.on && !s.call.muted}
            disabled={!dev.mic || s.call.busy} onClick={() => void mic()} />
          <Ctl id="tvp-set" icon="settings" label="Settings" pressed={panel === 'settings'} onClick={() => toggle('settings', 'tvp-set')} />
        </div>
      </div>
    </div>
  )
}

function Ctl({ icon, label, onClick, pressed, big, disabled, id }: {
  icon: IconName; label: string; onClick: () => void; pressed?: boolean; big?: boolean; disabled?: boolean; id?: string
}) {
  return (
    <button type="button" id={id} className={`tvp-ctl${big ? ' tvp-ctl-big' : ''}`} aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
      <span className="tvp-ctl-label" aria-hidden="true">{label}</span>
    </button>
  )
}

/** The seek bar. Focus it and ← → scrub (10 s a press, adding up); OK plays/pauses. */
function Seek({ t, dur, buf, target, onScrub }: { t: number; dur: number; buf: number; target: number | null; onScrub: (d: number) => void }) {
  const max = Number.isFinite(dur) && dur > 0 ? dur : 0
  const v = Math.min(target ?? t, max || Infinity)
  const pct = max ? (v / max) * 100 : 0
  const bpct = max ? Math.min(100, (buf / max) * 100) : 0
  function onKey(e: RKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      onScrub((e.key === 'ArrowLeft' ? -1 : 1) * (e.repeat ? 30 : 10))
    } else if (e.key === 'Enter') { e.preventDefault(); togglePlay() }
  }
  return (
    <div className="tvp-seek" tabIndex={0} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(v)}
      aria-valuetext={`${fmtTime(v)} of ${fmtTime(max)}`} onKeyDown={onKey} style={{ ['--p' as string]: `${pct}%`, ['--b' as string]: `${bpct}%` }}>
      <span className="tvp-time num">{fmtTime(v)}</span>
      <span className="tvp-track" aria-hidden="true"><i className="tvp-buf" /><i className="tvp-played" /><i className="tvp-knob" />{target !== null && <b className="tvp-tip num">{fmtTime(v)}</b>}</span>
      <span className="tvp-time num">-{fmtTime(Math.max(0, max - v))}</span>
    </div>
  )
}

/** ← / → with the controls hidden: just the bar, for a moment. */
function PeekBar({ s, target }: { s: WatchState; target: number | null }) {
  const c = useWatchClock()
  if (!s.kind || c.live) return null
  const max = Number.isFinite(c.dur) && c.dur > 0 ? c.dur : 0
  const v = target ?? c.t
  return (
    <div className="tvp-peek" style={{ ['--p' as string]: `${max ? (v / max) * 100 : 0}%`, ['--b' as string]: `${max ? Math.min(100, (c.buf / max) * 100) : 0}%` }}>
      <span className="tvp-time num">{fmtTime(v)}</span>
      <span className="tvp-track" aria-hidden="true"><i className="tvp-buf" /><i className="tvp-played" /><i className="tvp-knob" /></span>
      <span className="tvp-time num">-{fmtTime(Math.max(0, max - v))}</span>
    </div>
  )
}

// ── Panels ──────────────────────────────────────────────────────────────────
function RxPanel({ online }: { online: boolean }) {
  return (
    <div className="tvp-panel tvp-panel-rx" role="group" aria-label="React" data-tv-trap>
      {REACTIONS.map((e, i) => (
        <AutoFocusIf key={e} on={i === 0}>
          <button type="button" className="tvp-rx" disabled={!online} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>
        </AutoFocusIf>
      ))}
    </div>
  )
}
function AutoFocusIf({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <AutoFocus>{children}</AutoFocus> : <>{children}</>
}

const QUICK = ['😂😂😂', 'LMAO', 'No way', 'Pause pls', 'Brb', 'Who is this guy?', 'This is fire 🔥', 'Turn it up', 'Skip this part', 'Again!']

function ChatPanel({ s }: { s: WatchState }) {
  const [msg, setMsg] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const lines = s.chat.filter((m) => !m.cmd || m.cmd === 'host').slice(-14)
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }) }, [lines.length])
  const online = s.status === 'live'
  const send = (m: string) => { if (sendChat(m)) setMsg('') }
  return (
    <aside className="tvp-panel tvp-panel-side" aria-label="Chat" data-tv-trap>
      <h2 className="tvp-panel-h">Chat</h2>
      <ol className="tvp-chat" ref={list}>
        {lines.length === 0 && <li className="tv-meta">No messages yet. Say something.</li>}
        {lines.map((m, i) => (
          <li key={m.id + i}>{m.cmd === 'host' ? <span className="tv-meta">{nameOf(m.id)} started a video</span> : <><b>{nameOf(m.id)}</b> {m.msg}</>}</li>
        ))}
      </ol>
      <div className="tvp-quick">
        {QUICK.map((q, i) => (
          <AutoFocusIf key={q} on={i === 0}>
            <button type="button" className="tv-chip" disabled={!online} onClick={() => send(q)}>{q}</button>
          </AutoFocusIf>
        ))}
      </div>
      <form className="tvp-say" onSubmit={(e) => { e.preventDefault(); send(msg) }}>
        <input className="tv-input" value={msg} maxLength={500} placeholder={online ? 'Type a message' : 'Connecting…'} disabled={!online}
          onChange={(e) => setMsg(e.target.value)} enterKeyHint="send" autoComplete="off" aria-label="Message" />
        <button type="submit" className="tvp-ctl" aria-label="Send" disabled={!online || !msg.trim()}><Icon name="send" /></button>
      </form>
    </aside>
  )
}

function CcPanel({ s, onDone }: { s: WatchState; onDone: () => void }) {
  const pick = (i: number | null) => { setSubtitle(i); onDone() }
  return (
    <aside className="tvp-panel tvp-panel-side tvp-panel-narrow" aria-label="Subtitles" data-tv-trap>
      <h2 className="tvp-panel-h">Subtitles</h2>
      <AutoFocusIf on={s.sub === null}>
        <button type="button" className="tvs-row" aria-pressed={s.sub === null} onClick={() => pick(null)}><span className="tvs-label">Off</span>{s.sub === null && <Icon name="eye" />}</button>
      </AutoFocusIf>
      {s.subs.map((t) => (
        <AutoFocusIf key={t.index} on={s.sub === t.index}>
          <button type="button" className="tvs-row" aria-pressed={s.sub === t.index} onClick={() => pick(t.index)}>
            <span className="tvs-label">{t.label}{t.forced ? ' (forced)' : ''}</span>{s.sub === t.index && <Icon name="eye" />}
          </button>
        </AutoFocusIf>
      ))}
    </aside>
  )
}

// ── ⚙ Settings: a list of rows; ← → change a value, OK changes it too ────────
function SettingsPanel({ s, prefs, setPrefs, dev, onLeave }: { s: WatchState; prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; dev: Dev; onLeave: () => void }) {
  const c = s.call
  const pct = (v: number, m: boolean) => (m ? 0 : Math.round(v * 100))
  return (
    <aside className="tvp-panel tvp-panel-side" aria-label="Settings" data-tv-trap>
      <h2 className="tvp-panel-h">Settings</h2>
      <div className="tvs-scroll">
        <h3 className="tvs-h">Sound</h3>
        <AutoFocus><Slider label="Movie volume" value={pct(s.playerVol, s.playerMuted)} onChange={(v) => setPlayerVol(v / 100)} onToggle={togglePlayerMute} /></AutoFocus>
        <Slider label="Cameras volume" value={pct(s.camVol, s.camMuted)} onChange={(v) => setCamVol(v / 100)} onToggle={toggleCamsMute} />

        {(s.subs.length > 0 || s.kind === 'yt') && <>
          <h3 className="tvs-h">Subtitles</h3>
          {s.kind === 'yt'
            ? <Toggle label="YouTube captions" on={s.ytCc} onChange={(v) => setSubtitle(v ? 0 : null)} />
            : <Choice label="Subtitles" value={s.sub} options={[{ v: null, label: 'Off' }, ...s.subs.map((t) => ({ v: t.index as number | null, label: t.label }))]} onChange={setSubtitle} />}
          <Choice<Prefs['sub']> label="Subtitle size" value={prefs.sub} options={[{ v: 's', label: 'Small' }, { v: 'm', label: 'Medium' }, { v: 'l', label: 'Large' }]} onChange={(v) => setPrefs({ sub: v })} />
        </>}

        <h3 className="tvs-h">Cameras on screen</h3>
        <Toggle label="Show cameras" on={prefs.cams} onChange={(v) => setPrefs({ cams: v })} />
        <Choice<Prefs['pos']> label="Where" value={prefs.pos} options={[{ v: 'right', label: 'Right' }, { v: 'left', label: 'Left' }, { v: 'bottom', label: 'Bottom' }]} onChange={(v) => setPrefs({ pos: v })} disabled={!prefs.cams} />
        <Choice<Prefs['size']> label="Size" value={prefs.size} options={[{ v: 's', label: 'Small' }, { v: 'm', label: 'Medium' }, { v: 'l', label: 'Large' }]} onChange={(v) => setPrefs({ size: v })} disabled={!prefs.cams} />

        <h3 className="tvs-h">This TV in the call</h3>
        {!dev.cam && !dev.mic
          ? <p className="tv-meta tvs-note">This TV has no camera or mic. You still see and hear everyone who's on camera.</p>
          : <>
            {dev.cam && <Action label={!c.on ? 'Join with camera' : c.camOff ? 'Turn camera on' : 'Turn camera off'} icon="cam" disabled={c.busy || (c.on && c.micOnly)} onClick={() => (c.on ? toggleVideo() : void joinCall())} />}
            {c.on && s.mics.length > 1 && <Choice label="Mic" value={s.micId || s.mics[0]!.id} options={s.mics.map((m) => ({ v: m.id, label: m.label }))} onChange={setMic} />}
            {c.on && <Action label="Leave the call" icon="leave" onClick={leaveCall} />}
          </>}

        <h3 className="tvs-h">On screen</h3>
        <Toggle label="Chat over the movie" on={prefs.chat} onChange={(v) => setPrefs({ chat: v })} />
        <Toggle label="Reactions over the movie" on={prefs.rx} onChange={(v) => setPrefs({ rx: v })} />
        <Choice label="Hide the controls after" value={prefs.hideAfter} options={[{ v: 3, label: '3 s' }, { v: 5, label: '5 s' }, { v: 10, label: '10 s' }]} onChange={(v) => setPrefs({ hideAfter: v })} />

        <h3 className="tvs-h">Party</h3>
        <Action label="Sync to the room" icon="sync" onClick={forceSync} />
        <Action label="Reload the stream" icon="refresh" onClick={retryMedia} disabled={!s.video} />
        <Action label="Ring everyone" icon="megaphone" onClick={() => { void rally().then(() => toast('Rang the squad', 'success')).catch(() => toast("Couldn't ring them", 'error')) }} />
        <Action label="Leave the party" icon="leave" onClick={onLeave} />

        <h3 className="tvs-h">Stream</h3>
        <StreamInfo s={s} />
      </div>
    </aside>
  )
}

function Row({ label, value, onClick, onKey, disabled, pressed }: { label: string; value?: ReactNode; onClick: () => void; onKey?: (d: -1 | 1) => void; disabled?: boolean; pressed?: boolean }) {
  return (
    <button type="button" className="tvs-row" disabled={disabled} aria-pressed={pressed} onClick={onClick}
      onKeyDown={(e) => {
        if (!onKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault()
        onKey(e.key === 'ArrowLeft' ? -1 : 1)
      }}>
      <span className="tvs-label">{label}</span>
      {value !== undefined && <span className="tvs-value">{value}</span>}
    </button>
  )
}
function Choice<T>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  const i = Math.max(0, options.findIndex((o) => o.v === value))
  const step = (d: number) => onChange(options[(i + d + options.length) % options.length]!.v)
  return <Row label={label} disabled={disabled} value={<><Icon name="left" />{options[i]?.label}<Icon name="right" /></>} onClick={() => step(1)} onKey={step} />
}
function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return <Row label={label} pressed={on} value={<span className="tvs-switch" data-on={on} />} onClick={() => onChange(!on)} onKey={(d) => onChange(d > 0)} />
}
function Slider({ label, value, onChange, onToggle }: { label: string; value: number; onChange: (v: number) => void; onToggle: () => void }) {
  return (
    <Row label={label} onClick={onToggle} onKey={(d) => onChange(Math.max(0, Math.min(100, value + d * 10)))}
      value={<><span className="tvs-meter" style={{ ['--v' as string]: `${value}%` }} /><span className="num tvs-num">{value === 0 ? 'Muted' : `${value}%`}</span></>} />
  )
}
function Action({ label, icon, onClick, disabled }: { label: string; icon: IconName; onClick: () => void; disabled?: boolean }) {
  return <Row label={label} disabled={disabled} value={<Icon name={icon} />} onClick={onClick} />
}

/** What the stream is doing right now: handy when it stutters. */
function StreamInfo({ s }: { s: WatchState }) {
  const c = useWatchClock()
  const [q, setQ] = useState({ w: 0, h: 0, dropped: 0, total: 0 })
  useEffect(() => {
    const read = () => {
      const v = document.querySelector<HTMLVideoElement>('.tvp-video')
      const pq = v?.getVideoPlaybackQuality?.()
      setQ({ w: v?.videoWidth ?? 0, h: v?.videoHeight ?? 0, dropped: pq?.droppedVideoFrames ?? 0, total: pq?.totalVideoFrames ?? 0 })
    }
    read()
    const t = window.setInterval(read, 1000)
    return () => window.clearInterval(t)
  }, [])
  const ahead = Math.max(0, c.buf - c.t)
  return (
    <dl className="tvs-info num">
      <div><dt>Picture</dt><dd>{s.kind === 'yt' ? 'YouTube' : q.w ? `${q.w}×${q.h}` : '—'}</dd></div>
      <div><dt>Buffered ahead</dt><dd>{s.kind === 'file' ? `${Math.round(ahead)} s` : '—'}</dd></div>
      <div><dt>Dropped frames</dt><dd>{q.total ? `${q.dropped} of ${q.total}` : '—'}</dd></div>
      <div><dt>Party</dt><dd>{s.status}{s.presence.count ? ` · ${s.presence.count} here` : ''}</dd></div>
    </dl>
  )
}
