// Who's here, the reactions tray and the room chat.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { hue, initials, REACTIONS, tint } from '../../lib/watch'
import { nameOf, react, sendChat, useWatch, type WatchState } from './session'

export function PresencePill({ s }: { s: WatchState }) {
  const [text, tone] =
    s.status === 'live' ? [s.presence.count > 1 ? `${s.presence.count} watching` : 'Just you', 'live']
      : s.status === 'reconnecting' ? ['offline — reconnecting', 'stale']
      : s.status === 'connecting' ? ['connecting…', 'dim']
      : ['offline', 'dim']
  return <span className="wp-pill" data-tone={tone} role="status">{text}</span>
}

export function Roster({ s, max = 5 }: { s: WatchState; max?: number }) {
  // One face per person: presence lists every device.
  const seen = new Set<string>()
  const people = s.presence.viewers.filter((v) => {
    const k = (v.name || '').toLowerCase()
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (!people.length) return null
  const shown = people.slice(0, max)
  const more = people.length - shown.length
  return (
    <ul className="wp-roster" aria-label={`Watching: ${people.map((p) => p.name).join(', ')}`}>
      {shown.map((p) => (
        <li key={p.id} className="wp-avatar" style={{ background: tint(p.name) }} title={p.name} aria-hidden="true">{initials(p.name)}</li>
      ))}
      {more > 0 && <li className="wp-avatar wp-avatar-more" aria-hidden="true">+{more}</li>}
    </ul>
  )
}

export function ReactionsTray({ disabled }: { disabled: boolean }) {
  return (
    <section className="glass wp-panel" aria-labelledby="wp-rx-h">
      <h2 className="eyebrow" id="wp-rx-h">React</h2>
      <div className="wp-rx-tray">
        {REACTIONS.map((e) => (
          <button key={e} type="button" className="wp-rx-btn" disabled={disabled} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>
        ))}
      </div>
      <p className="meta">Three of the same in a row sets off a party.</p>
    </section>
  )
}

export function Chat() {
  const s = useWatch()
  const [msg, setMsg] = useState('')
  const list = useRef<HTMLUListElement>(null)
  const lines = s.chat.filter((m) => !m.cmd || m.cmd === 'host')
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])
  const live = s.status === 'live'
  function submit(e: FormEvent) {
    e.preventDefault()
    if (sendChat(msg)) setMsg('')
  }
  return (
    <section className="glass wp-panel wp-chat" aria-labelledby="wp-chat-h">
      <h2 className="eyebrow" id="wp-chat-h">Chat</h2>
      {lines.length === 0 ? (
        <p className="dim wp-chat-empty">No messages yet. Say hi.</p>
      ) : (
        <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Chat messages">
        <ul className="wp-chat-list" ref={list} tabIndex={0} aria-label="Chat messages">
          {lines.map((m, i) => (
            <li key={i} className="wp-chat-line" data-system={m.cmd === 'host'}>
              {m.cmd === 'host' ? <span className="dim">{nameOf(m.id)} started a video</span> : <><b style={{ color: `hsl(${hue(nameOf(m.id))} 90% 76%)` }}>{nameOf(m.id)}</b> {m.msg}</>}
            </li>
          ))}
        </ul>
        </div>
      )}
      <form className="comment-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="wp-chat-in">Message</label>
        <input id="wp-chat-in" className="input" value={msg} maxLength={500} placeholder={live ? 'Message the room' : 'Connecting…'} disabled={!live} onChange={(e) => setMsg(e.target.value)} enterKeyHint="send" autoComplete="off" />
        <button type="submit" className="btn btn-secondary" disabled={!live || !msg.trim()}>Send</button>
      </form>
    </section>
  )
}
