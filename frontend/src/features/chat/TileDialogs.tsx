// CB-05 add a tile · CB-06 remove a tile. Centred dialogs with a scrim and a focus trap.
import { useEffect, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import type { Tile } from '../../lib/api'
import { request } from '../../lib/http'
import { Cooldown, psnCooldown, sendOnce, UNKNOWN_INLINE, useCooldown } from '../../lib/send'
import { announce, toast } from '../../components/toast'
import type { BoardId } from './ChatBoard'

/** `custom_add` (6 / 60 s) is its own bucket; its countdown sits on Save only. */
const addCooldown = new Cooldown()
const MAX = 200
// Flavouring runs through the model before the reply, so allow longer than a plain send.
const ADD_TIMEOUT_MS = 45_000

function addError(status: number, detail: string): string {
  const d = detail.toLowerCase()
  if (status === 401) return 'Sign in to build it.'
  if (d.includes('empty')) return 'It needs something to say.'
  if (d.includes('too long')) return 'Keep it under 200 characters.'
  if (d.includes('full')) return "The board's full — remove one first."
  if (status === 503) return "The PSN group isn't reachable right now."
  return detail ? `Didn't go. ${detail}` : "Didn't go."
}

export function AddTileDialog({
  board, open, onOpenChange, onSent,
}: { board: BoardId; open: boolean; onOpenChange: (v: boolean) => void; onSent: (text: string) => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [sendNow, setSendNow] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unknown, setUnknown] = useState<string | null>(null)
  const wait = useCooldown(addCooldown)
  const psnWait = useCooldown(psnCooldown)

  useEffect(() => { if (open) { setError(null) } }, [open])

  const trimmed = text.trim()
  const again = unknown !== null && unknown === trimmed
  const blockedByPsn = sendNow && psnWait > 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || wait > 0 || blockedByPsn) return
    if (!trimmed) { setError('It needs something to say.'); return }
    if (trimmed.length > MAX) { setError('Keep it under 200 characters.'); return }
    setBusy(true)
    setError(null)
    const url = board === 'mine' ? '/api/soundboard/personal' : '/api/soundboard'
    // `send:false` only saves the tile; `send:true` also posts it to the group (not idempotent → F-0).
    const out = await sendOnce(url, { text: trimmed, send: sendNow }, ADD_TIMEOUT_MS)
    setBusy(false)
    if (out.kind === 'sent') {
      const d = out.data as { flavored?: string; sent?: boolean; button?: Tile }
      await qc.invalidateQueries({ queryKey: ['board', board] })
      setText('')
      setUnknown(null)
      onOpenChange(false)
      if (sendNow && d.sent) {
        toast('Added and sent.', 'success')
        announce(`Sent: ${d.flavored ?? trimmed}`)
        onSent(d.flavored ?? trimmed)
      } else if (sendNow) {
        toast("Added. The send didn't go — fire the tile to try again.", 'warning')
      } else {
        toast(`Added: ${d.button?.label ?? trimmed}`, 'success')
      }
    } else if (out.kind === 'slow') {
      addCooldown.start(out.seconds)
      if (sendNow) psnCooldown.start(out.seconds)
    } else if (out.kind === 'notsent') {
      setError(addError(out.status, out.reason))
    } else {
      // The tile may be saved and the message may have gone. Show the board as it is now.
      setUnknown(trimmed)
      await qc.invalidateQueries({ queryKey: ['board', board] })
    }
  }

  let save = 'Add tile'
  if (busy) save = '✨ AI is cooking…'
  else if (wait > 0) save = `Wait ${wait}s`
  else if (blockedByPsn) save = `Wait ${psnWait}s`
  else if (again) save = 'Add again anyway'

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="add-tile-desc">
          <Dialog.Title className="dialog-title">New tile</Dialog.Title>
          <p id="add-tile-desc" className="dim" style={{ marginTop: 0 }}>
            {board === 'mine' ? 'Adds to your board. It still fires into the group.' : 'Adds to the shared board for everyone.'} The AI adds the flavor.
          </p>
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="tile-text">What does it say?</label>
            <textarea
              id="tile-text"
              className="input"
              maxLength={MAX}
              value={text}
              onChange={(e) => { setText(e.target.value); setError(null) }}
              aria-describedby="tile-count"
            />
            <p id="tile-count" className="meta" style={{ margin: 'var(--space-1) 0 0', textAlign: 'right' }}>{text.length} / {MAX}</p>
            <label className="check-row">
              <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
              Also send it now
            </label>
            <div aria-live="polite">
              {error && <p className="composer-msg" data-tone="error">{error}</p>}
              {again && <p className="composer-msg" data-tone="unknown">{UNKNOWN_INLINE} Check the board too.</p>}
            </div>
            <div className="dialog-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-secondary" aria-disabled={busy || undefined}>Cancel</button>
              </Dialog.Close>
              <button type="submit" className="btn btn-primary" aria-busy={busy || undefined} aria-disabled={busy || wait > 0 || blockedByPsn || undefined}>
                {save}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function RemoveTileDialog({ board, tile, onClose }: { board: BoardId; tile: Tile | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Keep the last tile while the dialog animates closed.
  const [shown, setShown] = useState<Tile | null>(tile)
  useEffect(() => { if (tile) { setShown(tile); setError(null) } }, [tile])

  async function remove() {
    if (!shown || busy) return
    setBusy(true)
    try {
      // The server matches on the exact message text (`msg`), not the label.
      await request(board === 'mine' ? '/api/soundboard/personal/delete' : '/api/soundboard/delete', { body: { text: shown.msg } })
      await qc.invalidateQueries({ queryKey: ['board', board] })
      toast(`Removed ${shown.label}.`, 'success')
      onClose()
    } catch {
      setError('It was not removed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const label = shown?.label ?? ''
  return (
    <Dialog.Root open={tile !== null} onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" role="alertdialog" aria-describedby="remove-desc">
          <Dialog.Title className="dialog-title">Remove tile?</Dialog.Title>
          <p id="remove-desc" style={{ margin: 0 }}>
            {board === 'shared' ? `Remove '${label}'? It's gone from the shared board. Everyone loses it.` : `Remove '${label}' from your board?`}
          </p>
          {error && <p className="composer-msg" data-tone="error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">Cancel</button>
            </Dialog.Close>
            <button type="button" className="btn btn-primary" onClick={remove} aria-busy={busy || undefined}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
