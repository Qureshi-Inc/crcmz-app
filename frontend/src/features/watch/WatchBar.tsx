// The party keeps going when you leave /watch: this bar says so, and gets you back.
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { leave, toggleMute, useWatch, useWatchSelect } from './session'

export function useWatchBar(onWatch: boolean): boolean {
  return useWatchSelect((s) => s.active && !onWatch && (s.status === 'live' || s.status === 'connecting' || s.status === 'reconnecting'))
}

export function WatchBar({ variant }: { variant: 'bar' | 'sidebar' }) {
  const s = useWatch()
  const others = s.presence.viewers.map((v) => v.name).filter((n, i, a) => n && n !== s.myName && a.indexOf(n) === i)
  const sub = s.status === 'reconnecting' ? 'Reconnecting…'
    : s.status === 'connecting' ? 'Connecting…'
    : others.length === 0 ? 'Just you'
    : `${others.slice(0, 2).join(', ')}${others.length > 2 ? ` +${others.length - 2}` : ''}`
  return (
    <section className={`watchbar watchbar-${variant}`} aria-label="Watch Party">
      <div className="miniplayer-row">
        <Link to="/watch" className="miniplayer-open" aria-label={`Return to Watch Party: ${sub}`}>
          <span className="watchbar-icon" data-playing={s.playing}><Icon name="watch" /></span>
          <span className="miniplayer-text">
            <span className="miniplayer-title">Watch Party</span>
            <span className="miniplayer-sub">{s.playing && <span className="together-tag">Playing</span>}{sub}</span>
          </span>
        </Link>
        {s.call.on && (
          <button type="button" className="icon-btn" aria-pressed={!s.call.muted} aria-label={s.call.muted ? 'Mic muted. Unmute' : 'Mic live. Mute'} onClick={toggleMute}>
            <Icon name={s.call.muted ? 'micOff' : 'mic'} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Leave the watch party" onClick={leave}><Icon name="close" /></button>
      </div>
    </section>
  )
}
