// Slap comments: the @mention composer and one track's thread. Tagging someone
// (@handle) reaches them in Notifications, on their phone, and as a WhatsApp and
// Mattermost DM; the server works out who a handle is.
import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { ago } from '../../lib/notifications'
import { sendComment, slapName, useMentionable, useTrackComments, type Mentionable, type QueueItem, type SlapComment } from '../../lib/slap'

/** The `@partial` right before the caret, if the person is typing a tag. */
export function mentionQuery(text: string, caret: number): { start: number; q: string } | null {
  const m = /(?:^|[^\w@])@([\w.-]{0,64})$/.exec(text.slice(0, caret))
  if (!m) return null
  return { start: caret - m[1]!.length - 1, q: m[1]! }
}

export function matchPeople(people: Mentionable[], q: string, max = 6): Mentionable[] {
  const n = q.toLowerCase()
  const starts = people.filter((p) => p.handle.toLowerCase().startsWith(n) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(n)))
  const rest = n ? people.filter((p) => !starts.includes(p) && (p.handle + ' ' + p.name).toLowerCase().includes(n)) : []
  return [...starts, ...rest].slice(0, max)
}

const toAt = (iso: string) => Date.parse(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`)

/** A text input that suggests people after an @. A combobox: arrows, Enter or Tab to pick, Esc to close. */
export function MentionInput({ id, value, onChange, placeholder, disabled }: {
  id: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  // Where the caret goes once a picked handle is in the box (applied before paint).
  const pending = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pending.current == null || !ref.current) return
    ref.current.setSelectionRange(pending.current, pending.current)
    pending.current = null
  }, [value])
  const people = useMentionable(value.includes('@'))
  const query = mentionQuery(value, caret)
  const options = useMemo(() => (query && people.data ? matchPeople(people.data.people, query.q) : []), [query?.q, people.data])
  const open = !closed && !!query && options.length > 0
  const pick = Math.min(active, Math.max(0, options.length - 1))

  function choose(p: Mentionable) {
    if (!query) return
    const before = value.slice(0, query.start)
    const after = value.slice(caret).replace(/^[\w.-]*/, '')
    const next = `${before}@${p.handle} ${after.replace(/^\s+/, '')}`
    onChange(next)
    const at = before.length + p.handle.length + 2
    pending.current = at
    setCaret(at)
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((pick + 1) % options.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((pick - 1 + options.length) % options.length) }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[pick]!) }
    else if (e.key === 'Escape') { e.preventDefault(); setClosed(true) }
  }
  const sync = () => setCaret(ref.current?.selectionStart ?? value.length)

  return (
    <div className="mention-wrap">
      <input
        ref={ref} id={id} className="input" value={value} maxLength={500} placeholder={placeholder} disabled={disabled}
        autoComplete="off" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${pick}` : undefined}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setActive(0); setClosed(false) }}
        onKeyDown={onKey} onKeyUp={sync} onClick={sync} onBlur={() => setClosed(true)} onFocus={() => setClosed(false)}
      />
      <ul id={listId} role="listbox" className="mention-list" hidden={!open} aria-label="People to tag">
        {open && options.map((p, i) => (
          <li
            key={p.handle} id={`${listId}-${i}`} role="option" aria-selected={i === pick} className="mention-opt"
            onMouseDown={(e) => { e.preventDefault(); choose(p) }} onMouseEnter={() => setActive(i)}
          >
            <span className="mention-name">{p.name}</span><span className="meta">@{p.handle}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The composer: post a comment, tell the poster who their tags reached. */
export function CommentBox({ item, inputId = 'slap-comment', onPosted }: { item: Pick<QueueItem, 'id' | 'title' | 'artist' | 'album'>; inputId?: string; onPosted?: () => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const r = await sendComment(item, body, false)
      setText('')
      const who = r.mentioned ?? []
      toast(who.length ? `Posted. Tagged ${who.join(', ')}.` : 'Comment posted', 'success')
      void qc.invalidateQueries({ queryKey: ['slap', 'social'] })
      onPosted?.()
    } catch (err) {
      toast(err instanceof ApiError && err.detail ? err.detail : "Slap didn't take that", 'error')
    } finally { setBusy(false) }
  }
  return (
    <form className="comment-form" onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>Comment on this track</label>
      <MentionInput id={inputId} value={text} onChange={setText} placeholder="Say something… type @ to tag someone" disabled={busy} />
      <button type="submit" className="btn btn-secondary" disabled={busy || !text.trim()}>Post</button>
    </form>
  )
}

/** Comment text with its @tags picked out. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/((?<![\w@])@[\w.-]{2,64})/)
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className="mention-tag">{p}</span> : p))}</>
}

/** One track's thread: reactions summed up top, comments newest first. */
export function CommentThread({ trackId, limit = 8 }: { trackId: string; limit?: number }) {
  const q = useTrackComments(trackId)
  const all: SlapComment[] = q.data?.comments ?? []
  const reactions = all.filter((c) => c.is_reaction)
  const comments = all.filter((c) => !c.is_reaction).slice(0, limit)
  const counts = new Map<string, string[]>()
  for (const r of reactions) counts.set(r.text, [...(counts.get(r.text) ?? []), slapName(r.username)])

  if (q.isPending) return <p className="meta comment-thread-note">Loading comments…</p>
  if (q.isError) return <p className="meta comment-thread-note">Couldn't load comments. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></p>
  return (
    <section className="comment-thread" aria-label="Comments on this track">
      {counts.size > 0 && (
        <ul className="reaction-tally" aria-label="Reactions">
          {[...counts].map(([emoji, who]) => (
            <li key={emoji} className="reaction-chip" title={[...new Set(who)].join(', ')}>
              <span aria-hidden="true">{emoji}</span><span className="num">{who.length}</span>
              <span className="sr-only">{emoji} from {[...new Set(who)].join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
      {comments.length ? (
        <ol className="comment-list">
          {comments.map((c) => (
            <li key={c.id} className="comment-item">
              <span className="comment-who">{slapName(c.username)}</span>
              <span className="comment-body"><Rich text={c.text} /></span>
              <span className="meta num"><time dateTime={c.created_at}>{ago(toAt(c.created_at))}</time></span>
            </li>
          ))}
        </ol>
      ) : <p className="meta comment-thread-note">No comments on this one yet.</p>}
    </section>
  )
}

/** /app/slap?track=<id> (where a mention notification lands): that track, its thread and a reply box. */
export function TrackFocus({ track, onClose, onPlay }: {
  track: Pick<QueueItem, 'id' | 'title' | 'artist' | 'album'> | null; onClose: () => void; onPlay?: () => void
}) {
  if (!track) return null
  return (
    <section className="glass track-focus" aria-labelledby="track-focus-h">
      <div className="track-focus-head">
        <div>
          <h2 className="section-h2" id="track-focus-h">{track.title || 'This track'}</h2>
          {track.artist && <p className="meta">{track.artist}</p>}
        </div>
        <div className="track-focus-acts">
          {onPlay && <button type="button" className="btn btn-primary" onClick={onPlay}>Play</button>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
      <CommentThread trackId={track.id} limit={30} />
      <CommentBox item={track} inputId="slap-focus-comment" />
    </section>
  )
}
