// The calls keep going when you leave their page: this bar says so, and gets you
// back. One row per live call (Watch Party, Huddle), hidden on that call's own page.
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { leave as leaveHuddle, toggleMic, useHuddle } from '../huddle/session'
import { leave, toggleMute, useWatch, useWatchSelect } from './session'

export function useWatchBar(onWatch: boolean): boolean {
  return useWatchSelect((s) => s.active && !onWatch && (s.status === 'live' || s.status === 'connecting' || s.status === 'reconnecting'))
}
export function useHuddleBar(onHuddle: boolean): boolean {
  const s = useHuddle()
  return !onHuddle && (s.phase === 'live' || s.phase === 'reconnecting')
}

export function CallBar({ variant, watch, huddle }: { variant: 'bar' | 'sidebar'; watch: boolean; huddle: boolean }) {
  return (
    <section className={`watchbar watchbar-${variant}`} aria-label={watch && huddle ? 'Calls' : watch ? 'Watch Party' : 'Huddle'}>
      {watch && <WatchRow />}
      {huddle && <HuddleRow />}
    </section>
  )
}

function WatchRow() {
  const s = useWatch()
  const others = s.presence.viewers.map((v) => v.name).filter((n, i, a) => n && n !== s.myName && a.indexOf(n) === i)
  const sub = s.status === 'reconnecting' ? 'Reconnecting…'
    : s.status === 'connecting' ? 'Connecting…'
    : others.length === 0 ? 'Just you'
    : `${others.slice(0, 2).join(', ')}${others.length > 2 ? ` +${others.length - 2}` : ''}`
  return (
    <div className="miniplayer-row">
      <Link to="/watch" className="miniplayer-open" aria-label={`Return to Watch Party: ${sub}`}>
        <span className="watchbar-icon" data-playing={s.playing}><Icon name="watch" /></span>
        <span className="miniplayer-text">
          <span className="miniplayer-title">Watch Party</span>
          <span className="miniplayer-sub">{s.playing && <span className="together-tag">Playing</span>}{sub}</span>
        </span>
      </Link>
      {s.call.on && (
        <button type="button" className="icon-btn" aria-pressed={!s.call.muted} aria-label={s.call.muted ? 'Watch mic muted. Unmute' : 'Watch mic live. Mute'} onClick={toggleMute}>
          <Icon name={s.call.muted ? 'micOff' : 'mic'} />
        </button>
      )}
      <button type="button" className="icon-btn" aria-label="Leave the watch party" onClick={leave}><Icon name="close" /></button>
    </div>
  )
}

function HuddleRow() {
  const s = useHuddle()
  const n = new Set(s.tiles.map((t) => t.pid)).size
  const sub = s.phase === 'reconnecting' ? 'Reconnecting…' : `${s.room} · ${n === 1 ? 'just you' : `${n} in call`}`
  return (
    <div className="miniplayer-row">
      <Link to="/huddle" className="miniplayer-open" aria-label={`Return to Huddle: ${sub}`}>
        <span className="watchbar-icon" data-playing={s.mic}><Icon name="huddle" /></span>
        <span className="miniplayer-text">
          <span className="miniplayer-title">Huddle</span>
          <span className="miniplayer-sub">{s.recorders.length > 0 && <span className="together-tag">Transcript on</span>}{sub}</span>
        </span>
      </Link>
      <button type="button" className="icon-btn" aria-pressed={s.mic} aria-label={s.mic ? 'Huddle mic live. Mute' : 'Huddle mic muted. Unmute'} onClick={() => void toggleMic()}>
        <Icon name={s.mic ? 'mic' : 'micOff'} />
      </button>
      <button type="button" className="icon-btn" aria-label="Leave the huddle" onClick={() => void leaveHuddle()}><Icon name="close" /></button>
    </div>
  )
}
