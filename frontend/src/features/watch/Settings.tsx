// The player's ⚙ panel: every Watch setting in one place, inside the stage, so it
// works in fullscreen too (a portal to <body> would sit behind the fullscreen element).
// A phone's player is too short for it, so there it opens just below the player instead.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from '../../components/Icon'
import { ApiError } from '../../lib/http'
import { rallyEveryone } from './rally'
import { changeName, flipCam, leaveCall, setMic, setOrbPos, setSpeaker, useWatch, videoLabel, type OrbPos, type WatchState } from './session'

export function PlayerSettings({ s, onClose, inline }: { s: WatchState; onClose: () => void; inline?: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.querySelector<HTMLElement>('button, input, select')?.focus({ preventScroll: true }) }, [])
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
  }
  const c = s.call
  return (
    <div className={`wp-set${inline ? ' glass' : ''}`} data-inline={inline} ref={panel} role="dialog" aria-label="Watch settings" onKeyDown={onKey} onPointerUp={(e) => e.stopPropagation()}>
      <div className="wp-set-head">
        <h2 className="wp-set-title">Settings</h2>
        <button type="button" className="wp-ctl" aria-label="Close settings" onClick={onClose}><Icon name="close" /></button>
      </div>
      <OrbPosControl id="wp-set-orbpos" />
      {c.on && !c.micOnly && (
        <button type="button" className="btn btn-secondary" disabled={c.busy} onClick={() => void flipCam()}><Icon name="flip" />Flip camera</button>
      )}
      {/* Also here because a narrow player drops its own Leave button. */}
      {c.on && <button type="button" className="btn btn-secondary wp-set-leave" onClick={() => { leaveCall(); onClose() }}><Icon name="leave" />Leave call</button>}
      {c.on && (s.mics.length > 1 || s.speakers.length > 1) && <Devices s={s} />}
      <NameField s={s} />
      <RallyField s={s} />
    </div>
  )
}

function NameField({ s }: { s: WatchState }) {
  const [value, setValue] = useState(s.cfg?.viewer?.nickname || '')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      setNote(`You're ${await changeName(value.trim())} in the party`)
    } catch (err) {
      setNote((err instanceof ApiError && err.detail) || "Couldn't change your name")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="wp-set-field" onSubmit={submit}>
      <label className="field-label" htmlFor="wp-set-name">Display name</label>
      <div className="wp-url-row">
        <input
          id="wp-set-name" className="input" value={value} maxLength={40} autoComplete="nickname" disabled={!s.cfg}
          placeholder={s.cfg?.viewer?.psnOnlineId || 'Your account name'} onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy || !s.cfg}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <p className="field-hint" role="status">{note || 'What the room sees. Empty uses your account name.'}</p>
    </form>
  )
}

function RallyField({ s }: { s: WatchState }) {
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const live = s.status === 'live'
  async function send() {
    setBusy(true)
    try {
      setNote(await rallyEveryone())
      setAsk(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="wp-set-field">
      <span className="field-label">Rally</span>
      {ask ? (
        <>
          <p className="meta">Rings everyone's phone into the party, and posts to the squad's WhatsApp group: “@all … are on CRCMZ app {videoLabel() ? `watching ${videoLabel()}` : 'in the watch party'}. Join now!”</p>
          <div className="wp-action-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send()}><Icon name="phone" />{busy ? 'Rallying…' : 'Rally now'}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setAsk(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <button type="button" className="btn btn-secondary" disabled={!live} onClick={() => { setNote(''); setAsk(true) }}><Icon name="megaphone" />Rally the squad</button>
      )}
      {note && <p className="field-hint" role="status">{note}</p>}
    </div>
  )
}

export function Devices({ s }: { s: WatchState }) {
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
      {s.fs && (s.orbPos === 'top' || s.orbPos === 'bottom') && <p className="meta">In fullscreen the cameras sit on the video.</p>}
    </div>
  )
}
