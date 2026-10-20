// "Add to playlist…" — the sheet behind that menu item, shared by the library rows
// and the player. Lists the playlists you can edit, or makes you a new one.
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { addToPlaylist, createPlaylist, useLibrary } from '../../lib/slap'
import { ClipSheet } from '../clips/ClipSheet'
import { Art } from './NowPlaying'

const errText = (e: unknown, fallback: string) => (e instanceof ApiError && e.detail ? e.detail : fallback)

export function AddToPlaylist({ ids, title, open, onOpenChange, createOnly = false }: { ids: string[]; title: string; open: boolean; onOpenChange: (v: boolean) => void; createOnly?: boolean }) {
  const qc = useQueryClient()
  // Subscribe rather than snapshot the cache: the player can be opened from a page
  // that never fetched the library, and then there would be no playlists to pick.
  const lib = useLibrary().data
  const mine = (lib?.playlists ?? []).filter((p) => p.editable)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const done = (msg: string, pid?: string) => {
    toast(msg, 'success')
    qc.invalidateQueries({ queryKey: ['slap', 'library'] })
    if (pid) qc.invalidateQueries({ queryKey: ['slap', 'playlist', pid] })
    onOpenChange(false)
  }
  async function add(pid: string, pname: string) {
    setBusy(true)
    try { await addToPlaylist(pid, ids); done(`Added to ${pname}`, pid) } catch (e) { toast(errText(e, "Couldn't add it"), 'error') } finally { setBusy(false) }
  }
  async function create(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try { const r = await createPlaylist(name.trim(), ids); done(ids.length ? `Added to ${r.name}` : `Made ${r.name}`) } catch (err) { toast(errText(err, "Couldn't make the playlist"), 'error') } finally { setBusy(false) }
  }
  return (
    <ClipSheet open={open} onOpenChange={onOpenChange} title={createOnly ? 'New playlist' : `Add “${title}” to…`}>
      <div className="sheet-body">
        {!createOnly && (mine.length ? (
          <ul className="rows">
            {mine.map((p) => (
              <li key={p.id}><button type="button" className="group-row" disabled={busy} onClick={() => void add(p.id, p.name)}>
                <Art id={p.art} /><span className="track-text"><span className="track-title">{p.name}</span><span className="track-sub">{p.count} tracks</span></span>
              </button></li>
            ))}
          </ul>
        ) : <p className="dim">You don't have a playlist you can edit yet. Make one:</p>)}
        <form className="comment-form" onSubmit={create}>
          <label className="sr-only" htmlFor="new-pl">Playlist name</label>
          <input id="new-pl" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New playlist name" maxLength={80} autoFocus={createOnly} />
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>Create</button>
        </form>
      </div>
    </ClipSheet>
  )
}
