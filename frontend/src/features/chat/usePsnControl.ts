// One control on the `psn_send` limiter (a tile, Rally ▶, Squad Up, composer Send),
// wired to the F-0 outcome model. See lib/send.ts for the rules.
import {
  notSentToast, psnCooldown, psnSend, slowToast, UNKNOWN_TOAST,
  useCooldown, usePsnInFlight, useTransient, type SendOutcome, type SendState,
} from '../../lib/send'
import { announce, toast } from '../../components/toast'

export type PsnControl = {
  /** What the control shows right now. */
  state: SendState
  /** Seconds left on the shared cooldown (0 when none). */
  cooldown: number
  /** True while any PSN send is in flight or the cooldown runs: taps are ignored. */
  locked: boolean
  busy: boolean
  fire: (url: string, body: unknown, opts?: { sentMs?: number; sentAnnouncement?: string }) => Promise<SendOutcome | null>
}

export function usePsnControl(id: string): PsnControl {
  const cooldown = useCooldown(psnCooldown)
  const flying = usePsnInFlight()
  const [last, setLast] = useTransient<SendState>('idle', 2500)
  const busy = flying === id

  async function fire(url: string, body: unknown, opts: { sentMs?: number; sentAnnouncement?: string } = {}) {
    const out = await psnSend(id, url, body)
    if (!out) return null // another send in flight, or cooling down: the tap is ignored
    switch (out.kind) {
      case 'sent':
        setLast('sent', opts.sentMs ?? 1600)
        announce(opts.sentAnnouncement ?? 'Sent')
        break
      case 'notsent':
        setLast('notsent', 4000)
        toast(notSentToast(out.status, out.reason), 'error')
        break
      case 'slow':
        setLast('idle')
        toast(slowToast(out.seconds), 'warning')
        break
      case 'unknown':
        setLast('unknown', 6000)
        toast(UNKNOWN_TOAST, 'warning')
        break
    }
    return out
  }

  const state: SendState = busy ? 'sending' : cooldown > 0 ? 'countdown' : last
  return { state, cooldown, locked: flying !== null || cooldown > 0, busy, fire }
}
