// Listen Together: one room for the whole squad. Before joining you see who's in
// and what's on; once in, the queue and controls are shared with everyone.
import { useQuery } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { getJSON } from '../../lib/http'
import { fmtTime, type Room } from '../../lib/slap'
import { Art, QueueList, TogetherBanner } from './NowPlaying'
import { joinTogether, setExpanded, shareMyQueue, usePlayer } from './player'

export function Together({ onBrowse }: { onBrowse: () => void }) {
  const s = usePlayer()
  const joined = s.mode === 'together'
  const peek = useQuery({
    queryKey: ['slap', 'together'],
    queryFn: ({ signal }) => getJSON<Room>('/api/slap/together', signal),
    refetchInterval: 10_000,
    enabled: !joined,
  })

  if (!joined) {
    const r = peek.data
    const cur = r ? r.queue[r.index] : undefined
    const names = r?.members.map((m) => m.name) ?? []
    return (
      <section className="glass together-card" aria-labelledby="tg-h">
        <div className="together-intro">
          <Icon name="together" />
          <div>
            <h2 className="section-h2" id="tg-h">Listen Together</h2>
            <p className="dim">One queue, one play button, everyone hears the same thing. Anyone in the room can add, skip or pause.</p>
          </div>
        </div>
        {peek.isPending ? <SkeletonRows n={1} />
          : peek.isError ? <ErrorStrip text="Couldn't see the room" onRetry={() => peek.refetch()} />
          : (
            <div className="together-peek" aria-live="polite">
              <p className="together-who">
                {names.length ? <><b className="live-text">{names.length} listening</b> · {names.join(', ')}</> : 'Nobody in the room yet'}
              </p>
              {cur && (
                <div className="together-now">
                  <Art id={cur.art} />
                  <span className="track-text">
                    <span className="track-title">{cur.title}</span>
                    <span className="track-sub">{cur.artist}{r?.playing ? '' : ' · paused'}</span>
                  </span>
                </div>
              )}
              {r && r.queue.length > r.index + 1 && <p className="meta">{r.queue.length - r.index - 1} more in the shared queue</p>}
            </div>
          )}
        <div className="together-actions">
          <button type="button" className="btn btn-primary" onClick={joinTogether}><Icon name="together" />{names.length ? 'Join them' : 'Start a room'}</button>
        </div>
        <p className="meta">Your own queue is kept and comes back when you leave.</p>
      </section>
    )
  }

  const r = s.room
  const cur = r ? r.queue[r.index] : undefined
  return (
    <div className="together-live">
      <TogetherBanner s={s} />
      {!r ? <div className="glass"><SkeletonRows n={3} /></div> : (
        <>
          <section className="glass together-card" aria-label="Playing in the room">
            {cur ? (
              <button type="button" className="together-now together-now-big" onClick={() => setExpanded(true)} aria-label={`Open player: ${cur.title} by ${cur.artist}`}>
                <Art id={cur.art} size={300} className="slap-art together-art" />
                <span className="track-text">
                  <span className="eyebrow">{r.playing ? 'Playing for everyone' : 'Paused'}</span>
                  <span className="track-title">{cur.title}</span>
                  <span className="track-sub">{cur.artist}{cur.added_by ? ` · queued by ${cur.added_by}` : ''}</span>
                  <span className="meta num">{fmtTime(cur.duration)}</span>
                </span>
              </button>
            ) : (
              <div className="empty">
                <p className="empty-title">The room is quiet</p>
                <p className="dim">Tap any track in Listen to add it, or start from your own queue.</p>
              </div>
            )}
            <div className="together-actions">
              <button type="button" className="btn btn-secondary" onClick={onBrowse}><Icon name="search" />Add from the library</button>
              <button type="button" className="btn btn-secondary" onClick={shareMyQueue} disabled={!s.queue.length}><Icon name="queue" />Start from my queue</button>
            </div>
          </section>
          {r.queue.length > 0 && <div className="glass together-queue"><QueueList queue={r.queue} index={r.index} together level={2} /></div>}
        </>
      )}
    </div>
  )
}
