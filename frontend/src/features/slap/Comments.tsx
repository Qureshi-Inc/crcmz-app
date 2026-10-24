// Slap comments: the @mention composer and one track's thread. Tagging someone
// (@handle) reaches them in Notifications, on their phone, and as a WhatsApp and
// Mattermost DM; the server works out who a handle is.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { ago } from '../../lib/notifications'
import { sendComment, slapName, useMentionable, useSlapMe, useTrackComments, type Mentionable, type QueueItem, type SlapComment } from '../../lib/slap'

/** The `@partial` right before the caret, if the person is typing a tag. */
export function mentionQuery(text: string, caret: number): { start: number; q: string } | null {
  const m = /(?:^|[^\w@])@([\w.-]{0,64})$/.exec(text.slice(0, caret))
  if (!m) return null
  return { start: caret - m[1]!.length - 1, q: m[1]! }
}

export function matchPeople(people: Mentionable[], q: string, max = 6): Mentionable[] {
  const n = q.toLowerCase()
  const starts = people.filter((p) => p.handle.toLowerCase().startsWith(n) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(n)) || (p.aka ?? []).some((a) => a.startsWith(n)))
  const rest = n ? people.filter((p) => !starts.includes(p) && [p.handle, p.name, ...(p.aka ?? [])].join(' ').toLowerCase().includes(n)) : []
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
        autoComplete="off" role="combobox" aria-autocomplete="list" enterKeyHint="send" aria-expanded={open} aria-controls={listId}
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

/** The composer: post a comment, tell the poster who their tags reached. It shows in
 *  the thread at once, then the server's copy replaces it. */
export function CommentBox({ item, inputId = 'slap-comment', onPosted }: { item: Pick<QueueItem, 'id' | 'title' | 'artist' | 'album'>; inputId?: string; onPosted?: () => void }) {
  const qc = useQueryClient()
  const me = useSlapMe().data?.slap_user ?? ''
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    const draft: SlapComment = { id: `draft-${Date.now()}`, username: me, title: item.title, artist: item.artist, text: body, is_reaction: false, created_at: new Date().toISOString() }
    const threads = { queryKey: ['slap', 'social', 'listening/comments', `?track_id=${item.id}&limit=30`] }
    qc.setQueriesData<{ comments: SlapComment[] }>(threads, (d) => d && { ...d, comments: [draft, ...d.comments] })
    setText('')
    try {
      const r = await sendComment(item, body, false)
      const who = r.mentioned ?? []
      if (who.length) toast(`Tagged ${who.join(', ')}`, 'success')
      onPosted?.()
    } catch (err) {
      qc.setQueriesData<{ comments: SlapComment[] }>(threads, (d) => d && { ...d, comments: d.comments.filter((c) => c.id !== draft.id) })
      setText(body)
      toast(err instanceof ApiError && err.detail ? err.detail : "Slap didn't take that", 'error')
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['slap', 'social'] })
    }
  }
  return (
    <form className="comment-form comment-compose" onSubmit={submit}>
      <label className="sr-only" htmlFor={inputId}>Comment on this track</label>
      <MentionInput id={inputId} value={text} onChange={setText} placeholder="Add a comment… @ to tag" disabled={busy} />
      <button type="submit" className="icon-btn btn-cyan" disabled={busy || !text.trim()} aria-label="Post comment"><Icon name="send" /></button>
    </form>
  )
}

/** Comment text with its @tags picked out. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/((?<![\w@])@[\w.-]{2,64})/)
  return <>{parts.map((p, i) => (i % 2 ? <span key={i} className="mention-tag">{p}</span> : p))}</>
}

/** One track's comments, read like a chat: oldest at the top, yours on the right, the
 *  newest in view. Old emoji reactions aren't shown. */
export function CommentThread({ trackId, limit = 8 }: { trackId: string; limit?: number }) {
  const q = useTrackComments(trackId)
  const me = useSlapMe().data?.slap_user?.toLowerCase()
  const [all, setAll] = useState(false)
  const box = useRef<HTMLOListElement>(null)
  const said = (q.data?.comments ?? []).filter((c) => !c.is_reaction)
  const shown = (all ? said : said.slice(0, limit)).slice().reverse()
  // Scroll the list, never the page (inside the player that would drag it down).
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight }, [shown.length, trackId])
  useEffect(() => setAll(false), [trackId])

  return (
    <section className="comment-thread" aria-labelledby={`comments-${trackId}`}>
      <h3 className="comment-h" id={`comments-${trackId}`}>Comments{said.length > 0 && <span className="meta num"> {said.length}</span>}</h3>
      {q.isPending ? <p className="meta comment-thread-note">Loading comments…</p>
        : q.isError ? <p className="meta comment-thread-note">Couldn't load comments. <button type="button" className="link-btn" onClick={() => q.refetch()}>Try again</button></p>
        : shown.length ? (
          <>
            {said.length > shown.length && <button type="button" className="link-btn comment-more" onClick={() => setAll(true)}>Show {said.length - shown.length} earlier</button>}
            <ol ref={box} className="comment-list">
              {shown.map((c, i) => {
                const mine = !!me && c.username.toLowerCase() === me
                const prev = shown[i - 1]
                const first = !prev || prev.username !== c.username || toAt(c.created_at) - toAt(prev.created_at) > 5 * 60_000
                return (
                  <li key={c.id} className="comment-item" data-mine={mine} data-draft={c.id.startsWith('draft-')}>
                    {first && (
                      <span className="comment-who">{mine ? 'You' : slapName(c.username)} <time className="meta num" dateTime={c.created_at}>{ago(toAt(c.created_at))}</time></span>
                    )}
                    <span className="comment-body"><Rich text={c.text} /></span>
                  </li>
                )
              })}
            </ol>
          </>
        ) : <p className="meta comment-thread-note">No comments yet. Start it off.</p>}
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
