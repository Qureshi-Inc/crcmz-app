// PS-3 Listen: the squad's Jellyfin library, played through the proxy. Rows play
// solo, or go into the shared queue while you're in Listen Together.
import { useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ErrorStrip, SkeletonRows, SlowLoad } from '../../components/states'
import { ApiError } from '../../lib/http'
import {
  addToPlaylist, createPlaylist, deletePlaylist, editTrackInfo, fmtTime, removeFromPlaylist, setFavorite,
  useLibrary, usePlaylist, type Library, type Track,
} from '../../lib/slap'
import { ClipSheet, ConfirmDialog } from '../clips/ClipSheet'
import { Art } from './NowPlaying'
import { enqueue, getState, playList, usePlayer } from './player'

type View = 'songs' | 'albums' | 'artists' | 'playlists' | 'genres' | 'favs'
const VIEWS: { id: View; label: string }[] = [
  { id: 'songs', label: 'Songs' }, { id: 'albums', label: 'Albums' }, { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' }, { id: 'genres', label: 'Genres' }, { id: 'favs', label: 'Favourites' },
]
type Sort = 'added' | 'title' | 'artist' | 'plays'
const PAGE = 100

const errText = (e: unknown, fallback: string) => (e instanceof ApiError && e.detail ? e.detail : fallback)

export function Listen({ isAdmin }: { isAdmin: boolean }) {
  const [params, setParams] = useSearchParams()
  const lib = useLibrary()
  const view = (VIEWS.find((v) => v.id === params.get('lib'))?.id ?? 'songs') as View
  const open = params.get('open')
  const q = params.get('q') ?? ''

  function patch(p: Record<string, string | null>, replace = true) {
    setParams((cur) => {
      const n = new URLSearchParams(cur)
      for (const [k, v] of Object.entries(p)) { if (v == null || v === '') n.delete(k); else n.set(k, v) }
      return n
    }, { replace })
  }

  if (lib.isPending) return <div className="glass"><SkeletonRows n={8} /><SlowLoad onRetry={() => lib.refetch()} /></div>
  if (lib.isError) {
    const e = lib.error
    if (e instanceof ApiError && e.status === 409) {
      return (
        <div className="glass empty" role="alert">
          <p className="empty-title">Your music account needs an admin</p>
          <p className="dim">{e.detail}</p>
        </div>
      )
    }
    return <ErrorStrip text={errText(e, "The music library didn't answer")} onRetry={() => lib.refetch()} />
  }
  const data = lib.data

  if (open) {
    return <Detail open={open} data={data} isAdmin={isAdmin} onBack={() => patch({ open: null }, false)} />
  }

  return (
    <div className="listen">
      <div className="listen-tools">
        <label className="search-field">
          <Icon name="search" />
          <span className="sr-only">Search the library</span>
          <input className="input" type="search" value={q} placeholder={`Search ${data.tracks.length} tracks`} onChange={(e) => patch({ q: e.target.value || null })} />
        </label>
        <div className="chips listen-chips" role="group" aria-label="Browse by">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className="chip" aria-pressed={view === v.id} onClick={() => patch({ lib: v.id === 'songs' ? null : v.id })}>{v.label}</button>
          ))}
        </div>
      </div>
      {q.trim() ? <SearchResults q={q} data={data} isAdmin={isAdmin} onOpen={(o) => patch({ open: o }, false)} />
        : view === 'songs' ? <Songs tracks={data.tracks} isAdmin={isAdmin} recent />
        : view === 'favs' ? <Songs tracks={data.tracks.filter((t) => t.fav)} isAdmin={isAdmin} empty="No favourites yet. Tap the heart in the player." />
        : view === 'playlists' ? <Playlists data={data} onOpen={(id) => patch({ open: `playlist:${id}` }, false)} />
        : <Groups kind={view} tracks={data.tracks} onOpen={(o) => patch({ open: o }, false)} />}
    </div>
  )
}

// ── Songs ───────────────────────────────────────────────────────────────────
function sortTracks(ts: Track[], s: Sort): Track[] {
  const a = ts.slice()
  if (s === 'title') a.sort((x, y) => x.title.localeCompare(y.title))
  else if (s === 'artist') a.sort((x, y) => x.artist.localeCompare(y.artist) || x.album.localeCompare(y.album))
  else if (s === 'plays') a.sort((x, y) => y.plays - x.plays)
  else a.sort((x, y) => (y.added || '').localeCompare(x.added || ''))
  return a
}

function Songs({ tracks, isAdmin, recent = false, empty = 'No tracks here yet.' }: { tracks: Track[]; isAdmin: boolean; recent?: boolean; empty?: string }) {
  const [sort, setSort] = useState<Sort>('added')
  const list = useMemo(() => sortTracks(tracks, sort), [tracks, sort])
  const newest = useMemo(() => (recent ? sortTracks(tracks, 'added').slice(0, 12) : []), [tracks, recent])
  if (!tracks.length) return <div className="glass empty"><p className="empty-title">{empty}</p></div>
  return (
    <>
      {recent && newest.length > 0 && (
        <section aria-labelledby="recent-h">
          <h2 className="section-h2" id="recent-h">Recently added</h2>
          <ul className="shelf">
            {newest.map((t, i) => (
              <li key={t.id}>
                <button type="button" className="shelf-card" onClick={() => playOrAdd(newest, i)} aria-label={`Play ${t.title} by ${t.artist}`}>
                  <Art id={t.art} size={300} className="slap-art shelf-art" />
                  <span className="shelf-title">{t.title}</span>
                  <span className="shelf-sub">{t.artist}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <TrackList tracks={list} isAdmin={isAdmin} head={
        <label className="sort-field">
          <span className="meta">Sort</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="artist">Artist</option>
            <option value="plays">Most played</option>
          </select>
        </label>
      } />
    </>
  )
}

function playOrAdd(list: Track[], i: number) {
  const t = list[i]
  if (!t) return
  // In a room, tapping a track shares it rather than replacing everyone's music.
  if (getState().mode === 'together') enqueue([t], false)
  else playList(list, i)
}

export function TrackList({ tracks, isAdmin, head, playlist }: {
  tracks: Track[]; isAdmin: boolean; head?: React.ReactNode
  playlist?: { id: string; editable: boolean; entries: string[]; onRemove: (entry: string) => void }
}) {
  const [shown, setShown] = useState(PAGE)
  const s = usePlayer()
  const together = s.mode === 'together'
  const total = tracks.reduce((n, t) => n + t.duration, 0)
  return (
    <section className="glass tracklist">
      <div className="card-head tracklist-head">
        <span className="meta">{tracks.length} tracks · {fmtTime(total)}</span>
        <span className="tracklist-actions">
          {head}
          <button type="button" className="btn btn-primary" onClick={() => playList(tracks, 0, { shuffle: false })} disabled={!tracks.length}>
            <Icon name="play" />{together ? 'Play for everyone' : 'Play'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => playList(tracks, 0, { shuffle: true })} disabled={!tracks.length || together} aria-label="Shuffle play">
            <Icon name="shuffle" />Shuffle
          </button>
        </span>
      </div>
      <ul className="rows">
        {tracks.slice(0, shown).map((t, i) => (
          <TrackRow key={`${t.id}-${i}`} t={t} list={tracks} i={i} isAdmin={isAdmin} together={together}
            onRemove={playlist?.editable && playlist.entries[i] ? () => playlist.onRemove(playlist.entries[i]!) : undefined} />
        ))}
      </ul>
      {tracks.length > shown && (
        <button type="button" className="btn btn-secondary show-more" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, tracks.length - shown)} more</button>
      )}
    </section>
  )
}

function TrackRow({ t, list, i, isAdmin, together, onRemove }: { t: Track; list: Track[]; i: number; isAdmin: boolean; together: boolean; onRemove?: () => void }) {
  const s = usePlayer()
  const playing = s.mode === 'solo' ? s.queue[s.index]?.id === t.id : s.room?.queue[s.room.index]?.id === t.id
  return (
    <li className="track-row" data-playing={playing}>
      <button type="button" className="track-main" onClick={() => (together ? enqueue([t], false) : playList(list, i))}
        aria-label={together ? `Add ${t.title} by ${t.artist} to the shared queue` : `Play ${t.title} by ${t.artist}`}>
        <Art id={t.art} />
        <span className="track-text">
          <span className="track-title">{t.title}{t.fav && <span className="fav-mark" aria-label=", favourite"><Icon name="heartFill" /></span>}</span>
          <span className="track-sub">{[t.artist, t.album].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="track-dur num">{fmtTime(t.duration)}</span>
      </button>
      <TrackMenu t={t} isAdmin={isAdmin} together={together} onRemove={onRemove} />
    </li>
  )
}

function TrackMenu({ t, isAdmin, together, onRemove }: { t: Track; isAdmin: boolean; together: boolean; onRemove?: () => void }) {
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  function fav() {
    const on = !t.fav
    const flip = (v: boolean) => qc.setQueryData<Library>(['slap', 'library'], (d) => d && { ...d, tracks: d.tracks.map((x) => (x.id === t.id ? { ...x, fav: v } : x)) })
    flip(on)
    setFavorite(t.id, on).then(() => toast(on ? 'Added to favourites' : 'Removed from favourites', 'success')).catch((e) => { flip(!on); toast(errText(e, "Couldn't change that"), 'error') })
  }
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <button type="button" className="icon-btn track-more" aria-label={`More for ${t.title}`}><Icon name="more" /></button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="menu-content" sideOffset={4} align="end">
            <Menu.Item className="menu-item" onSelect={() => enqueue([t], true)}>{together ? 'Play next for everyone' : 'Play next'}</Menu.Item>
            <Menu.Item className="menu-item" onSelect={() => enqueue([t], false)}>{together ? 'Add to shared queue' : 'Add to queue'}</Menu.Item>
            <Menu.Item className="menu-item" onSelect={() => setAddOpen(true)}>Add to playlist…</Menu.Item>
            <Menu.Item className="menu-item" onSelect={fav}>{t.fav ? 'Remove from favourites' : 'Add to favourites'}</Menu.Item>
            {onRemove && <Menu.Item className="menu-item" onSelect={onRemove}>Remove from this playlist</Menu.Item>}
            {isAdmin && <Menu.Item className="menu-item" onSelect={() => setEditOpen(true)}>Edit track info</Menu.Item>}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {addOpen && <AddToPlaylist ids={[t.id]} title={t.title} open onOpenChange={setAddOpen} />}
      {editOpen && <EditInfo t={t} open onOpenChange={setEditOpen} />}
    </>
  )
}

// ── Search ──────────────────────────────────────────────────────────────────
function SearchResults({ q, data, isAdmin, onOpen }: { q: string; data: Library; isAdmin: boolean; onOpen: (o: string) => void }) {
  const needle = q.trim().toLocaleLowerCase()
  const hits = data.tracks.filter((t) => `${t.title} ${t.artist} ${t.album} ${t.genres.join(' ')}`.toLocaleLowerCase().includes(needle))
  const albums = groupBy(hits, 'albums').slice(0, 6)
  const lists = data.playlists.filter((p) => p.name.toLocaleLowerCase().includes(needle))
  if (!hits.length && !lists.length) return <div className="glass empty"><p className="empty-title">Nothing matches “{q.trim()}”</p><p className="dim">Try an artist, album or genre.</p></div>
  return (
    <>
      {(albums.length > 1 || lists.length > 0) && (
        <div className="chips search-jumps" role="group" aria-label="Open a match">
          {albums.length > 1 && albums.map((g) => <button key={g.key} type="button" className="chip" onClick={() => onOpen(`album:${g.key}`)}>{g.name}</button>)}
          {lists.map((p) => <button key={p.id} type="button" className="chip" onClick={() => onOpen(`playlist:${p.id}`)}>{p.name}<span className="chip-n">playlist</span></button>)}
        </div>
      )}
      {hits.length > 0 && <TrackList tracks={hits} isAdmin={isAdmin} />}
    </>
  )
}

// ── Albums / artists / genres ───────────────────────────────────────────────
type Group = { key: string; name: string; sub: string; art: string | null; tracks: Track[] }

function groupBy(tracks: Track[], kind: 'albums' | 'artists' | 'genres'): Group[] {
  const m = new Map<string, Group>()
  for (const t of tracks) {
    const keys = kind === 'albums' ? [t.album_id || `name:${t.album}`] : kind === 'artists' ? [t.album_artist || t.artist.split(', ')[0] || 'Unknown'] : (t.genres.length ? t.genres : ['Unknown'])
    for (const k of keys) {
      let g = m.get(k)
      if (!g) {
        g = { key: k, name: kind === 'albums' ? t.album || 'Singles' : k, sub: kind === 'albums' ? t.album_artist || t.artist : '', art: t.art, tracks: [] }
        m.set(k, g)
      }
      g.tracks.push(t)
      if (!g.art && t.art) g.art = t.art
    }
  }
  const gs = [...m.values()]
  for (const g of gs) if (kind !== 'albums') g.sub = `${g.tracks.length} track${g.tracks.length === 1 ? '' : 's'}`
  return gs.sort((a, b) => (kind === 'albums' ? a.name.localeCompare(b.name) : b.tracks.length - a.tracks.length || a.name.localeCompare(b.name)))
}

function Groups({ kind, tracks, onOpen }: { kind: 'albums' | 'artists' | 'genres'; tracks: Track[]; onOpen: (o: string) => void }) {
  const groups = useMemo(() => groupBy(tracks, kind), [tracks, kind])
  const [shown, setShown] = useState(60)
  const prefix = kind === 'albums' ? 'album' : kind === 'artists' ? 'artist' : 'genre'
  if (!groups.length) return <div className="glass empty"><p className="empty-title">Nothing here yet.</p></div>
  return (
    <>
      <ul className={kind === 'albums' ? 'album-grid' : 'glass rows'}>
        {groups.slice(0, shown).map((g) => (
          <li key={g.key}>
            {kind === 'albums' ? (
              <button type="button" className="album-card" onClick={() => onOpen(`${prefix}:${g.key}`)}>
                <Art id={g.art} size={300} className="slap-art album-art" />
                <span className="shelf-title">{g.name}</span>
                <span className="shelf-sub">{g.sub}</span>
              </button>
            ) : (
              <button type="button" className="group-row" onClick={() => onOpen(`${prefix}:${g.key}`)}>
                <Art id={g.art} />
                <span className="track-text"><span className="track-title">{g.name}</span><span className="track-sub">{g.sub}</span></span>
                <Icon name="right" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {groups.length > shown && <button type="button" className="btn btn-secondary show-more" onClick={() => setShown((n) => n + 60)}>Show more</button>}
    </>
  )
}

// ── Detail: album, artist, genre or playlist ────────────────────────────────
function Detail({ open, data, isAdmin, onBack }: { open: string; data: Library; isAdmin: boolean; onBack: () => void }) {
  const [kind, ...rest] = open.split(':')
  const key = rest.join(':')
  if (kind === 'playlist') return <PlaylistDetailView pid={key} data={data} isAdmin={isAdmin} onBack={onBack} />
  const groups = groupBy(data.tracks, kind === 'album' ? 'albums' : kind === 'artist' ? 'artists' : 'genres')
  const g = groups.find((x) => x.key === key)
  return (
    <div className="listen">
      <button type="button" className="btn btn-ghost back-btn" onClick={onBack}><Icon name="left" />Library</button>
      {!g ? <div className="glass empty"><p className="empty-title">That's not in the library any more.</p></div> : (
        <>
          <div className="detail-head">
            <Art id={g.art} size={300} className="slap-art detail-art" />
            <div>
              <p className="eyebrow">{kind === 'album' ? 'Album' : kind === 'artist' ? 'Artist' : 'Genre'}</p>
              <h2 className="detail-title">{g.name}</h2>
              {kind === 'album' && <p className="dim">{g.sub}</p>}
            </div>
          </div>
          <TrackList tracks={g.tracks} isAdmin={isAdmin} />
        </>
      )}
    </div>
  )
}

function PlaylistDetailView({ pid, data, isAdmin, onBack }: { pid: string; data: Library; isAdmin: boolean; onBack: () => void }) {
  const pl = usePlaylist(pid)
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const byId = useMemo(() => new Map(data.tracks.map((t) => [t.id, t])), [data.tracks])
  const rows = (pl.data?.items ?? []).map((it) => ({ entry: it.entry, t: byId.get(it.id) })).filter((r): r is { entry: string; t: Track } => !!r.t)
  const meta = data.playlists.find((p) => p.id === pid)
  const editable = pl.data?.editable ?? meta?.editable ?? false

  const removeEntry = (entry: string) => {
    removeFromPlaylist(pid, [entry]).then(() => {
      toast('Removed from the playlist', 'success')
      qc.invalidateQueries({ queryKey: ['slap', 'playlist', pid] })
      qc.invalidateQueries({ queryKey: ['slap', 'library'] })
    }).catch((e) => toast(errText(e, "Couldn't remove that"), 'error'))
  }
  function del() {
    deletePlaylist(pid).then(() => {
      toast('Playlist deleted', 'success')
      qc.invalidateQueries({ queryKey: ['slap', 'library'] })
      onBack()
    }).catch((e) => toast(errText(e, "Couldn't delete it"), 'error'))
  }
  return (
    <div className="listen">
      <button type="button" className="btn btn-ghost back-btn" onClick={onBack}><Icon name="left" />Playlists</button>
      <div className="detail-head">
        <Art id={meta?.art ?? rows[0]?.t.art} size={300} className="slap-art detail-art" />
        <div>
          <p className="eyebrow">Playlist{editable ? '' : ' · view only'}</p>
          <h2 className="detail-title">{pl.data?.name ?? meta?.name ?? 'Playlist'}</h2>
          {editable && <button type="button" className="btn btn-danger" onClick={() => setConfirm(true)}><Icon name="trash" />Delete playlist</button>}
        </div>
      </div>
      {pl.isPending ? <div className="glass"><SkeletonRows n={5} /></div>
        : pl.isError ? <ErrorStrip text={errText(pl.error, "That playlist didn't load")} onRetry={() => pl.refetch()} />
        : rows.length ? <TrackList tracks={rows.map((r) => r.t)} isAdmin={isAdmin} playlist={{ id: pid, editable, entries: rows.map((r) => r.entry), onRemove: removeEntry }} />
        : <div className="glass empty"><p className="empty-title">This playlist is empty.</p><p className="dim">Use “Add to playlist…” on any track.</p></div>}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this playlist?" body={<p>{pl.data?.name ?? meta?.name} goes for everyone. The tracks stay in the library.</p>} action="Delete" onConfirm={del} />
    </div>
  )
}

function Playlists({ data, onOpen }: { data: Library; onOpen: (id: string) => void }) {
  const [creating, setCreating] = useState(false)
  return (
    <>
      <div className="listen-row-actions">
        <button type="button" className="btn btn-secondary" onClick={() => setCreating(true)}><Icon name="plus" />New playlist</button>
      </div>
      {data.playlists.length ? (
        <ul className="glass rows">
          {data.playlists.map((p) => (
            <li key={p.id}>
              <button type="button" className="group-row" onClick={() => onOpen(p.id)}>
                <Art id={p.art} />
                <span className="track-text">
                  <span className="track-title">{p.name}</span>
                  <span className="track-sub">{p.count} track{p.count === 1 ? '' : 's'}{p.editable ? '' : ' · view only'}</span>
                </span>
                <Icon name="right" />
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="glass empty"><p className="empty-title">No playlists yet.</p></div>}
      {creating && <AddToPlaylist ids={[]} title="" open onOpenChange={setCreating} createOnly />}
    </>
  )
}

function AddToPlaylist({ ids, title, open, onOpenChange, createOnly = false }: { ids: string[]; title: string; open: boolean; onOpenChange: (v: boolean) => void; createOnly?: boolean }) {
  const qc = useQueryClient()
  const lib = qc.getQueryData<Library>(['slap', 'library'])
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

function EditInfo({ t, open, onOpenChange }: { t: Track; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ title: t.title, artist: t.artist, album: t.album, genre: t.genres.join(', '), year: t.year ? String(t.year) : '' })
  const [busy, setBusy] = useState(false)
  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const year = f.year.trim() ? Number(f.year) : null
      await editTrackInfo(t.id, { title: f.title.trim(), artist: f.artist.trim(), album: f.album.trim(), genre: f.genre.trim(), year })
      qc.setQueryData<Library>(['slap', 'library'], (d) => d && {
        ...d,
        tracks: d.tracks.map((x) => (x.id === t.id ? { ...x, title: f.title.trim(), artist: f.artist.trim(), album: f.album.trim(), genres: f.genre.split(',').map((g) => g.trim()).filter(Boolean), year } : x)),
      })
      toast('Track info saved', 'success')
      onOpenChange(false)
    } catch (err) { toast(errText(err, "Jellyfin didn't take that"), 'error') } finally { setBusy(false) }
  }
  const field = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <div>
      <label className="field-label" htmlFor={`ti-${k}`}>{label}</label>
      <input id={`ti-${k}`} className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} />
    </div>
  )
  return (
    <ClipSheet open={open} onOpenChange={onOpenChange} title="Edit track info">
      <form className="sheet-body form-stack" onSubmit={save}>
        {field('title', 'Title', { required: true, maxLength: 200 })}
        {field('artist', 'Artist', { maxLength: 200 })}
        {field('album', 'Album', { maxLength: 200 })}
        {field('genre', 'Genre (comma-separated)', { maxLength: 200 })}
        {field('year', 'Year', { inputMode: 'numeric', pattern: '[0-9]{4}' })}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
        </div>
      </form>
    </ClipSheet>
  )
}
