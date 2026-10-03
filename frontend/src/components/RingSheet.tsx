// The ring list (Huddle and Watch Party): everyone in the squad, each with their own Ring,
// and Ring everyone at the top. People a ring can't reach (no phone app, no notifications)
// say so, so nobody waits on a call that never arrives.
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from './Icon'
import { useSwipeDown } from '../lib/gestures'
import { ringOne, ringSquad, useRingPeople } from '../lib/ring'
import { initials, tint } from '../lib/watch'

export function RingSheet({ kind, room = '', open, onOpenChange }: {
  kind: 'huddle' | 'watch'; room?: string; open: boolean; onOpenChange: (v: boolean) => void
}) {
  const q = useRingPeople(open)
  const swipe = useSwipeDown(() => onOpenChange(false))
  const [busy, setBusy] = useState<string | null>(null)   // 'all' or a person's id
  const [rang, setRang] = useState<Set<string>>(new Set())
  async function all() {
    setBusy('all')
    await ringSquad(kind, room)
    setBusy(null)
    onOpenChange(false)
  }
  async function one(id: string) {
    const p = q.data?.find((x) => x.id === id)
    if (!p) return
    setBusy(id)
    if (await ringOne(kind, p, room)) setRang((r) => new Set(r).add(id))
    setBusy(null)
  }
  const people = q.data ?? []
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="sheet ring-sheet" aria-describedby={undefined}>
          <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">Ring {kind === 'huddle' ? 'into the Huddle' : 'into the Watch Party'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close"><Icon name="close" /></button>
            </Dialog.Close>
          </div>
          <button type="button" className="btn btn-primary ring-all" disabled={busy !== null} onClick={() => void all()}>
            <Icon name="phone" />{busy === 'all' ? 'Ringing…' : 'Ring everyone'}
          </button>
          {q.isPending ? <p className="meta" role="status">Getting the squad…</p>
            : q.isError ? <p className="meta" role="alert">Couldn't load the squad. Ring everyone still works.</p>
            : (
              <ul className="ring-list" aria-label="Ring one person">
                {people.map((p) => (
                  <li key={p.id} className="ring-row" data-reachable={p.reachable}>
                    <span className="ring-face" style={{ background: tint(p.name) }} aria-hidden="true">{initials(p.name)}</span>
                    <span className="ring-who">
                      <span className="ring-name">{p.name}</span>
                      {!p.reachable && <span className="meta ring-note">No phone or notifications set up</span>}
                    </span>
                    <button type="button" className="btn btn-secondary ring-one" disabled={busy !== null || !p.reachable}
                      aria-label={`Ring ${p.name}`} onClick={() => void one(p.id)}>
                      <Icon name="phone" />{busy === p.id ? 'Ringing…' : rang.has(p.id) ? 'Rung' : 'Ring'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
