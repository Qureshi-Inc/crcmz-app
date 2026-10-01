// Library · Watched: what the room has watched, or just me. Resume where you left
// off, name an untitled video, forget one. Opening a card's details shows its chat.
import { useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { ConfirmDialog } from '../clips/ClipSheet'
import { ApiError } from '../../lib/http'
import { ago, fmtTime, forgetVideo, historyChat, initials, listHistory, renameVideo, tint, ytId, type HistItem } from '../../lib/watch'
import { resumeItem, useWatch } from './session'

type Scope = 'room' | 'mine'
const KIND: Record<string, string> = { movie: 'Movie', episode: 'Episode', show: 'Show', series: 'Show', youtube: 'YouTube' }
const kindLabel = (it: HistItem) => (ytId(it.url) ? 'YouTube' : KIND[String(it.kind || '').toLowerCase()] || 'Video')

export function Watched() {
  const s = useWatch()
  const [scope, setScope] = useState<Scope>('room')
  const room = s.room || s.cfg?.defaultRoom || ''
  const q = useQuery({
    queryKey: ['watch', 'history', scope, room, s.histTick],
    queryFn: ({ signal }) => listHistory(scope === 'mine' ? { mine: true } : { room }, signal),
    enabled: !!room && s.active,
    placeholderData: (prev) => prev,
  })
  const items = q.data?.items ?? []
  return (
    <div className="wp-history">
      <Tabs.Root value={scope} onValueChange={(v) => setScope(v as Scope)}>
        <Tabs.List className="seg wp-hist-tabs" aria-label="Whose history">
          <Tabs.Trigger value="room" className="seg-tab">This room</Tabs.Trigger>
          <Tabs.Trigger value="mine" className="seg-tab">Just me</Tabs.Trigger>
        </Tabs.List>
        {(['room', 'mine'] as const).map((sc) => (
          <Tabs.Content key={sc} value={sc} className="wp-hist-panel">
            {q.isError && q.data === undefined ? <ErrorStrip text="History didn't load" onRetry={() => q.refetch()} />
              : q.isPending ? <SkeletonRows n={3} />
              : items.length === 0 ? (
                <p className="dim wp-hist-empty">{sc === 'mine' ? "Nothing watched yet. Whatever you watch shows up here so you can pick it back up." : 'Nothing watched yet in this room'}</p>
              ) : (
                <ul className="wp-cards">
                  {items.map((it) => <li key={it.url}><Card it={it} playing={s.video === it.url} canPlay={s.status === 'live'} /></li>)}
                </ul>
              )}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  )
}

function Card({ it, playing, canPlay }: { it: HistItem; playing: boolean; canPlay: boolean }) {
  const [info, setInfo] = useState(false)
  const [rename, setRename] = useState(false)
  const [forget, setForget] = useState(false)
  const qc = useQueryClient()
  const mine = it.mine
  const pos = mine ? mine.position : it.position
  const done = mine ? mine.finished : it.finished
  const dur = it.duration || 0
  const pct = done ? 100 : dur ? Math.min(100, (pos / dur) * 100) : 0
  const title = it.title?.trim()
  const yt = !!ytId(it.url)
  const watchers = it.viewers.map((v) => v.name).filter(Boolean)
  const resumeAt = !done && pos > 10 ? pos : 0

  async function doForget() {
    try {
      await forgetVideo(it.url)
      toast('Forgotten', 'success')
      void qc.invalidateQueries({ queryKey: ['watch', 'history'] })
    } catch (e) {
      toast((e instanceof ApiError && e.detail) || "Couldn't forget that video", 'error')
    }
  }

  return (
    <article className="glass wp-card" aria-label={title || 'Untitled video'}>
      <div className="wp-card-art" style={it.poster ? undefined : { background: tint(it.url) }}>
        {it.poster ? <img src={it.poster} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span aria-hidden="true">{initials(title || kindLabel(it))}</span>}
        <span className="wp-card-kind">{kindLabel(it)}</span>
        <span className="wp-card-progress" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
      </div>
      <div className="wp-card-body">
        <h3 className="wp-card-title">{title || <span className="dim">{yt ? 'Untitled video' : 'Untitled video — tap ✎ to name it'}</span>}{it.year ? <span className="dim"> ({it.year})</span> : null}</h3>
        <p className="meta">
          {done ? '✓ Finished' : dur ? `Left off at ${fmtTime(pos)} of ${fmtTime(dur)}` : pos ? `Left off at ${fmtTime(pos)}` : 'Not started'}
        </p>
        <p className="meta">
          {watchers.length ? `${watchers.slice(0, 3).join(', ')}${watchers.length > 3 ? ` +${watchers.length - 3}` : ''} · ` : ''}{ago(it.last_watched_at)}
          {it.chat_count ? <> · <span aria-label={`${it.chat_count} chat messages`}>💬 {it.chat_count}</span></> : null}
        </p>
        <div className="wp-card-actions">
          {playing ? (
            <span className="wp-playing"><span className="wp-live-dot" aria-hidden="true" />Playing</span>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!canPlay} onClick={() => resumeItem(it)}>
              <Icon name="play" />{resumeAt ? `Resume ${fmtTime(resumeAt)}` : 'Play'}
            </button>
          )}
          <span className="wp-card-spacer" />
          <button type="button" className="icon-btn" aria-label={`Details${title ? ` for ${title}` : ''}`} onClick={() => setInfo(true)}><span aria-hidden="true">ⓘ</span></button>
          {!yt && <button type="button" className="icon-btn" aria-label={`Rename${title ? ` ${title}` : ''}`} onClick={() => setRename(true)}><Icon name="edit" /></button>}
          {mine && <button type="button" className="icon-btn" aria-label={`Forget${title ? ` ${title}` : ''}`} onClick={() => setForget(true)}><Icon name="close" /></button>}
        </div>
      </div>
      {info && <InfoDialog it={it} onClose={() => setInfo(false)} />}
      <RenameDialog it={it} open={rename} onOpenChange={setRename} />
      <ConfirmDialog
        open={forget} onOpenChange={setForget} title="Forget this video?" action="Forget"
        body={<p>Forget ‘{title || 'Untitled video'}’? Your progress and the chat are gone.</p>}
        onConfirm={() => void doForget()}
      />
    </article>
  )
}

function RenameDialog({ it, open, onOpenChange }: { it: HistItem; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [value, setValue] = useState(it.title || '')
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()
  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = value.trim()
    if (!t) return
    setBusy(true)
    try {
      await renameVideo(it.url, t)
      toast('Renamed', 'success')
      onOpenChange(false)
      void qc.invalidateQueries({ queryKey: ['watch', 'history'] })
    } catch (err) {
      toast((err instanceof ApiError && err.detail) || "Couldn't rename it", 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (v) setValue(it.title || ''); onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <Dialog.Title className="dialog-title">Name this video</Dialog.Title>
          <form onSubmit={submit}>
            <label className="field-label" htmlFor={`wp-rn-${it.url.length}`}>Title</label>
            <input id={`wp-rn-${it.url.length}`} className="input" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} autoFocus />
            <div className="dialog-actions">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function InfoDialog({ it, onClose }: { it: HistItem; onClose: () => void }) {
  const s = useWatch()
  const chat = useQuery({
    queryKey: ['watch', 'history', 'chat', it.url],
    queryFn: ({ signal }) => historyChat(it.url, s.room, signal),
    enabled: !!s.room,
  })
  const about = it.overview || it.description
  return (
    <Dialog.Root open onOpenChange={(v) => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog dialog-wide" aria-describedby={undefined}>
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">{it.title || 'Untitled video'}</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="icon-btn" aria-label="Close details"><Icon name="close" /></button></Dialog.Close>
          </div>
          <div className="sheet-body">
            <p className="meta">{kindLabel(it)}{it.year ? ` · ${it.year}` : ''}{it.duration ? ` · ${fmtTime(it.duration)}` : ''}</p>
            {about && <p>{about}</p>}
            {it.meta_url && <p><a className="btn btn-ghost" href={it.meta_url} target="_blank" rel="noreferrer">More about it <Icon name="external" /></a></p>}
            {it.viewers.length > 0 && (
              <>
                <h3 className="eyebrow">Who watched</h3>
                <ul className="rows wp-viewers">
                  {it.viewers.map((v) => (
                    <li key={v.name}><b>{v.name}</b> <span className="meta">{v.finished ? '✓ Finished' : `at ${fmtTime(v.position)}`} · {ago(v.updated_at)}</span></li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="eyebrow">Chat</h3>
            {chat.isError ? <ErrorStrip text="Chat didn't load" onRetry={() => chat.refetch()} />
              : chat.isPending ? <SkeletonRows n={2} />
              : chat.data.messages.length === 0 ? <p className="dim">No chat during this one.</p>
              : (
                <ul className="rows wp-chat-log">
                  {chat.data.messages.map((m, i) => (
                    <li key={i} className="wp-chat-line">
                      {m.video_ts != null && <span className="meta num">{fmtTime(m.video_ts)} </span>}<b>{m.name}</b> {m.msg}
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
