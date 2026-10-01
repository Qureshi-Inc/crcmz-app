// A detail surface for one clip or reel: a bottom sheet on a phone, a centred
// dialog (max 760 px) at ≥ 1024 px (PS-2 desktop reflow).
import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../../components/Icon'
import { useDesktop } from '../../lib/media'

export function ClipSheet({
  open, onOpenChange, title, children,
}: { open: boolean; onOpenChange: (v: boolean) => void; title: string; children: ReactNode }) {
  const desktop = useDesktop()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className={desktop ? 'dialog dialog-wide' : 'sheet sheet-clip'} aria-describedby={undefined}>
          {!desktop && <div className="sheet-knob-row" aria-hidden="true"><span className="sheet-knob" /></div>}
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title clip-sheet-title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="icon-btn" aria-label="Close"><Icon name="close" /></button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The confirm step for an action that cannot be taken back quietly. */
export function ConfirmDialog({
  open, onOpenChange, title, body, action, onConfirm, container,
}: { open: boolean; onOpenChange: (v: boolean) => void; title: string; body: ReactNode; action: string; onConfirm: () => void; container?: HTMLElement }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Overlay className="scrim scrim-top" />
        <Dialog.Content className="dialog dialog-confirm" role="alertdialog" aria-describedby="confirm-desc">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <div id="confirm-desc">{body}</div>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">Cancel</button>
            </Dialog.Close>
            <button type="button" className="btn btn-primary" onClick={() => { onOpenChange(false); onConfirm() }}>{action}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
