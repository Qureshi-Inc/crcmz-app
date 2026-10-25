// Soundboard: the squad's shared clip board. Tap a clip to play it on the squad Pi
// (headset + PS5 party). Anyone can add a clip (upload, record or a link), put the
// board in order, rename or remove clips. Clips added in Deck Manager or on the
// stream deck show up here too: the Pi is the one library.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { HelpLink } from '../../components/HelpLink'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { ApiError, getJSON, request } from '../../lib/http'
import { nativeShell } from '../../lib/nativeShell'
import { useSwipeDown } from '../../lib/gestures'

type Sound = { name: string; label: string; by?: string | null; at?: number | null; source?: string | null }
type Board = { sounds: Sound[]; builtins: string[] }

const KEY = ['audio-sounds']
const ok = (t: string) => toast(t, 'success')
const err = (t: string) => toast(t, 'error')
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.detail : fallback)

async function postClip(file: Blob, filename: string, label: string, source: 'upload' | 'record') {
  const fd = new FormData()
  fd.append('file', file, filename)
  fd.append('label', label)
  fd.append('source', source)
  const res = await fetch('/api/audio-sounds/upload', { method: 'POST', credentials: 'same-origin', body: fd })
  const j = (await res.json().catch(() => ({}))) as { detail?: string; label?: string }
  if (!res.ok) throw new Error(j.detail || 'Upload failed')
  return j.label ?? label
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function AudioSoundsPage() {
  useTitle('Soundboard')
  const qc = useQueryClient()
  const board = useQuery({ queryKey: KEY, queryFn: ({ signal }) => getJSON<Board>('/api/audio-sounds', signal), refetchInterval: 30_000 })
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [order, setOrder] = useState<Sound[]>([])

  useEffect(() => { if (board.data) setOrder(board.data.sounds) }, [board.data])

  async function play(name: string, label: string) {
    if (editing || playing) return
    setPlaying(name)
    try {
      await request(`/api/audio-sounds/${encodeURIComponent(name)}/play`, { method: 'POST' })
      ok(`Playing ${label}`)
    } catch (e) {
      err(msg(e, 'Playback failed'))
    } finally {
      setTimeout(() => setPlaying(null), 600)
    }
  }

  async function saveOrder(next: Sound[]) {
    setOrder(next)
    try {
      const b = await request<Board>('/api/audio-sounds/order', { method: 'PUT', body: { order: next.map((s) => s.name) } })
      qc.setQueryData(KEY, b)
    } catch (e) {
      err(msg(e, "Couldn't save the order"))
      void board.refetch()
    }
  }

  async function rename(s: Sound, label: string) {
    if (label === s.label) return
    setOrder((o) => o.map((x) => (x.name === s.name ? { ...x, label: label || x.name } : x)))
    try {
      await request(`/api/audio-sounds/${encodeURIComponent(s.name)}`, { method: 'PATCH', body: { label } })
      void qc.invalidateQueries({ queryKey: KEY })
    } catch (e) { err(msg(e, "Couldn't rename it")) }
  }

  async function remove(s: Sound) {
    setOrder((o) => o.filter((x) => x.name !== s.name))
    try {
      await request(`/api/audio-sounds/${encodeURIComponent(s.name)}`, { method: 'DELETE' })
      ok(`Removed ${s.label}`)
      void qc.invalidateQueries({ queryKey: KEY })
    } catch (e) {
      err(msg(e, "Couldn't remove it"))
      void board.refetch()
    }
  }

  const sounds = order
  return (
    <div className="page sb-page">
      <div className="sb-head">
        <div>
          <h1 className="page-h1" tabIndex={-1}>Soundboard<HelpLink id="sounds" /></h1>
          <p className="meta">{editing ? 'Drag or use the arrows to reorder · tap a name to rename' : 'Tap a clip to play it through the squad Pi'}</p>
        </div>
        <div className="sb-actions">
          {sounds.length > 0 && (
            <button type="button" className="btn btn-secondary" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
              <Icon name={editing ? 'close' : 'edit'} />{editing ? 'Done' : 'Edit'}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" />Add clip</button>
        </div>
      </div>

      {board.isLoading && <SkeletonRows n={3} />}
      {board.error && <ErrorStrip text="Couldn't load the soundboard" onRetry={() => void board.refetch()} />}
      {board.data && sounds.length === 0 && (
        <div className="empty glass">
          <p className="empty-title">No clips yet</p>
          <p className="meta">Upload a sound, record one, or paste a MyInstants link. Everyone in the squad sees the same board.</p>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" />Add the first clip</button>
        </div>
      )}

      {sounds.length > 0 && (
        <BoardGrid sounds={sounds} editing={editing} playing={playing}
          onPlay={(s) => void play(s.name, s.label)} onReorder={(next) => void saveOrder(next)}
          onRename={(s, l) => void rename(s, l)} onRemove={(s) => void remove(s)} />
      )}

      {(board.data?.builtins.length ?? 0) > 0 && (
        <details className="sb-classics glass">
          <summary className="section-h2">Classic sounds</summary>
          <div className="sb-classic-row">
            {board.data!.builtins.map((n) => (
              <button key={n} type="button" className="chip" disabled={playing !== null} onClick={() => void play(n, n)}>
                <Icon name="play" />{n}
              </button>
            ))}
          </div>
        </details>
      )}

      <AddSheet open={adding} onOpenChange={setAdding} onAdded={() => void qc.invalidateQueries({ queryKey: KEY })} />
    </div>
  )
}

// ── Board grid (play / edit) ──────────────────────────────────────────────────
function BoardGrid({ sounds, editing, playing, onPlay, onReorder, onRename, onRemove }: {
  sounds: Sound[]; editing: boolean; playing: string | null
  onPlay: (s: Sound) => void; onReorder: (next: Sound[]) => void
  onRename: (s: Sound, label: string) => void; onRemove: (s: Sound) => void
}) {
  const grid = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<{ name: string; list: Sound[] } | null>(null)
  const list = drag?.list ?? sounds

  function move(i: number, d: -1 | 1) {
    const j = i + d
    if (j < 0 || j >= sounds.length) return
    const next = [...sounds]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onReorder(next)
  }

  function startDrag(e: RPointerEvent<HTMLButtonElement>, name: string) {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ name, list: [...sounds] })
  }
  function onDragMove(e: RPointerEvent<HTMLButtonElement>) {
    if (!drag || !grid.current) return
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-sound]')
    const target = over?.dataset.sound
    if (!target || target === drag.name) return
    const from = drag.list.findIndex((s) => s.name === drag.name)
    const to = drag.list.findIndex((s) => s.name === target)
    const next = [...drag.list]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    setDrag({ ...drag, list: next })
  }
  function endDrag() {
    if (!drag) return
    const changed = drag.list.map((s) => s.name).join() !== sounds.map((s) => s.name).join()
    const next = drag.list
    setDrag(null)
    if (changed) onReorder(next)
  }

  return (
    <ul className="sb-grid" ref={grid} data-editing={editing} aria-label="Clips">
      {list.map((s, i) => (
        <li key={s.name} data-sound={s.name} data-dragging={drag?.name === s.name || undefined}>
          {editing
            ? <EditTile s={s} first={i === 0} last={i === list.length - 1} onUp={() => move(i, -1)} onDown={() => move(i, 1)}
                onRename={(l) => onRename(s, l)} onRemove={() => onRemove(s)}
                handle={{ onPointerDown: (e) => startDrag(e, s.name), onPointerMove: onDragMove, onPointerUp: endDrag, onPointerCancel: endDrag }} />
            : (
              <button type="button" className="sb-tile" data-playing={playing === s.name || undefined}
                onClick={() => onPlay(s)} aria-label={`Play ${s.label}`}>
                <span className="sb-tile-icon" aria-hidden="true"><Icon name={playing === s.name ? 'vol' : 'play'} /></span>
                <span className="sb-tile-label">{s.label}</span>
                {s.by && <span className="sb-tile-by">{s.by}</span>}
              </button>
            )}
        </li>
      ))}
    </ul>
  )
}

type HandleProps = {
  onPointerDown: (e: RPointerEvent<HTMLButtonElement>) => void
  onPointerMove: (e: RPointerEvent<HTMLButtonElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
}

function EditTile({ s, first, last, onUp, onDown, onRename, onRemove, handle }: {
  s: Sound; first: boolean; last: boolean; onUp: () => void; onDown: () => void
  onRename: (label: string) => void; onRemove: () => void; handle: HandleProps
}) {
  const [label, setLabel] = useState(s.label)
  const [arm, setArm] = useState(false)
  useEffect(() => setLabel(s.label), [s.label])
  useEffect(() => { if (!arm) return; const t = setTimeout(() => setArm(false), 3000); return () => clearTimeout(t) }, [arm])
  return (
    <div className="sb-tile sb-tile--edit">
      <div className="sb-edit-top">
        <button type="button" className="sb-handle" aria-label={`Drag ${s.label}`} {...handle}><Icon name="grid" /></button>
        <input className="input sb-rename" value={label} maxLength={40} aria-label={`Name for ${s.name}`}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => onRename(label.trim())}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
      </div>
      <div className="sb-edit-tools">
        <button type="button" className="icon-btn" disabled={first} onClick={onUp} aria-label={`Move ${s.label} earlier`}><Icon name="left" /></button>
        <button type="button" className="icon-btn" disabled={last} onClick={onDown} aria-label={`Move ${s.label} later`}><Icon name="right" /></button>
        <button type="button" className={`icon-btn sb-del${arm ? ' sb-del--armed' : ''}`}
          onClick={() => (arm ? onRemove() : setArm(true))} aria-label={arm ? `Tap again to remove ${s.label}` : `Remove ${s.label}`}>
          <Icon name="trash" />{arm && <span>Remove?</span>}
        </button>
      </div>
    </div>
  )
}

// ── Add a clip ────────────────────────────────────────────────────────────────
function AddSheet({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const swipe = useSwipeDown(() => onOpenChange(false))
  const [tab, setTab] = useState('upload')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!open) { setLabel(''); setBusy(false) } }, [open])

  async function run(job: () => Promise<string>) {
    setBusy(true)
    try {
      const name = await job()
      ok(`Added ${name} to the board`)
      onAdded()
      onOpenChange(false)
    } catch (e) {
      err(e instanceof Error ? e.message : 'That didn’t work')
    } finally { setBusy(false) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="sheet sb-add" aria-describedby={undefined}>
          <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">Add a clip</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="icon-btn" aria-label="Close"><Icon name="close" /></button></Dialog.Close>
          </div>
          <Tabs.Root value={tab} onValueChange={setTab}>
            <Tabs.List className="seg seg-3" aria-label="How to add">
              <Tabs.Trigger value="upload" className="seg-tab">Upload</Tabs.Trigger>
              <Tabs.Trigger value="record" className="seg-tab">Record</Tabs.Trigger>
              <Tabs.Trigger value="link" className="seg-tab">Link</Tabs.Trigger>
            </Tabs.List>
            <label className="field-label sb-label-field">Name on the board
              <input className="input" value={label} maxLength={40} placeholder="Airhorn" onChange={(e) => setLabel(e.target.value)} />
            </label>
            <Tabs.Content value="upload"><UploadTab busy={busy} onFile={(f) => run(() => postClip(f, f.name, label.trim(), 'upload'))} /></Tabs.Content>
            <Tabs.Content value="record"><RecordTab busy={busy} active={open && tab === 'record'} onClip={(b, n) => run(() => postClip(b, n, label.trim() || 'recording', 'record'))} /></Tabs.Content>
            <Tabs.Content value="link"><LinkTab busy={busy} onLink={(url) => run(async () => {
              const r = await request<{ label: string }>('/api/audio-sounds/link', { method: 'POST', body: { url, label: label.trim() }, timeoutMs: 60_000 })
              return r.label
            })} /></Tabs.Content>
          </Tabs.Root>
          <p className="field-hint">Clips are trimmed to 60 seconds and play through the squad Pi — your headset and the PS5 party hear them.</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function UploadTab({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="sb-tab">
      <button type="button" className="upload-zone" disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="download" />
        <span className="upload-zone-label">{busy ? 'Adding…' : 'Choose an audio or video file'}</span>
        <span className="upload-zone-hint">MP3 · WAV · M4A · MP4 · up to 20 MB</span>
      </button>
      <input ref={input} type="file" accept="audio/*,video/*" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
    </div>
  )
}

/** In a browser: record right here. In the phone apps the mic is native, so the
 *  file picker's own recorder (capture) does the recording instead. */
function RecordTab({ busy, active, onClip }: { busy: boolean; active: boolean; onClip: (b: Blob, name: string) => void }) {
  const canRecord = !nativeShell() && typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
  const input = useRef<HTMLInputElement>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const [state, setState] = useState<'idle' | 'recording' | 'done'>('idle')
  const [secs, setSecs] = useState(0)
  const [clip, setClip] = useState<Blob | null>(null)
  const url = useRef<string | null>(null)

  useEffect(() => {
    if (active) return
    rec.current?.state === 'recording' && rec.current.stop()
    setState('idle'); setClip(null); setSecs(0)
  }, [active])
  useEffect(() => {
    if (state !== 'recording') return
    const t0 = Date.now()
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000)
      setSecs(s)
      if (s >= 60) rec.current?.stop()
    }, 250)
    return () => clearInterval(t)
  }, [state])
  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current) }, [])

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const chunks: Blob[] = []
      const r = new MediaRecorder(stream)
      r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const b = new Blob(chunks, { type: r.mimeType || 'audio/webm' })
        if (url.current) URL.revokeObjectURL(url.current)
        url.current = URL.createObjectURL(b)
        setClip(b); setState('done')
      }
      rec.current = r
      r.start(); setSecs(0); setState('recording')
    } catch {
      err('The browser didn’t give us the microphone')
    }
  }

  if (!canRecord) {
    return (
      <div className="sb-tab">
        <button type="button" className="upload-zone" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="mic" />
          <span className="upload-zone-label">{busy ? 'Adding…' : 'Record a clip'}</span>
          <span className="upload-zone-hint">Opens your phone’s recorder</span>
        </button>
        <input ref={input} type="file" accept="audio/*" capture hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onClip(f, f.name); e.target.value = '' }} />
      </div>
    )
  }
  return (
    <div className="sb-tab sb-rec">
      <span className="sb-rec-time" aria-live="polite">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
      {state === 'recording'
        ? <button type="button" className="btn btn-primary" onClick={() => rec.current?.stop()}><Icon name="pause" />Stop</button>
        : <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void start()}><Icon name="mic" />{state === 'done' ? 'Record again' : 'Start recording'}</button>}
      {state === 'done' && clip && (
        <>
          <audio controls src={url.current ?? undefined} className="sb-rec-audio" />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onClip(clip, 'recording.webm')}>{busy ? 'Adding…' : 'Add to the board'}</button>
        </>
      )}
    </div>
  )
}

function LinkTab({ busy, onLink }: { busy: boolean; onLink: (url: string) => void }) {
  const [url, setUrl] = useState('')
  return (
    <form className="sb-tab" onSubmit={(e) => { e.preventDefault(); if (url.trim()) onLink(url.trim()) }}>
      <label className="field-label">Link
        <input className="input" type="url" inputMode="url" value={url} placeholder="https://www.myinstants.com/en/instant/vine-boom/"
          onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p className="field-hint">A MyInstants page, or a direct link to an audio file.</p>
      <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}><Icon name="link" />{busy ? 'Downloading…' : 'Add from link'}</button>
    </form>
  )
}
