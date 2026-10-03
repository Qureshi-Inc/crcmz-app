// Meeting notes: what the AI wrote after each transcribed Huddle (meeting_notes.py).
// /app/huddle/notes lists the meetings you were in; /app/huddle/notes/:id is one, with
// the notes rendered from Markdown, a full-screen reader, Share and Rename. A link to
// one opens for anyone signed in, which is how notes get shared.
import { useState, type ComponentProps, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { request } from '../../lib/http'

type Status = 'live' | 'writing' | 'ready' | 'failed' | 'empty'
export type MeetingSummary = { id: string; room: string; started: number; ended: number | null; status: Status; title: string; people: string[] }
type Meeting = MeetingSummary & { notes: string; mine: boolean; transcript: { ts: number; name: string; text: string }[] }

const getMeetings = (signal?: AbortSignal) => request<{ meetings: MeetingSummary[] }>('/api/huddle/notes', { signal })
const getMeeting = (id: string, signal?: AbortSignal) => request<Meeting>(`/api/huddle/notes/${encodeURIComponent(id)}`, { signal })

const when = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const STATUS: Record<Status, string> = {
  live: 'In progress: the notes are written when the call ends',
  writing: 'Writing the notes…',
  ready: '',
  failed: "The AI couldn't write these notes",
  empty: 'Not enough was said for notes',
}

const MD = [remarkGfm]
const MD_COMPONENTS = {
  a: ({ node: _n, ...p }: ComponentProps<'a'> & { node?: unknown }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
}
function Notes({ md }: { md: string }) {
  return <div className="ask-md notes-md"><ReactMarkdown remarkPlugins={MD} components={MD_COMPONENTS}>{md}</ReactMarkdown></div>
}

export function NotesListPage() {
  useTitle('Meeting notes')
  const q = useQuery({ queryKey: ['huddle', 'notes'], queryFn: ({ signal }) => getMeetings(signal), refetchInterval: 30_000 })
  const items = q.data?.meetings ?? []
  return (
    <div className="page notes-page">
      <div className="hu-head">
        <h1 className="page-h1" tabIndex={-1}>Meeting notes</h1>
      </div>
      <p className="meta">Turn on the transcript in a Huddle and the AI writes notes for everyone who was there when the call ends.</p>
      {q.isPending ? <p className="dim" role="status">Loading…</p>
        : q.isError ? <p className="banner" role="alert"><span style={{ fontWeight: 700 }}>Couldn't load your meetings.</span></p>
        : items.length === 0 ? (
          <section className="glass notes-empty">
            <p className="empty-title">No meeting notes yet</p>
            <p className="meta">Start a Huddle with Transcript on, and they show up here after the call.</p>
            <Link className="btn btn-primary" to="/huddle"><Icon name="huddle" />Go to Huddle</Link>
          </section>
        ) : (
          <ul className="notes-list">
            {items.map((m) => (
              <li key={m.id}>
                <Link className="glass notes-row" to={`/huddle/notes/${m.id}`}>
                  <span className="notes-row-title">{m.title}</span>
                  <span className="meta">{when(m.started)} · {m.people.join(', ') || m.room}</span>
                  {STATUS[m.status] && <span className="meta notes-row-status">{STATUS[m.status]}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

export function NoteViewPage() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['huddle', 'notes', id], queryFn: ({ signal }) => getMeeting(id, signal),
    refetchInterval: (query) => (['live', 'writing'].includes(query.state.data?.status ?? '') ? 10_000 : false),
  })
  const m = q.data
  useTitle(m?.title || 'Meeting notes')
  const [reading, setReading] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')
  const rename = useMutation({
    mutationFn: (t: string) => request<{ title: string }>(`/api/huddle/notes/${encodeURIComponent(id)}`, { body: { title: t } }),
    onSuccess: () => { setRenaming(false); void qc.invalidateQueries({ queryKey: ['huddle', 'notes'] }) },
    onError: () => toast("Couldn't rename it", 'error'),
  })
  if (q.isPending) return <div className="page"><p className="dim" role="status">Loading…</p></div>
  if (!m) return (
    <div className="page">
      <p className="banner" role="alert"><span style={{ fontWeight: 700 }}>{q.error && 'status' in q.error && q.error.status === 404 ? 'No such meeting.' : "Couldn't load these notes."}</span></p>
      <Link className="btn btn-secondary" to="/huddle/notes">All meeting notes</Link>
    </div>
  )
  const url = `${location.origin}/app/huddle/notes/${m.id}`
  async function share() {
    const text = m!.notes ? `${m!.title}\n\n${m!.notes}` : m!.title
    if (navigator.share) {
      try { await navigator.share({ title: m!.title, text, url }); return } catch (e) { if ((e as Error)?.name === 'AbortError') return }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied: anyone in CRCMZ can open it', 'success') } catch { toast("Couldn't copy the link", 'error') }
  }
  async function copyNotes() {
    try { await navigator.clipboard.writeText(m!.notes); toast('Notes copied', 'success') } catch { toast("Couldn't copy", 'error') }
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    if (title.trim()) rename.mutate(title.trim())
  }
  return (
    <div className="page notes-page">
      <Link className="btn btn-ghost notes-back" to="/huddle/notes"><Icon name="left" />All meeting notes</Link>
      {renaming ? (
        <form className="notes-rename" onSubmit={submit}>
          <label className="sr-only" htmlFor="notes-title">Meeting name</label>
          <input id="notes-title" className="input" value={title} maxLength={80} autoFocus onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || rename.isPending}>Save</button>
          <button type="button" className="btn btn-secondary" onClick={() => setRenaming(false)}>Cancel</button>
        </form>
      ) : (
        <h1 className="page-h1 notes-title" tabIndex={-1}>{m.title}</h1>
      )}
      <p className="meta">{when(m.started)} · {m.room}{m.people.length > 0 && <> · {m.people.join(', ')}</>}</p>
      {STATUS[m.status] && <p className="banner" role="status"><span style={{ fontWeight: 700 }}>{STATUS[m.status]}</span></p>}
      <div className="notes-acts">
        {m.notes && <button type="button" className="btn btn-primary" onClick={() => setReading(true)}><Icon name="expand" />Full screen</button>}
        <button type="button" className="btn btn-secondary" onClick={() => void share()}><Icon name="external" />Share</button>
        {m.notes && <button type="button" className="btn btn-secondary" onClick={() => void copyNotes()}><Icon name="notes" />Copy</button>}
        {m.mine && !renaming && <button type="button" className="btn btn-secondary" onClick={() => { setTitle(m.title); setRenaming(true) }}><Icon name="edit" />Rename</button>}
      </div>
      {m.notes && <section className="glass notes-card"><Notes md={m.notes} /></section>}
      {m.transcript.length > 0 && (
        <details className="glass notes-transcript">
          <summary>Transcript · {m.transcript.length} {m.transcript.length === 1 ? 'line' : 'lines'}</summary>
          <ol>{m.transcript.map((l, i) => <li key={i}><b>{l.name}</b> {l.text}</li>)}</ol>
        </details>
      )}
      <Dialog.Root open={reading} onOpenChange={setReading}>
        <Dialog.Portal>
          <Dialog.Content className="notes-reader" aria-describedby={undefined}>
            <div className="notes-reader-bar">
              <Dialog.Title className="notes-reader-title">{m.title}</Dialog.Title>
              <button type="button" className="icon-btn" aria-label="Share" onClick={() => void share()}><Icon name="external" /></button>
              <Dialog.Close className="icon-btn" aria-label="Close"><Icon name="close" /></Dialog.Close>
            </div>
            <div className="notes-reader-body"><Notes md={m.notes} /></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
