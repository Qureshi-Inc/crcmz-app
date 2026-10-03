import { Component, lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../lib/http'
import { Shell } from './Shell'
import { SquadPage } from '../features/squad/SquadPage'
import { ClipsPage } from '../features/clips/ClipsPage'
import { StudioPage } from '../features/clips/Studio'
import { SlapPage } from '../features/slap/SlapPage'
import { SettingsPage } from '../features/settings/SettingsPage'
import { PortalPage } from '../features/portal/PortalPage'
import { AdminPage } from '../features/admin/AdminPage'
import { Handoff, NotFound } from '../features/handoff/Handoff'
import { HuddlePage } from '../features/huddle/HuddlePage'
import { NoteViewPage, NotesListPage } from '../features/huddle/NotesPage'
import { SharePage } from '../features/share/SharePage'
import { WhatsAppPage } from '../features/whatsapp/WhatsAppPage'
import { CoachPage } from '../features/coach/CoachPage'
import { GiveawayPage } from '../features/giveaway/GiveawayPage'
import { HelpPage } from '../features/help/HelpPage'
import { GetAppPage } from '../features/getapp/GetAppPage'
import { MoviesHome } from '../features/watch/MoviesHome'
import { NotificationsPage } from '../features/notifications/NotificationsPage'

// assistant-ui and the markdown renderer are ~140 kB gzipped, so only Ask AI pays for them.
const AskPage = lazy(() => import('../features/ask/AskPage').then((m) => ({ default: m.AskPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polls pause while the tab is hidden and fetch at once on return (PS state "stale").
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      // A 4xx will not change on retry; a transient 5xx or network blip might.
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
      staleTime: 10_000,
    },
  },
})

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename="/app">
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<SquadPage />} />
              <Route path="squad" element={<SquadPage />} />
              <Route path="clips" element={<ClipsPage />} />
              <Route path="clips/:id/edit" element={<StudioPage />} />
              <Route path="clips/*" element={<Handoff id="clips" />} />
              <Route path="slap" element={<SlapPage />} />
              <Route path="whatsapp" element={<WhatsAppPage />} />
              <Route path="giveaway" element={<GiveawayPage />} />
              <Route path="watch" element={<MoviesHome />} />
              {/* The Shell renders the party itself, so it can stay mounted across routes. */}
              <Route path="watch/party" element={null} />
              <Route path="huddle" element={<HuddlePage />} />
              <Route path="huddle/notes" element={<NotesListPage />} />
              <Route path="huddle/notes/:id" element={<NoteViewPage />} />
              <Route path="share" element={<SharePage />} />
              <Route path="coach" element={<CoachPage />} />
              <Route path="ask" element={<Suspense fallback={null}><AskPage /></Suspense>} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/:tab" element={<SettingsPage />} />
              <Route path="help" element={<HelpPage />} />
              <Route path="get-app" element={<GetAppPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="admin" element={<AdminPage />} />
              <Route path="portal" element={<PortalPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

/** Last resort: a render crash shows a way out instead of a blank screen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="app-main" style={{ paddingTop: 'var(--space-10)' }}>
        <section className="glass handoff" role="alert">
          <h1 className="page-h1">Something broke</h1>
          <p>This screen hit an error. Reload, or use the classic app.</p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
            <a className="btn btn-secondary" href="/">Open the classic app</a>
          </div>
        </section>
      </main>
    )
  }
}
