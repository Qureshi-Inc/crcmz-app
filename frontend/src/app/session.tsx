import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api/http'

/**
 * Who is signed in, and what happens when that stops being true.
 *
 * The backend has no "give me the current session" endpoint, and adding one is not
 * needed: /api/admin/check is already a cheap authenticated GET that 401s for a
 * signed-out browser, and its answer (is this person an admin) is the other thing the
 * shell needs to know. So it doubles as the bootstrap probe. If a dedicated
 * /api/session endpoint is added later this is the only place that has to change.
 */

export interface Session {
  signedIn: boolean
  isAdmin: boolean
  /** PSN online id, when the account has one linked. */
  psnId: string | null
}

interface SessionState extends Session {
  loading: boolean
  /** Set once a request has come back 401, until the user signs in again. */
  expired: boolean
  /** Send the browser to sign-in, returning to where it is now. */
  signIn: () => void
  /** Record that a request was rejected as unauthenticated. */
  noteExpired: () => void
}

const Ctx = createContext<SessionState | null>(null)

interface AdminCheck {
  is_admin?: boolean
  psn_id?: string | null
}

/**
 * Build the /auth/login?next=… URL.
 *
 * `next` is validated on the server side too, but keep it a path here so a crafted
 * link can never turn this into an open redirect: no scheme, no host, and no
 * protocol-relative "//evil.example" form.
 */
export function loginUrl(next: string): string {
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/app'
  return `/auth/login?next=${encodeURIComponent(safe)}`
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ loading: boolean; session: Session; expired: boolean }>({
    loading: true,
    session: { signedIn: false, isAdmin: false, psnId: null },
    expired: false,
  })
  const queryClient = useQueryClient()

  useEffect(() => {
    const controller = new AbortController()
    api
      .get<AdminCheck>('/api/admin/check', { signal: controller.signal, timeoutMs: 8_000 })
      .then(data => {
        setState({
          loading: false,
          session: {
            signedIn: true,
            isAdmin: Boolean(data?.is_admin),
            psnId: typeof data?.psn_id === 'string' && data.psn_id ? data.psn_id : null,
          },
          expired: false,
        })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // A 401 on the bootstrap probe is the ordinary signed-out case. Anything else
        // (the app is down, the probe timed out) also leaves us not signed in, and the
        // screens themselves will report why when their own reads fail. Either way
        // this is not "your session expired" — there was no session to expire, so
        // showing that banner on a first visit would be a lie.
        setState({
          loading: false,
          session: { signedIn: false, isAdmin: false, psnId: null },
          expired: false,
        })
      })
    return () => controller.abort()
  }, [])

  const signIn = useCallback(() => {
    window.location.assign(loginUrl(window.location.pathname + window.location.search))
  }, [])

  const noteExpired = useCallback(() => {
    setState(prev => {
      if (prev.expired) return prev
      // Drop the previous user's cached reads. Keeping them would let a signed-out
      // browser (or the next account) read the last person's private data off screen.
      queryClient.clear()
      return { ...prev, expired: true, session: { signedIn: false, isAdmin: false, psnId: null } }
    })
  }, [queryClient])

  const value = useMemo<SessionState>(
    () => ({ ...state.session, loading: state.loading, expired: state.expired, signIn, noteExpired }),
    [state, signIn, noteExpired],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}
