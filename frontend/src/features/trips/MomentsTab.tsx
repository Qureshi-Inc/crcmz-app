// A trip's Moments: post what happened (words, photos or both), everyone's posts
// newest first with likes, and the trip reel on top once it's made.
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { ago, initial, tripsApi, useMoments, type Moment, type Trip } from '../../lib/trips'
import { Sheet, errText } from '../tourney/Report'

const MAX_PHOTOS = 10

export function MomentsTab({ trip, preset }: { trip: Trip; preset?: { files: File[]; text: string } | null }) {
  const q = useMoments(trip.id)
  const qc = useQueryClient()
  const [text, setText] = useState(preset?.text || '')
  const [files, setFiles] = useState<File[]>(preset?.files.slice(0, MAX_PHOTOS) || [])
  const [posting, setPosting] = useState(false)
  const [full, setFull] = useState<string | null>(null)
  const pick = useRef<HTMLInputElement>(null)
  const previews = useRef<Map<File, string>>(new Map())
  const refresh = () => qc.invalidateQueries({ queryKey: ['trips', 'moments', trip.id] })

  useEffect(() => () => { previews.current.forEach((u) => URL.revokeObjectURL(u)) }, [])
  const preview = (f: File) => {
    let u = previews.current.get(f)
    if (!u) { u = URL.createObjectURL(f); previews.current.set(f, u) }
    return u
  }

  async function post() {
    if (posting || (!text.trim() && !files.length)) return
    setPosting(true)
    try {
      await tripsApi.postMoment(trip.id, text.trim(), files)
      setText(''); setFiles([])
      toast('Posted', 'success')
      await refresh()
    } catch (e) { toast(errText(e), 'error') } finally { setPosting(false) }
  }

  async function like(m: Moment) {
    try {
      const r = await tripsApi.like(trip.id, m.id)
      qc.setQueryData(['trips', 'moments', trip.id], (d: typeof q.data) => d && ({
        ...d, moments: d.moments.map((x) => (x.id === m.id ? { ...x, likes: r.likes, liked: r.liked } : x)),
      }))
    } catch (e) { toast(errText(e), 'error') }
  }

  async function remove(m: Moment) {
    if (!window.confirm('Delete this moment? Its photos stay in the album.')) return
    try { await tripsApi.removeMoment(trip.id, m.id); toast('Moment deleted'); await refresh() } catch (e) { toast(errText(e), 'error') }
  }

  const prepared = useRef<Map<string, File[]>>(new Map())
  async function share(key: string, urls: string[], title: string, words: string, btn: HTMLButtonElement) {
    const go = async (fs: File[]) => {
      const payload: ShareData = { title, text: words }
      if (fs.length && navigator.canShare?.({ files: fs })) payload.files = fs
      try { await navigator.share(payload); btn.textContent = 'Share' } catch (e) {
        // Fetching the files can outlast the tap that lets a page open the share sheet.
        btn.textContent = (e as Error)?.name === 'AbortError' ? 'Share' : 'Tap again to share'
      }
    }
    const ready = prepared.current.get(key)
    if (ready) return go(ready)
    if (!urls.length) return go([])
    btn.textContent = 'Getting it ready…'
    try {
      const fs = await Promise.all(urls.map(async (u, i) => {
        const r = await fetch(u, { credentials: 'same-origin' })
        if (!r.ok) throw new Error('fetch')
        const b = await r.blob()
        const ext = b.type.includes('video') ? 'mp4' : 'jpg'
        return new File([b], `${key === 'reel' ? 'trip-reel' : `moment-${i + 1}`}.${ext}`, { type: b.type || 'image/jpeg' })
      }))
      prepared.current.set(key, fs)
      await go(fs)
    } catch { btn.textContent = 'Share'; await go([]) }
  }

  const canShare = typeof navigator !== 'undefined' && Boolean(navigator.share)
  const reel = q.data?.reel

  return (
    <div className="tr-moments">
      {reel && reel.status !== 'none' && (
        <section className="glass tr-reel" aria-live="polite">
          <h2 className="tr-h2">The trip reel</h2>
          {reel.status === 'ready' && reel.url ? (
            <>
              <p className="dim">{reel.slides ?? 0} shots from {reel.moments ?? 0} moments, about {reel.seconds ?? 0} seconds.</p>
              <video className="tr-video" controls playsInline preload="metadata" src={reel.url} />
              {canShare && (
                <button type="button" className="btn btn-secondary" onClick={(e) => void share('reel', [reel.url!], `${trip.name} reel`, trip.name, e.currentTarget)}>Share</button>
              )}
            </>
          ) : reel.status === 'building' ? <p className="dim">Making the reel… this updates by itself.</p>
            : <p className="field-err">{reel.error || "The reel didn't make it."}</p>}
        </section>
      )}

      <form className="glass tr-compose" onSubmit={(e) => { e.preventDefault(); void post() }}>
        <label className="sr-only" htmlFor="tr-moment-text">What happened?</label>
        <textarea id="tr-moment-text" className="input tr-compose-text" rows={2} maxLength={1000} placeholder="What just happened?" value={text} onChange={(e) => setText(e.target.value)} />
        {files.length > 0 && (
          <ul className="tr-previews" aria-label="Photos to post">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {/^image\//.test(f.type) ? <img src={preview(f)} alt="" /> : <span className="tr-thumb-empty">video</span>}
                <button type="button" className="tr-prev-x" aria-label={`Remove photo ${i + 1}`} onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="tr-compose-row">
          <button type="button" className="btn btn-secondary" onClick={() => pick.current?.click()} disabled={files.length >= MAX_PHOTOS}><Icon name="plus" className="btn-ico" />Photos</button>
          <input ref={pick} type="file" accept="image/*,video/*" multiple hidden aria-label="Photos for the moment"
            onChange={(e) => { const add = Array.from(e.target.files || []); e.target.value = ''; setFiles((xs) => [...xs, ...add].slice(0, MAX_PHOTOS)) }} />
          <span className="meta tr-grow">{trip.linked ? 'Photos land in the trip album too.' : `${files.length}/${MAX_PHOTOS} photos`}</span>
          <button type="submit" className="btn btn-primary" disabled={posting || (!text.trim() && !files.length)}>{posting ? 'Posting…' : 'Post'}</button>
        </div>
      </form>

      {q.isError && !q.data ? <ErrorStrip text="Couldn't load the moments" onRetry={() => q.refetch()} />
        : !q.data ? <SkeletonRows n={3} height={96} />
          : q.data.moments.length === 0 ? (
            <div className="empty glass"><p className="empty-title">No moments yet</p><p className="dim">Post the first thing that happened.</p></div>
          ) : (
            <ul className="tr-feed">
              {q.data.moments.map((m) => (
                <li key={m.id}>
                  <article className="glass tr-card" aria-label={`${m.by}, ${ago(m.at)}`}>
                    <header className="tr-card-head">
                      <span className="tr-av tr-av-lg" aria-hidden="true">{initial(m.by)}</span>
                      <span className="tr-row-main"><b>{m.by}</b><span className="meta"><time dateTime={m.at}>{ago(m.at)}</time></span></span>
                      {m.mine && <button type="button" className="icon-btn" aria-label="Delete this moment" onClick={() => void remove(m)}><Icon name="trash" /></button>}
                    </header>
                    {m.text && <p className="tr-text">{m.text}</p>}
                    {m.photos.length > 0 && (
                      <div className={`tr-photos${m.photos.length === 1 ? ' is-one' : ''}`}>
                        {m.photos.map((p, i) => (p.kind === 'video'
                          ? <video key={p.name} src={p.url} controls playsInline preload="metadata" />
                          : (
                            <button key={p.name} type="button" className="tr-photo" aria-label={`Open photo ${i + 1} of ${m.photos.length}`} onClick={() => setFull(p.url)}>
                              <img src={p.thumb} alt="" loading="lazy" />
                            </button>
                          )))}
                      </div>
                    )}
                    <footer className="tr-card-foot">
                      <button type="button" className="btn btn-secondary tr-like" aria-pressed={m.liked} aria-label={`${m.liked ? 'Unlike' : 'Like'}, ${m.likes} ${m.likes === 1 ? 'like' : 'likes'}`} onClick={() => void like(m)}>
                        <Icon name="heart" className="btn-ico" />{m.likes}
                      </button>
                      {canShare && (
                        <button type="button" className="btn btn-ghost" onClick={(e) => void share(`m:${m.id}`, m.photos.filter((p) => p.kind === 'image').slice(0, 4).map((p) => p.url),
                          `${trip.name} · ${m.by}`, `${m.text ? `${m.text}\n` : ''}— ${m.by}, ${trip.name}`, e.currentTarget)}>Share</button>
                      )}
                    </footer>
                  </article>
                </li>
              ))}
            </ul>
          )}

      <Sheet open={Boolean(full)} onOpenChange={(v) => { if (!v) setFull(null) }} title="Photo">
        {full && <img className="tr-full" src={full} alt="" />}
      </Sheet>
    </div>
  )
}
