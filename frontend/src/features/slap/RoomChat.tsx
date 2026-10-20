// The Listen Together room's chat: a floating button on every page while you're in
// the room, opening a panel. The music never stops for it — the player lives outside.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { useSwipeDown } from '../../lib/gestures'
import { usePlayer } from './player'
import { say, setChatOpen, showChatInline, useRoomChat, type ChatLine } from './roomChat'

const MAX = 500
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export function RoomChat() {
  const s = usePlayer()
  const c = useRoomChat()
  const desktop = useDesktop()
  const swipe = useSwipeDown(() => setChatOpen(false))
  if (s.mode !== 'together') return null
  const names = s.room?.members.map((m) => m.name) ?? []
  return (
    <>
      <button
        type="button" className="room-chat-fab" onClick={() => setChatOpen(true)}
        aria-label={c.unread ? `Room chat, ${c.unread} new` : 'Room chat'} data-unread={c.unread > 0}
      >
        <Icon name="chat" />
        {c.unread > 0 && <span className="room-chat-badge num" aria-hidden="true">{c.unread > 99 ? '99+' : c.unread}</span>}
      </button>
      <Dialog.Root open={c.open} onOpenChange={setChatOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="scrim" />
          <Dialog.Content className={desktop ? 'dialog room-chat-dialog' : 'sheet room-chat-sheet'} aria-describedby="room-chat-who">
            {!desktop && <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>}
            <div className="sheet-title-row">
              <Dialog.Title className="sheet-title">Room chat</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn" aria-label="Close room chat"><Icon name="close" /></button>
              </Dialog.Close>
            </div>
            <p id="room-chat-who" className="meta room-chat-who">
              Only the room sees this, and it's gone when everyone leaves.{names.length ? ` In here: ${names.join(', ')}.` : ''}
            </p>
            <Lines lines={c.lines} />
            <Composer />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

/** The room chat inside the player, where song comments go when you listen alone. */
export function RoomChatInline() {
  const c = useRoomChat()
  useEffect(() => showChatInline(), [])
  return (
    <section className="room-chat-inline" aria-labelledby="room-chat-inline-h">
      <h3 className="room-chat-inline-h" id="room-chat-inline-h">Room chat</h3>
      <p className="meta room-chat-who">Stays across every song, and clears when the session ends.</p>
      <Lines lines={c.lines} />
      <Composer />
    </section>
  )
}

function Lines({ lines }: { lines: ChatLine[] }) {
  // Scroll the list, never the page: inside the player, scrollIntoView would drag the
  // whole player down to the chat every time someone said something.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight }, [lines.length])
  if (!lines.length) {
    return <div className="empty room-chat-empty"><p className="empty-title">Say something</p><p className="dim">Talk about what's playing. @name someone to ping their phone.</p></div>
  }
  return (
    <div ref={box} className="room-chat-lines" role="log" aria-live="polite" aria-label="Messages">
      {lines.map((m, i) => {
        const prev = lines[i - 1]
        const first = !prev || prev.name !== m.name || m.at - prev.at > 5 * 60_000
        return (
          <div key={m.seq} className="room-chat-line" data-mine={m.mine}>
            {first && <span className="room-chat-name">{m.mine ? 'You' : m.name} <span className="meta">{time(m.at)}</span></span>}
            <span className="room-chat-text">{m.text}</span>
          </div>
        )
      })}
    </div>
  )
}

function Composer() {
  const id = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try { await say(t); setText('') } catch (err) {
      toast(err instanceof ApiError && err.detail ? err.detail : "That didn't send", 'error')
    } finally { setBusy(false) }
  }
  return (
    <form className="comment-form room-chat-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={id}>Message the room</label>
      <input
        id={id} name="room-chat" className="input" value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Message the room" maxLength={MAX} enterKeyHint="send" autoComplete="off"
      />
      <button type="submit" className="icon-btn btn-cyan" disabled={busy || !text.trim()} aria-label="Send"><Icon name="send" /></button>
    </form>
  )
}
