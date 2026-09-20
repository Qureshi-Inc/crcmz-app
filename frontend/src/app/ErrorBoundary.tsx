import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui'

/**
 * Stops one broken screen from blanking the whole application.
 *
 * Scoped per route rather than wrapped once around the shell, so a crash in Clips
 * leaves the nav, the session and any live media session alone — which is the point:
 * a rendering bug must not tear down a call.
 */
interface Props {
  children: ReactNode
  /** Changing this resets the boundary — pass the route key. */
  resetKey?: string
  /** What crashed, for the message. */
  what?: string
}

interface State {
  error: Error | null
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  private lastResetKey = this.props.resetKey

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate() {
    // Navigating away from a crashed route clears it, so the user is not stuck with
    // an error screen after they have already moved on.
    if (this.props.resetKey !== this.lastResetKey) {
      this.lastResetKey = this.props.resetKey
      if (this.state.error) this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Deliberately console, not a telemetry service: there is no error-reporting
    // backend here yet, and adding one is a separate decision. The component stack is
    // the part that is actually useful and it is not in error.stack.
    console.error('[crcmz] route crashed', error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-5 py-14 text-center">
        <p className="text-xl font-bold">
          {this.props.what ? `${this.props.what} stopped working` : 'This screen stopped working'}
        </p>
        <p className="max-w-[54ch] text-sm text-[var(--color-fg-muted)]">
          Something in the page hit an error, so it has been unloaded rather than left
          half-drawn. The rest of the app still works.
        </p>
        <p className="max-w-[54ch] font-[family-name:var(--font-mono)] text-xs text-[var(--color-fg-subtle)]">
          {error.message}
        </p>
        <div className="mt-2 flex gap-2">
          <Button variant="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            Reload the app
          </Button>
        </div>
      </div>
    )
  }
}
