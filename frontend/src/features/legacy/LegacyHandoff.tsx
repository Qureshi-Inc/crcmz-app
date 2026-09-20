import { Card } from '@/components/ui'
import { PageTitle } from '@/components/PageTitle'

/**
 * An honest handover to the still-served dashboard.
 *
 * Watch Party and Huddle are not migrated. Rebuilding them means rebuilding the piece
 * with the most ways to fail — a socket, signed tickets, capture tracks, autoplay
 * policy, reconnection, a mini-player that has to survive navigation — and verifying it
 * needs a real camera, a real microphone and a second participant. None of that was
 * available, and shipping that code unverified would be the single riskiest thing in
 * this migration.
 *
 * So this screen does not pretend. It says the feature lives in the classic interface
 * and sends you there, with a real full-page link: switching documents is a full
 * navigation and will end anything currently connected, which is exactly why it is a
 * deliberate click rather than a redirect.
 */

const FEATURES = {
  watch: {
    title: 'Watch Party',
    what: 'Watch something together, in sync, with chat and cameras.',
    legacy: '/?p=watch',
  },
  huddle: {
    title: 'Huddle',
    what: 'Voice and video with screen share, transcription and AI notes.',
    legacy: '/?p=huddle',
  },
} as const

export function LegacyHandoff({ feature }: { feature: keyof typeof FEATURES }) {
  const f = FEATURES[feature]
  return (
    <div className="mx-auto w-full max-w-[var(--content-width-read)]">
      <PageTitle title={f.title} subtitle={f.what} />
      <Card className="px-5 py-6">
        <h2 className="text-lg font-bold">Still in the classic interface</h2>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">
          {f.title} has not moved to the new interface yet. Everything about it still
          works — it just lives on the classic dashboard, and this link takes you
          straight to it.
        </p>
        <p className="mt-3 text-sm text-[var(--color-warn-text)]">
          This is a full page load, so anything you currently have connected here will
          disconnect.
        </p>
        {/* A plain anchor, not a router Link: the target is a different document. */}
        <a
          href={f.legacy}
          className="mt-5 inline-flex min-h-[var(--tap-target)] items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-5 font-semibold text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          Open {f.title} in the classic interface
        </a>
      </Card>
    </div>
  )
}
