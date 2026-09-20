import { lazy, Suspense, useEffect } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from './queryClient'
import { SessionProvider, useSession } from './session'
import { APP_BASE, pathForLegacy } from './routes'
import { Shell } from './Shell'
import { HomePage } from '@/features/home/HomePage'
import { LegacyHandoff } from '@/features/legacy/LegacyHandoff'
import { NotFound } from '@/features/legacy/NotFound'
import { SkeletonRows } from '@/components/ui/states'

/**
 * Routing.
 *
 * `basename` is /app, so every `to('clips')` is /app/clips and the backend only has to
 * serve the SPA document under one prefix — which is what keeps the existing /clips API
 * route, /portal, /watch and the rest reachable and unchanged.
 *
 * Heavy screens are lazy so the first paint of Home does not pay for the WhatsApp
 * analytics bundle. Home itself is eager: it is the landing route and a chunk request
 * before first paint would be a visible delay for the common case.
 */

const ClipsPage = lazy(() => import('@/features/clips/ClipsPage').then(m => ({ default: m.ClipsPage })))
const MusicPage = lazy(() => import('@/features/music/MusicPage').then(m => ({ default: m.MusicPage })))
const WhatsAppPage = lazy(() => import('@/features/whatsapp/WhatsAppPage').then(m => ({ default: m.WhatsAppPage })))
const GiveawaysPage = lazy(() => import('@/features/giveaways/GiveawaysPage').then(m => ({ default: m.GiveawaysPage })))
const AiPage = lazy(() => import('@/features/ai/AiPage').then(m => ({ default: m.AiPage })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
const AdminPage = lazy(() => import('@/features/admin/AdminPage').then(m => ({ default: m.AdminPage })))

const queryClient = createQueryClient()

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={APP_BASE}>
        <SessionProvider>
          <LegacyLinkCompat />
          <ScrollRestoration />
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<HomePage />} />
              <Route path="clips" element={<Lazy name="Clips"><ClipsPage /></Lazy>} />
              <Route path="music" element={<Lazy name="Music"><MusicPage /></Lazy>} />
              <Route path="community/whatsapp" element={<Lazy name="WhatsApp"><WhatsAppPage /></Lazy>} />
              <Route path="community/giveaways" element={<Lazy name="Giveaways"><GiveawaysPage /></Lazy>} />
              <Route path="ai" element={<Lazy name="Ask AI"><AiPage /></Lazy>} />
              <Route path="settings" element={<Lazy name="Settings"><SettingsPage /></Lazy>} />
              <Route path="admin" element={<AdminRoute />} />
              {/* Watch and Huddle are not migrated. These are honest handovers to the
                  still-served dashboard, not stubs pretending to be the feature. */}
              <Route path="watch" element={<LegacyHandoff feature="watch" />} />
              <Route path="huddle" element={<LegacyHandoff feature="huddle" />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

function Lazy({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-[var(--content-width)]" aria-busy="true" role="status">
          <span className="sr-only">Loading {name}</span>
          <div className="skeleton mb-5 h-9 w-48" />
          <SkeletonRows rows={4} />
        </div>
      }
    >
      {children}
    </Suspense>
  )
}

/**
 * Admin is gated in the UI for discoverability, not for security: the server checks
 * every admin endpoint itself, and this component being bypassed would reveal an empty
 * screen rather than anyone else's data.
 */
function AdminRoute() {
  const session = useSession()
  if (session.loading) return <SkeletonRows rows={3} />
  // Router-relative: "/app" here would resolve to /app/app.
  if (!session.isAdmin) return <Navigate to="/" replace />
  return (
    <Lazy name="Admin">
      <AdminPage />
    </Lazy>
  )
}

/**
 * Old links keep working.
 *
 * `/app?p=slap` (or a bookmark that kept the legacy query) and `/app#watch` both resolve
 * to the new path. A fragment never reaches the server, so this has to happen on the
 * client. Unknown values are ignored rather than guessed — pathForLegacy is an
 * allowlist, so a crafted ?p= cannot steer navigation.
 */
function LegacyLinkCompat() {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const legacy = params.get('p') ?? (location.hash ? location.hash.replace(/^#/, '') : null)
    if (!legacy) return
    const target = pathForLegacy(legacy)
    if (!target) return
    // replace, not push: the old-style URL should not sit in history as a place Back
    // returns to, or Back would bounce the user straight forward again.
    navigate(target, { replace: true })
  }, [location.search, location.hash, navigate])

  return null
}

/**
 * Scroll behaviour on navigation.
 *
 * A new screen starts at the top; Back and Forward restore where the user was. React
 * Router does neither on its own, so without this every Back lands at the top of a long
 * analytics page and every forward navigation inherits the previous page's offset.
 *
 * The navigation *type* is the part that matters, and it has to come from the router —
 * performance.getEntriesByType('navigation') only ever describes the initial document
 * load, so it reports "navigate" forever and Back would always be scrolled to the top.
 */
function ScrollRestoration() {
  const location = useLocation()
  const navType = useNavigationType()

  // location.key is stable per history entry, which makes it the right place to hang a
  // remembered offset. sessionStorage rather than a module-level Map so a full reload
  // in the middle of a session does not lose every position.
  useEffect(() => {
    const key = `crcmz:scroll:${location.key}`
    const save = () => sessionStorage.setItem(key, String(window.scrollY))
    // pagehide rather than beforeunload: it fires on mobile Safari when the page is
    // backgrounded, which beforeunload does not.
    window.addEventListener('pagehide', save)
    return () => {
      save()
      window.removeEventListener('pagehide', save)
    }
  }, [location.key])

  useEffect(() => {
    if (navType === 'POP') {
      const saved = sessionStorage.getItem(`crcmz:scroll:${location.key}`)
      const y = saved === null ? 0 : Number.parseInt(saved, 10)
      window.scrollTo(0, Number.isFinite(y) ? y : 0)
      return
    }
    window.scrollTo(0, 0)
  }, [location.key, navType])

  return null
}
