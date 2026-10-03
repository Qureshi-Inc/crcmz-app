// Share → CRCMZ from another app (the phone's share sheet; Android, the iPhone app's share
// extension, an installed web app). A music link (Spotify, Apple Music, YouTube Music,
// SoundCloud, Deezer, Tidal) goes into the Slap library, in your picks, and you're told
// when it's in; anything else opens the Watch Party with the link ready to play.
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ApiError, request } from '../../lib/http'

const MUSIC = /^https:\/\/(music\.apple\.com|open\.spotify\.com|music\.youtube\.com|soundcloud\.com|(www\.)?deezer\.com|tidal\.com|listen\.tidal\.com)\//i

/** The first link in what was shared ("Song by Artist https://…" is common). */
export function sharedLink(...parts: (string | null)[]): string {
  for (const p of parts) {
    const m = /https?:\/\/\S+/i.exec(p || '')
    if (m) return m[0].replace(/[)\].,!?'"]+$/, '')
  }
  return ''
}
export const isMusicLink = (u: string) => MUSIC.test(u)

type Result = { status: 'downloading' | 'already_in_library'; title?: string | null; artist?: string | null }

export function SharePage() {
  useTitle('Add to Slap')
  const [q] = useSearchParams()
  const link = sharedLink(q.get('url'), q.get('text'), q.get('title'))
  const [res, setRes] = useState<Result | null>(null)
  const [err, setErr] = useState('')
  const sent = useRef(false)
  const music = isMusicLink(link)
  useEffect(() => {
    if (!music || sent.current) return
    sent.current = true
    request<Result>('/api/slap/share', { body: { url: link, text: q.get('text') || '' }, timeoutMs: 45_000 })
      .then(setRes)
      .catch((e) => setErr(e instanceof ApiError && e.detail ? e.detail : "Couldn't add that song."))
  }, [music, link, q])
  if (!music) {
    const to = new URLSearchParams()
    if (link) to.set('url', link)
    if (q.get('text')) to.set('text', q.get('text')!)
    return <Navigate to={`/watch/party?${to}`} replace />
  }
  const name = res?.title ? `${res.title}${res.artist ? ` · ${res.artist}` : ''}` : 'Your song'
  return (
    <div className="page share-page">
      <section className="glass share-card" aria-live="polite">
        <Icon name="slap" className="nav-icon share-icon" />
        {err ? (
          <>
            <p className="empty-title">Couldn't add it</p>
            <p className="meta">{err}</p>
          </>
        ) : !res ? (
          <p className="empty-title" role="status"><span className="spinner" aria-hidden="true" /> Adding to Slap…</p>
        ) : res.status === 'already_in_library' ? (
          <>
            <p className="empty-title">{name} is already in Slap</p>
            <p className="meta">Nothing to download.</p>
          </>
        ) : (
          <>
            <p className="empty-title">Downloading {name}</p>
            <p className="meta">It goes into your picks in Slap. You'll get a notification when it's in, in a minute or two.</p>
          </>
        )}
        <Link className="btn btn-primary" to="/slap"><Icon name="slap" />Open Slap</Link>
      </section>
    </div>
  )
}
