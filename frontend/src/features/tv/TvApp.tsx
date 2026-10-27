// The Android TV app: only the Watch Party, for a remote and a sofa. Movies to pick
// from (Watch Now, Library, Search), a movie's page (play it, or add it to the library),
// and a full-screen player with the party in it: cameras, reactions, chat, settings.
// The party engine is the phone's (features/watch/session.ts); only the screens differ.
// Phones never load this (App.tsx lazy-loads it when lib/tv.ts says we're on a TV).
import '../../styles/tv.css'
import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Toaster } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { getNow } from '../../lib/movies'
import { redirectToLogin } from '../../lib/session'
import { focusFirst, useSpatialNav } from '../../lib/tv'
import { watchTogether } from '../watch/session'
import { TvHome } from './TvHome'
import { TvMovie } from './TvMovie'
import { TvPlayer } from './TvPlayer'

export function TvApp() {
  useSpatialNav()
  useEffect(() => {
    document.documentElement.dataset.tv = ''
    return () => { delete document.documentElement.dataset.tv }
  }, [])
  const loc = useLocation()
  const onPlay = loc.pathname === '/tv/play'
  useSignInProbe()
  return (
    <div className="tv">
      <Routes>
        <Route path="tv" element={<TvHome />} />
        <Route path="tv/m/:imdb" element={<TvMovie />} />
        <Route path="tv/play" element={null} />
        <Route path="*" element={<Navigate to="/tv" replace />} />
      </Routes>
      {onPlay && <TvPlayer />}
      <Toaster />
    </div>
  )
}

/** Signed out (the cookie expired on the TV): off to sign in, and back here after. */
function useSignInProbe() {
  const q = useNowTv()
  useEffect(() => { if (q.error instanceof ApiError && q.error.status === 401) redirectToLogin() }, [q.error])
}

export function useNowTv() {
  return useQuery({ queryKey: ['movies', 'now'], queryFn: ({ signal }) => getNow(signal), refetchInterval: 15_000, staleTime: 10_000 })
}

/** Play something for the party and open the player. If the party is on something else, ask first. */
export function useTvPlay() {
  const navigate = useNavigate()
  const now = useNowTv().data
  const [ask, setAsk] = useState<{ url: string; title: string; at: number } | null>(null)
  const go = (url: string, title: string, at = 0) => { watchTogether(url, title, at); navigate('/tv/play') }
  const play = (url: string, title: string, at = 0) => {
    if (now && now.watching > 0 && now.video && now.video !== url) setAsk({ url, title, at })
    else go(url, title, at)
  }
  const join = () => navigate('/tv/play')
  const confirm = ask && (
    <TvDialog title="Switch the party?" onClose={() => setAsk(null)}>
      <p>{now?.watching ?? 0} {now?.watching === 1 ? 'person is' : 'people are'} watching {now?.title ? `‘${now.title}’` : 'something else'}. Switch everyone to ‘{ask.title}’?</p>
      <div className="tv-dialog-acts">
        <button type="button" className="tv-btn tv-btn-primary" data-tv-autofocus onClick={() => { const a = ask; setAsk(null); go(a.url, a.title, a.at) }}>Switch</button>
        <button type="button" className="tv-btn" onClick={join}>Join what's on</button>
        <button type="button" className="tv-btn" onClick={() => setAsk(null)}>Cancel</button>
      </div>
    </TvDialog>
  )
  return { play, join, confirm, now }
}

/** A centred dialog that holds the remote's focus until it closes. */
export function TvDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el) return
    const back = document.activeElement as HTMLElement | null
    focusFirst(el)
    return () => back?.focus({ preventScroll: true })
  }, [el])
  return (
    <div className="tv-scrim" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="tv-dialog" role="dialog" aria-modal="true" aria-label={title} ref={setEl} data-tv-trap>
        <h2 className="tv-dialog-h">{title}</h2>
        {children}
      </div>
    </div>
  )
}
