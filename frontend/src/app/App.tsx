import { Component, type ReactNode } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../lib/http'
import { Shell } from './Shell'
import { SquadPage } from '../features/squad/SquadPage'
import { Handoff, NotFound } from '../features/handoff/Handoff'

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
              <Route path="clips/*" element={<Handoff id="clips" />} />
              <Route path="slap" element={<Handoff id="slap" />} />
              <Route path="whatsapp" element={<Handoff id="whatsapp" />} />
              <Route path="giveaway" element={<Handoff id="giveaway" />} />
              <Route path="watch" element={<Handoff id="watch" />} />
              <Route path="huddle" element={<Handoff id="huddle" />} />
              <Route path="coach" element={<Handoff id="coach" />} />
              <Route path="ask" element={<Handoff id="ask" />} />
              <Route path="settings/*" element={<Handoff id="settings" />} />
              <Route path="admin" element={<Handoff id="admin" />} />
              <Route path="portal" element={<Handoff id="portal" />} />
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
