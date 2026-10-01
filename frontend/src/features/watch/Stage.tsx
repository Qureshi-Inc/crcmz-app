// The player: a 16:9 stage with a YouTube-style overlay. Centre: back 10 s,
// play/pause, forward 10 s. Bottom: the seek bar, then play, volume, time, and the
// call, reactions, ⚙ settings and fullscreen controls. It hides itself while playing;
// a tap (or a mouse move) brings it back, and it never hides while you're using it.
// The call controls and ⚙ show even with nothing playing.
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { useReducedMotion } from '../../lib/media'
import { CAN_VOL, fmtTime, REACTIONS } from '../../lib/watch'
import {
  attachVideo, attachYt, clearVideo, forceSync, getWatch, joinCall, leaveCall, nameOf as nameMap, onChat, onReaction, react, sendChat, setCamVol, setPlayerVol,
  skip, toggleCamsMute, toggleFs, toggleMute, togglePlay, togglePlayerMute, toggleVideo, unblock, userSeek, useWatch, useWatchClock,
  videoLabel, type ChatMsg, type RxEvent, type WatchState,
} from './session'
import { PlayerSettings } from './Settings'

const HIDE_AFTER_POKE = 2600
const HIDE_AFTER_TAP = 3500
const DOUBLE_TAP = 250
const CLICK_DELAY = 220

export function Stage({ over, rxOpen, setRxOpen, slot }: { over?: ReactNode; rxOpen: boolean; setRxOpen: (v: boolean) => void; slot?: HTMLElement | null }) {
  const s = useWatch()
  const stage = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(true)
  const [hold, setHold] = useState(0) // open menus, drags, focus inside: anything that keeps the chrome up
  const hideT = useRef(0)
  const poke = (ms = HIDE_AFTER_POKE) => {
    setShown(true)
    window.clearTimeout(hideT.current)
    hideT.current = window.setTimeout(() => setShown(false), ms)
  }
  useEffect(() => () => window.clearTimeout(hideT.current), [])
  // Re-arm the hide timer whenever playback starts.
  useEffect(() => { if (s.playing) poke() }, [s.playing])
  const holdOn = () => setHold((n) => n + 1)
  const holdOff = () => { setHold((n) => Math.max(0, n - 1)); poke() }
  const [setOpen, setSetOpen] = useState(false)
  const closeSettings = () => { setSetOpen(false); document.getElementById('wp-set-btn')?.focus({ preventScroll: true }) }
  const chrome = shown || hold > 0 || !s.playing || !s.video || rxOpen || setOpen

  const [ripple, setRipple] = useState<{ side: 'l' | 'r'; n: number } | null>(null)
  const rippleT = useRef(0)
  const seekBy = (by: number) => {
    skip(by)
    setRipple((r) => ({ side: by < 0 ? 'l' : 'r', n: (r?.side === (by < 0 ? 'l' : 'r') ? r.n : 0) + 10 }))
    window.clearTimeout(rippleT.current)
    rippleT.current = window.setTimeout(() => setRipple(null), 700)
  }

  // Touch: a tap shows/hides the chrome; a double tap on either side seeks 10 s.
  // Mouse: a click plays/pauses, a double click goes fullscreen.
  const lastTap = useRef<{ at: number; side: 'l' | 'm' | 'r' } | null>(null)
  const tapT = useRef(0)
  function onTap(e: RPointerEvent<HTMLDivElement>) {
    if (!s.kind) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const side = x < 1 / 3 ? 'l' : x > 2 / 3 ? 'r' : 'm'
    const now = Date.now()
    const prev = lastTap.current
    window.clearTimeout(tapT.current)
    if (e.pointerType === 'mouse') {
      if (prev && now - prev.at < CLICK_DELAY * 1.6) { lastTap.current = null; toggleFs(); return }
      lastTap.current = { at: now, side }
      tapT.current = window.setTimeout(() => { togglePlay(); poke() }, CLICK_DELAY)
      return
    }
    if (side !== 'm' && prev && prev.side === side && now - prev.at < DOUBLE_TAP * 1.6) {
      lastTap.current = { at: now, side }
      seekBy(side === 'l' ? -10 : 10)
      return
    }
    lastTap.current = { at: now, side }
    const single = () => { if (chrome && hold === 0 && s.playing) { window.clearTimeout(hideT.current); setShown(false) } else poke(HIDE_AFTER_TAP) }
    if (side === 'm') single()
    else tapT.current = window.setTimeout(single, DOUBLE_TAP)
  }

  const label = videoLabel()
  return (
    <div
      ref={stage}
      className="wp-stage"
      data-chrome={chrome}
      data-rx={rxOpen}
      data-kind={s.kind || 'none'}
      onPointerMove={(e) => { if (e.pointerType === 'mouse') poke() }}
      onFocus={holdOn}
      onBlur={holdOff}
    >
      <video ref={attachVideo} className="wp-video" playsInline preload="metadata" hidden={s.kind !== 'file'} />
      <div ref={attachYt} className="wp-yt" hidden={s.kind !== 'yt'} />
      {!s.video && <EmptyStage s={s} />}
      {s.mediaError && (
        <div className="wp-stage-msg" role="alert">
          <p>{s.mediaError === 'unsupported' ? "This link isn't a video we can play." : "This video won't play here"}</p>
          <button type="button" className="btn btn-secondary" onClick={clearVideo}>Clear</button>
        </div>
      )}
      {/* While a fresh YouTube embed waits for its first tap, let taps through to it. */}
      {s.kind && !s.mediaError && (
        <div className="wp-tap" data-pass={s.kind === 'yt' && s.ytFresh} onPointerUp={onTap} aria-hidden="true" />
      )}
      {ripple && <div className="wp-ripple" data-side={ripple.side} aria-hidden="true"><Icon name={ripple.side === 'l' ? 'back10' : 'fwd10'} /><span>{ripple.n} seconds</span></div>}
      {!s.mediaError && (
        <Overlay s={s} label={label} holdOn={holdOn} holdOff={holdOff} rxOpen={rxOpen} setRxOpen={setRxOpen} setOpen={setOpen} toggleSettings={() => (setOpen ? closeSettings() : setSetOpen(true))} />
      )}
      {s.unblock && (
        <button type="button" className="btn btn-primary wp-unblock" onClick={unblock}>
          <Icon name={s.unblock === 'unmute' ? 'vol' : 'play'} />{s.unblock === 'unmute' ? 'Tap for sound' : 'Tap to play with the room'}
        </button>
      )}
      <RxLayer />
      {s.fs && <FsChat />}
      {over}
      {setOpen && (slot && !s.fs
        ? createPortal(<PlayerSettings s={s} onClose={closeSettings} inline />, slot)
        : <PlayerSettings s={s} onClose={closeSettings} />)}
    </div>
  )
}

function EmptyStage({ s }: { s: WatchState }) {
  const live = s.status === 'live'
  return (
    <div className="wp-empty">
      <Icon name="watch" className="nav-icon wp-empty-icon" />
      <p className="wp-empty-title">{live ? 'Nothing playing yet — paste a link' : 'Connecting to the party…'}</p>
      {live && <p className="dim">YouTube, a video file or a page with a video on it.</p>}
    </div>
  )
}

function Ctl({ icon, label, onClick, pressed, expanded, big, disabled, className = '', id }: {
  icon: IconName; label: string; onClick: () => void; pressed?: boolean; expanded?: boolean; big?: boolean; disabled?: boolean; className?: string; id?: string
}) {
  return (
    <button
      type="button" id={id} className={`wp-ctl${big ? ' wp-ctl-big' : ''} ${className}`} aria-label={label} title={label}
      aria-pressed={pressed} aria-expanded={expanded} disabled={disabled} onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  )
}

function Overlay({ s, label, holdOn, holdOff, rxOpen, setRxOpen, setOpen, toggleSettings }: {
  s: WatchState; label: string; holdOn: () => void; holdOff: () => void; rxOpen: boolean; setRxOpen: (v: boolean) => void
  setOpen: boolean; toggleSettings: () => void
}) {
  const c = useWatchClock()
  const [volOpen, setVolOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const rxRef = useRef<HTMLDivElement>(null)
  useDismiss(rxOpen, rxRef, () => setRxOpen(false))
  useEffect(() => { if (!s.fs) setChatOpen(false) }, [s.fs])
  const idle = !s.kind
  const online = s.status === 'live'
  const live = c.live || !Number.isFinite(c.dur)
  const playLabel = s.playing ? 'Pause' : 'Play'
  const camLabel = !s.call.on ? 'Join with camera' : s.call.micOnly ? 'No camera' : s.call.camOff ? 'Turn camera on' : 'Turn camera off'
  return (
    <div className="wp-overlay">
      {idle ? <span /> : (
        <div className="wp-ov-top">
          <span className="wp-ov-title">{label || 'Watch Party'}</span>
          <Ctl icon="sync" label="Sync to the room" onClick={forceSync} />
        </div>
      )}
      {!idle && (
        <div className="wp-ov-mid">
          <Ctl icon="back10" label="Back 10 seconds" onClick={() => skip(-10)} disabled={live} />
          <Ctl icon={s.playing ? 'pause' : 'play'} label={playLabel} onClick={togglePlay} big />
          <Ctl icon="fwd10" label="Forward 10 seconds" onClick={() => skip(10)} disabled={live} />
        </div>
      )}
      <div className="wp-ov-bottom" data-idle={idle}>
        {rxOpen && (
          <div className="wp-rx-strip" role="group" aria-label="Send a reaction" ref={rxRef}>
            {REACTIONS.map((e) => <button key={e} type="button" className="wp-rx-btn" disabled={!online} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>)}
          </div>
        )}
        {chatOpen && <FsChatForm online={online} onDone={() => setChatOpen(false)} />}
        {!idle && !live && <Seek t={c.t} dur={c.dur} buf={c.buf} holdOn={holdOn} holdOff={holdOff} />}
        <div className="wp-ov-row">
          {!idle && (
            <>
              <Ctl icon={s.playing ? 'pause' : 'play'} label={playLabel} onClick={togglePlay} />
              <Volume s={s} open={volOpen} setOpen={(v) => { setVolOpen(v); if (v) holdOn(); else holdOff() }} />
              <span className="wp-time num">
                {live ? <><span className="wp-live-dot" aria-hidden="true" />LIVE</> : <>{fmtTime(c.t)}<span className="wp-time-sep"> / </span><span className="wp-time-dur">{fmtTime(c.dur)}</span></>}
              </span>
            </>
          )}
          <span className="wp-ov-spacer" />
          {s.call.on && <Ctl icon={s.call.muted ? 'micOff' : 'mic'} label={s.call.muted ? 'Unmute mic' : 'Mute mic'} onClick={toggleMute} pressed={!s.call.muted} />}
          <Ctl
            icon={s.call.on && (s.call.camOff || s.call.micOnly) ? 'camOff' : 'cam'} label={camLabel}
            onClick={() => (s.call.on ? toggleVideo() : void joinCall())} pressed={s.call.on && !s.call.camOff && !s.call.micOnly}
            disabled={s.call.busy || (s.call.on && s.call.micOnly)}
          />
          {s.call.on && <Ctl icon="leave" label="Leave call" onClick={leaveCall} className="wp-ctl-leave" />}
          <Ctl icon="smile" label={rxOpen ? 'Hide reactions' : 'Reactions'} onClick={() => setRxOpen(!rxOpen)} pressed={rxOpen} />
          {s.fs && <Ctl icon="chat" label={chatOpen ? 'Hide chat box' : 'Chat'} onClick={() => setChatOpen(!chatOpen)} pressed={chatOpen} />}
          <Ctl id="wp-set-btn" icon="settings" label="Settings" onClick={toggleSettings} expanded={setOpen} />
          <Ctl icon={s.fs ? 'fsExit' : 'fs'} label={s.fs ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFs} />
        </div>
      </div>
    </div>
  )
}

/** The seek bar: a range input over a painted track (played, buffered, knob), with a time bubble while dragging. */
function Seek({ t, dur, buf, holdOn, holdOff }: { t: number; dur: number; buf: number; holdOn: () => void; holdOff: () => void }) {
  const [drag, setDrag] = useState<number | null>(null)
  const max = Number.isFinite(dur) && dur > 0 ? dur : 0
  const v = drag ?? t
  const pct = max ? Math.min(100, (v / max) * 100) : 0
  const bpct = max ? Math.min(100, (buf / max) * 100) : 0
  const dragging = useRef(false)
  const end = () => {
    if (!dragging.current) return
    dragging.current = false
    setDrag((d) => { if (d !== null) userSeek(d); return null })
    holdOff()
  }
  useEffect(() => {
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end) }
  })
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const x = Number(e.target.value)
    if (dragging.current) setDrag(x)
    else userSeek(x) // keyboard
  }
  return (
    <div className="wp-seek" style={{ ['--p' as string]: `${pct}%`, ['--b' as string]: `${bpct}%` }}>
      <div className="wp-seek-track" aria-hidden="true"><i className="wp-seek-buf" /><i className="wp-seek-played" /><i className="wp-seek-knob" /></div>
      {drag !== null && <span className="wp-seek-tip num" aria-hidden="true">{fmtTime(drag)}</span>}
      <input
        type="range" className="wp-seek-input" min={0} max={max || 1} step={0.5} value={Math.min(v, max || 1)}
        aria-label="Seek" aria-valuetext={`${fmtTime(v)} of ${fmtTime(max)}`} disabled={!max}
        onPointerDown={() => { dragging.current = true; setDrag(t); holdOn() }}
        onChange={onChange}
      />
    </div>
  )
}

function Volume({ s, open, setOpen }: { s: WatchState; open: boolean; setOpen: (v: boolean) => void }) {
  const wrap = useRef<HTMLDivElement>(null)
  const icon: IconName = s.playerMuted || s.playerVol === 0 ? 'volMute' : s.playerVol < 0.5 ? 'volLow' : 'vol'
  useDismiss(open, wrap, () => setOpen(false))
  const pct = (v: number, m: boolean) => (m ? 0 : Math.round(v * 100))
  return (
    <div className="wp-vol" ref={wrap}>
      <button type="button" className="wp-ctl" aria-label="Volume" title="Volume" aria-expanded={open} aria-controls="wp-vol-pop" onClick={() => setOpen(!open)}>
        <Icon name={icon} />
      </button>
      {CAN_VOL && (
        <input
          type="range" className="wp-range wp-vol-inline" min={0} max={100} step={1} value={pct(s.playerVol, s.playerMuted)}
          aria-label="Video volume" onChange={(e) => setPlayerVol(Number(e.target.value) / 100)}
        />
      )}
      {open && (
        <div className="wp-vol-pop" id="wp-vol-pop" role="group" aria-label="Volume">
          <VolRow label="Video" muted={s.playerMuted || s.playerVol === 0} value={pct(s.playerVol, s.playerMuted)} onMute={togglePlayerMute} onVol={(v) => setPlayerVol(v)} />
          <VolRow label="Cameras" muted={s.camMuted || s.camVol === 0} value={pct(s.camVol, s.camMuted)} onMute={toggleCamsMute} onVol={(v) => setCamVol(v)} />
          {!CAN_VOL && <p className="meta">Use your phone's volume buttons for level.</p>}
        </div>
      )}
    </div>
  )
}
/** A tap outside, or Escape, closes a popover. Its own toggle button is left to toggle it. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  const fn = useRef(close)
  fn.current = close
  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!ref.current?.contains(t) && !t.closest?.('[aria-pressed="true"], [aria-expanded="true"]')) fn.current()
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); fn.current() } }
    document.addEventListener('pointerdown', off, true)
    document.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', esc, true) }
  }, [open, ref])
}

function VolRow({ label, muted, value, onMute, onVol }: { label: string; muted: boolean; value: number; onMute: () => void; onVol: (v: number) => void }) {
  return (
    <div className="wp-vol-row">
      <button type="button" className="wp-ctl" aria-label={muted ? `Unmute ${label.toLowerCase()}` : `Mute ${label.toLowerCase()}`} aria-pressed={muted} onClick={onMute}>
        <Icon name={muted ? 'volMute' : 'vol'} />
      </button>
      <span className="wp-vol-label">{label}</span>
      {CAN_VOL && (
        <input type="range" className="wp-range" min={0} max={100} step={1} value={value} aria-label={`${label} volume`} onChange={(e) => onVol(Number(e.target.value) / 100)} />
      )}
    </div>
  )
}

// ── Floating reactions ──────────────────────────────────────────────────────
type Floater = RxEvent & { id: number; x: number }
let floaterId = 0
function RxLayer() {
  const reduced = useReducedMotion()
  const [list, setList] = useState<Floater[]>([])
  const [burst, setBurst] = useState<{ e: string; id: number; n: number } | null>(null)
  useEffect(() => onReaction((r) => {
    const f: Floater = { ...r, id: ++floaterId, x: 8 + Math.random() * 30 }
    setList((l) => [...l.slice(-24), f])
    window.setTimeout(() => setList((l) => l.filter((x) => x.id !== f.id)), 2400)
    if (r.burst) {
      const b = { e: r.e, id: f.id, n: r.burst }
      setBurst(b)
      window.setTimeout(() => setBurst((cur) => (cur?.id === b.id ? null : cur)), 2200)
    }
  }), [])
  return (
    <div className="wp-rx-layer" aria-hidden="true" data-reduced={reduced}>
      {list.map((f) => (
        <span key={f.id} className="wp-floater" style={{ right: `${f.x}%` }}>
          <span className="wp-floater-e">{f.e}</span>
          <span className="wp-floater-name">{f.name}</span>
        </span>
      ))}
      {burst && (
        <div className="wp-burst" key={burst.id}>
          <span className="wp-burst-e">{burst.e}<span className="wp-burst-n">×{burst.n}</span></span>
          {/* Emoji confetti: two cannons from the bottom corners. */}
          {!reduced && Array.from({ length: 36 }, (_, i) => {
            const left = i % 2 === 0
            const dx = (left ? 1 : -1) * (20 + ((i * 37) % 50))
            const dy = 45 + ((i * 53) % 45)
            return (
              <i key={i} className="wp-confetti" style={{
                [left ? 'left' : 'right']: '2%', animationDelay: `${(i % 9) * 0.05}s`,
                ['--dx' as string]: `${dx}cqw`, ['--dy' as string]: `${-dy}cqh`, ['--r' as string]: `${((i * 97) % 720) - 360}deg`,
              }}>{burst.e}</i>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** In fullscreen the chat panel is out of view, so new lines float over the video for a few seconds. */
function FsChat() {
  const [lines, setLines] = useState<(ChatMsg & { k: number })[]>([])
  useEffect(() => onChat((m) => {
    if (m.cmd && m.cmd !== 'host') return
    const k = ++floaterId
    setLines((l) => [...l.slice(-5), { ...m, k }])
    window.setTimeout(() => setLines((l) => l.filter((x) => x.k !== k)), 30_000)
  }), [])
  if (!lines.length) return null
  return (
    <ul className="wp-fs-chat" aria-hidden="true">
      {lines.map((m) => (
        <li key={m.k}>
          {m.cmd === 'host' ? <span className="dim">{nameMap(m.id)} started a video</span> : <><b>{nameMap(m.id)}</b> {m.msg}</>}
        </li>
      ))}
    </ul>
  )
}

/** The chat box in fullscreen, where the chat panel is out of view. */
function FsChatForm({ online, onDone }: { online: boolean; onDone: () => void }) {
  const [msg, setMsg] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  function submit(e: FormEvent) {
    e.preventDefault()
    if (sendChat(msg)) setMsg('')
  }
  return (
    <form className="wp-fs-form" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone() } }}>
      <label className="sr-only" htmlFor="wp-fs-in">Message</label>
      <input id="wp-fs-in" ref={ref} className="input" value={msg} maxLength={500} placeholder={online ? 'Message the room' : 'Connecting…'} disabled={!online} onChange={(e) => setMsg(e.target.value)} enterKeyHint="send" autoComplete="off" />
      <button type="submit" className="wp-ctl" aria-label="Send" disabled={!online || !msg.trim()}><Icon name="send" /></button>
    </form>
  )
}

/** Page-scoped keys (JOURNEY PS-6): never while typing or while a dialog is open. */
export function usePlayerKeys(enabled: boolean, setRxOpen: (fn: (v: boolean) => boolean) => void) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]')) return
      // Buttons keep Space/Enter for themselves.
      if ((e.key === ' ' || e.key === 'Enter') && t?.closest('button, a, [role="tab"]')) return
      const s = getWatch()
      if (e.key === 'Escape' && s.fs) { toggleFs(); return }
      const k = e.key.toLowerCase()
      const acts: Record<string, () => void> = {
        ' ': togglePlay, k: togglePlay, arrowleft: () => skip(-5), arrowright: () => skip(5), j: () => skip(-10), l: () => skip(10),
        f: toggleFs, c: () => (s.call.on ? toggleVideo() : void joinCall()), m: toggleMute, e: () => setRxOpen((v) => !v),
      }
      const act = acts[k]
      if (!act) return
      if (['arrowleft', 'arrowright', ' ', 'k', 'j', 'l'].includes(k) && !s.kind) return
      e.preventDefault()
      act()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [enabled, setRxOpen])
}
