// Slap · Discover, the first thing Slap shows. The week's AI mix from the library,
// what just came in, what the squad is playing, and New finds: up to 30 AI picks a day
// the library doesn't have. The play sign on a cover is Apple's 30-second preview; the
// download icon brings the song in and files it in the presser's picks. Finds nobody
// downloads leave at midnight (Pacific) and tomorrow brings new ones.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { ApiError } from '../../lib/http'
import {
  approveFind, downloadFind, slapName, useDiscover, useLibrary, useSocial,
  type Discover as DiscoverData, type Find, type Track,
} from '../../lib/slap'
import { Art } from './NowPlaying'
import { enqueue, getState, playList, toggle, usePlayer } from './player'

type Mix = { name: string; description: string; tracks: { track_id: string; title: string; artist: string }[] }
type Ranked = { track_id: string; title: string; artist: string; play_count: number; unique_listeners: number; thumb_ups?: number }
type Insights = { trending: Ranked[]; squad_favorites: Ranked[] }
type Hot = { tracks: Ranked[] }
type Recent = { items: { title: string; artist: string; username: string }[] }

const key = (title: string, artist: string) => `${title}|${artist}`.toLowerCase().replace(/\s+/g, ' ')

function play(list: Track[], i = 0) {
  if (!list.length) return
  // In a room, tapping shares the song rather than replacing everyone's music.
  if (getState().mode === 'together') enqueue(i ? [list[i]!] : list, false)
  else playList(list, i)
}

export function Discover({ isAdmin }: { isAdmin: boolean }) {
  const lib = useLibrary()
  const byId = useMemo(() => new Map((lib.data?.tracks ?? []).map((t) => [t.id, t])), [lib.data])
  const pick = useCallback((ids: string[]) => ids.map((i) => byId.get(i)).filter((t): t is Track => !!t), [byId])

  return (
    <div className="discover">
      <MixHero pick={pick} loading={lib.isPending} />
      <NewFinds isAdmin={isAdmin} byId={byId} />
      <RecentShelf tracks={lib.data?.tracks ?? []} loading={lib.isPending} />
      <Charts pick={pick} />
    </div>
  )
}

// ── The AI mix (library songs) ──────────────────────────────────────────────
function MixHero({ pick, loading }: { pick: (ids: string[]) => Track[]; loading: boolean }) {
  const mix = useSocial<Mix>('dashboard/ai/weekly-playlist')
  const tracks = useMemo(() => pick((mix.data?.tracks ?? []).map((t) => t.track_id)), [mix.data, pick])
  if (mix.isError) return null
  return (
    <section className="glass disc-hero" aria-labelledby="disc-mix-h">
      <p className="disc-kicker">AI mix of the week · from the library</p>
      <h2 className="disc-hero-h" id="disc-mix-h">{mix.data?.name ?? 'Making this week’s mix…'}</h2>
      {mix.data?.description && <p className="disc-hero-sub">{mix.data.description}</p>}
      <div className="disc-hero-acts">
        <button type="button" className="btn btn-primary" onClick={() => play(tracks)} disabled={!tracks.length}>
          <Icon name="play" />Play the mix
        </button>
        <span className="meta num">{tracks.length ? `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}` : loading || mix.isPending ? ' ' : 'Not in the library yet'}</span>
      </div>
      {tracks.length > 0 && <Shelf label="Songs in the mix" tracks={tracks} />}
    </section>
  )
}

function Shelf({ label, tracks, sub }: { label: string; tracks: Track[]; sub?: (t: Track) => string }) {
  return (
    <ul className="shelf" aria-label={label}>
      {tracks.map((t, i) => (
        <li key={t.id}>
          <button type="button" className="shelf-card" onClick={() => play(tracks, i)} aria-label={`Play ${t.title} by ${t.artist}`}>
            <Art id={t.art} size={300} className="slap-art shelf-art" />
            <span className="shelf-title">{t.title}</span>
            <span className="shelf-sub">{sub?.(t) ?? t.artist}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

// ── New finds (not in the library) ──────────────────────────────────────────
function NewFinds({ isAdmin, byId }: { isAdmin: boolean; byId: Map<string, Track> }) {
  const q = useDiscover()
  const qc = useQueryClient()
  const s = usePlayer()
  const audio = useRef<HTMLAudioElement | null>(null)
  const [hearing, setHearing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const done = q.data?.finds.filter((f) => f.status === 'done').length ?? 0
  const seen = useRef(done)

  // A download finishing changes the library: fetch it so Play works.
  useEffect(() => {
    if (done > seen.current) void qc.invalidateQueries({ queryKey: ['slap', 'library'] })
    seen.current = done
  }, [done, qc])
  useEffect(() => () => { audio.current?.pause() }, [])
  // The real player starting stops a preview.
  useEffect(() => { if (s.playing && hearing) { audio.current?.pause(); setHearing(null) } }, [s.playing])  // eslint-disable-line react-hooks/exhaustive-deps

  function listen(f: Find) {
    if (!f.preview) return
    if (hearing === f.id) { audio.current?.pause(); setHearing(null); return }
    if (getState().playing && getState().mode === 'solo') toggle()
    audio.current?.pause()
    const a = new Audio(f.preview)
    a.onended = () => setHearing(null)
    a.onerror = () => { setHearing(null); toast("That preview won't play", 'warning') }
    audio.current = a
    setHearing(f.id)
    void a.play().catch(() => setHearing(null))
  }

  async function download(f: Find) {
    setBusy(f.id)
    try {
      const r = await downloadFind(f.id)
      patch(r)
      toast(r.status === 'done' ? 'Already in the library' : `Downloading ${r.title}. It goes in your picks.`, 'success')
    } catch (e) {
      toast(e instanceof ApiError && e.detail ? e.detail : "That download didn't start", 'error')
    } finally { setBusy(null) }
  }
  async function approve(f: Find) {
    setBusy(f.id)
    try { patch(await approveFind(f.id)); toast('Approved. Downloading now.', 'success') }
    catch (e) { toast(e instanceof ApiError && e.detail ? e.detail : "That didn't go through", 'error') }
    finally { setBusy(null) }
  }
  function patch(r: Find) {
    qc.setQueryData<DiscoverData>(['slap', 'discover'], (d) => d && { ...d, finds: d.finds.map((x) => (x.id === r.id ? r : x)) })
  }

  const finds = q.data?.finds ?? []
  if (q.data?.off) return null
  return (
    <section aria-labelledby="disc-new-h" className="disc-new">
      <div className="disc-sec-head">
        <h2 className="section-h2" id="disc-new-h">New finds</h2>
        <p className="meta">Picked by AI for the squad, not in the library yet. Tap a cover to hear it; download one and it’s yours. New songs every day.</p>
      </div>
      {q.isError ? <ErrorStrip text="Couldn't load today's finds." onRetry={() => q.refetch()} />
        : q.isPending || (!finds.length && (q.data?.making || !q.data?.ready)) ? (
          <div className="glass"><p className="meta disc-note" aria-live="polite">Finding new songs for the squad…</p><SkeletonRows n={2} height={120} /></div>
        ) : !finds.length ? (
          <div className="glass empty"><p className="empty-title">No new finds today yet</p><p className="meta">They show up once the squad has added a few songs.</p></div>
        ) : (
          <ul className="find-grid" aria-label={`${finds.length} new finds`} tabIndex={0}>
            {finds.map((f) => (
              <FindTile key={f.id} f={f} hearing={hearing === f.id} busy={busy === f.id} isAdmin={isAdmin}
                track={f.track_id ? byId.get(f.track_id) : undefined}
                onListen={() => listen(f)} onDownload={() => download(f)} onApprove={() => approve(f)} />
            ))}
          </ul>
        )}
    </section>
  )
}

/** One find: the cover plays the preview (or the song, once it's in the library); the
 *  download icon brings it in. Title, artist and who it was picked for underneath. */
function FindTile({ f, hearing, busy, isAdmin, track, onListen, onDownload, onApprove }: {
  f: Find; hearing: boolean; busy: boolean; isAdmin: boolean; track?: Track
  onListen: () => void; onDownload: () => void; onApprove: () => void
}) {
  const by = f.by ? slapName(f.by) || f.by : null
  const done = f.status === 'done' && !!track
  const canHear = done || (!!f.preview && f.status !== 'done')
  const canGet = f.status === 'new' || f.status === 'failed'
  return (
    <li className="find-tile" data-status={f.status}>
      <span className="find-cover">
        <button type="button" className="find-art" onClick={done ? () => play([track!]) : onListen} disabled={!canHear}
          aria-pressed={done ? undefined : hearing}
          aria-label={done ? `Play ${f.title}` : `${hearing ? 'Stop' : 'Hear'} a preview of ${f.title}`}>
          {f.art ? <img src={f.art} alt="" loading="lazy" decoding="async" /> : <Icon name="slap" />}
          {canHear && <span className="find-play" aria-hidden="true"><Icon name={hearing ? 'pause' : 'play'} /></span>}
        </button>
        {canGet && (
          <button type="button" className="find-get" onClick={onDownload} disabled={busy}
            aria-label={busy ? `Starting the download of ${f.title}` : f.status === 'failed' ? `Try downloading ${f.title} again` : `Download ${f.title}`}
            title={f.status === 'failed' ? (f.error ?? "Download didn't work") : 'Download'}>
            <Icon name={f.status === 'failed' ? 'refresh' : 'download'} />
          </button>
        )}
      </span>
      <span className="find-title" title={f.title}>{f.title}</span>
      <span className="find-sub" title={f.artist}>{f.artist}</span>
      {f.for && <span className="find-for">for {slapName(f.for) || f.for}</span>}
      <FindState f={f} by={by} />
      {f.status === 'review' && isAdmin && (
        <button type="button" className="btn btn-ghost find-approve" onClick={onApprove} disabled={busy}>Approve match</button>
      )}
    </li>
  )
}

function FindState({ f, by }: { f: Find; by: string | null }) {
  const who = by ? ` by ${by}` : ''
  switch (f.status) {
    case 'queued': return <span className="find-chip" data-tone="live" role="status" title={`Downloading${who}`}>Downloading…</span>
    case 'review': return <span className="find-chip" data-tone="warn" role="status" title="Waiting for an admin to check the match">Checking match</span>
    case 'done': return <span className="find-chip" data-tone="ok" role="status" title={by ? `Added by ${by}` : undefined}>In the library</span>
    case 'failed': return <span className="find-chip" data-tone="bad" role="status" title={f.error ?? undefined}>Didn't work</span>
    default: return null
  }
}

// ── What just came in ───────────────────────────────────────────────────────
function RecentShelf({ tracks, loading }: { tracks: Track[]; loading: boolean }) {
  const recent = useSocial<Recent>('dashboard/recent', { limit: 60 })
  const newest = useMemo(() => [...tracks].sort((a, b) => b.added.localeCompare(a.added)).slice(0, 14), [tracks])
  const who = useMemo(() => new Map((recent.data?.items ?? []).map((r) => [key(r.title, r.artist), r.username])), [recent.data])
  if (!loading && !newest.length) return null
  return (
    <section aria-labelledby="disc-recent-h">
      <h2 className="section-h2" id="disc-recent-h">Recently added</h2>
      {loading ? <SkeletonRows n={1} height={160} /> : (
        <Shelf label="Recently added" tracks={newest} sub={(t) => {
          const u = who.get(key(t.title, t.artist))
          return u ? `${t.artist} · ${slapName(u) || u}` : t.artist
        }} />
      )}
    </section>
  )
}

// ── What the squad is playing ───────────────────────────────────────────────
function Charts({ pick }: { pick: (ids: string[]) => Track[] }) {
  const ins = useSocial<Insights>('listening/insights')
  const hot = useSocial<Hot>('dashboard/hot')
  return (
    <>
      <Chart id="disc-week" title="Top this week" note="Most loved in the last 7 days: plays, finishes and thumbs."
        rows={ins.data?.trending ?? []} pending={ins.isPending} failed={ins.isError} pick={pick} />
      <Chart id="disc-hot" title="Hot today" note="Most played in the last 24 hours."
        rows={hot.data?.tracks ?? []} pending={hot.isPending} failed={hot.isError} pick={pick} />
      <Chart id="disc-fav" title="Squad favourites" note="The all-time most loved."
        rows={ins.data?.squad_favorites ?? []} pending={ins.isPending} failed={ins.isError} pick={pick} />
    </>
  )
}

function Chart({ id, title, note, rows, pending, failed, pick }: {
  id: string; title: string; note: string; rows: Ranked[]; pending: boolean; failed: boolean; pick: (ids: string[]) => Track[]
}) {
  const list = rows.slice(0, 10)
  const tracks = pick(list.map((r) => r.track_id))
  const inLib = new Set(tracks.map((t) => t.id))
  if (failed || (!pending && !list.length)) return null
  return (
    <section className="glass disc-chart" aria-labelledby={`${id}-h`}>
      <div className="card-head">
        <div>
          <h2 className="section-h2" id={`${id}-h`}>{title}</h2>
          <p className="meta">{note}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => play(tracks)} disabled={!tracks.length}>
          <Icon name="play" />Play all
        </button>
      </div>
      {pending ? <SkeletonRows n={4} /> : (
        <ol className="stat-rows">
          {list.map((r, i) => (
            <li key={`${r.track_id}-${i}`} className="stat-row">
              {inLib.has(r.track_id)
                ? <button type="button" className="icon-btn stat-play" onClick={() => play(pick([r.track_id]))} aria-label={`Play ${r.title}`}><Icon name="play" /></button>
                : <span className="stat-rank num">{i + 1}</span>}
              <span className="stat-text">
                <span className="stat-title">{r.title}</span>
                <span className="stat-sub">{r.artist}</span>
              </span>
              <span className="meta num disc-count">
                {[typeof r.play_count === 'number' ? `${r.play_count} ${r.play_count === 1 ? 'play' : 'plays'}` : '',
                  r.thumb_ups ? `${r.thumb_ups} thumbs up` : ''].filter(Boolean).join(' · ')}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
