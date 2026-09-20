import * as Dialog from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { cx } from './index'

/**
 * Dialogs and drawers.
 *
 * Built on Radix rather than hand-rolled, because the requirement list — trap focus,
 * restore it to the trigger on close, Escape, aria-modal, make the background inert,
 * label the dialog, hide it from the accessibility tree while closed — is a list of
 * things that are individually easy and collectively never finished correctly by hand.
 * The legacy settings modal is a plain div with a click handler and none of it.
 *
 * `title` is not optional. A dialog without an accessible name is what Radix warns
 * about at runtime, and the type makes it impossible instead.
 */

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  width?: 'sm' | 'md' | 'lg'
}) {
  const max = { sm: 'max-w-[420px]', md: 'max-w-[560px]', lg: 'max-w-[800px]' }[width]
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            // dvh + the safe areas, so a dialog on a phone is never taller than the
            // visible viewport and its footer never lands under the home indicator.
            'max-h-[calc(100dvh-2rem-var(--safe-top)-var(--safe-bottom))]',
            'flex flex-col overflow-hidden rounded-[var(--radius-xl)]',
            'border border-[var(--color-border-strong)] bg-[var(--color-surface-1)]',
            'shadow-[var(--shadow-lg)]',
            max,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
            <div>
              <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-sm text-[var(--color-fg-muted)]">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className={cx(
                'grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)]',
                'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]',
              )}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3.5">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * A panel that slides up from the bottom (phone) or in from the right (desktop).
 *
 * This is what the Chat Board becomes. It used to be a permanently expanded block
 * eating ~350px at the bottom of every screen, including the ones where it made no
 * sense, and it sat on top of the Ask AI composer.
 *
 * The height is capped with dvh minus the safe inset and minus the mobile nav, which
 * is the whole reason a composer inside it stays reachable when the software keyboard
 * is up: the panel shrinks rather than the content sliding under the keyboard.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className={cx(
            'fixed z-50 flex flex-col overflow-hidden bg-[var(--color-surface-1)]',
            'shadow-[var(--shadow-lg)]',
            // Phone: bottom sheet.
            'inset-x-0 bottom-0 max-h-[82dvh] rounded-t-[var(--radius-xl)]',
            'border-t border-[var(--color-border-strong)]',
            // Desktop: right-hand panel, full height.
            'md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[420px]',
            'md:rounded-none md:rounded-l-[var(--radius-xl)] md:border-l md:border-t-0',
            'pb-[var(--safe-bottom)]',
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <Dialog.Title className="text-base font-bold">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="text-xs text-[var(--color-fg-subtle)]">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className={cx(
                'grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)]',
                'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]',
              )}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Confirmation for something that cannot be undone.
 *
 * `confirmLabel` says what will happen ("Draw the winner"), never "OK" — the label is
 * the last chance to notice you are about to draw a real giveaway.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  destructive = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => void
  pending?: boolean
  destructive?: boolean
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      width="sm"
      footer={
        <>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            className="min-h-10 rounded-[var(--radius-md)] px-4 text-sm font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] disabled:opacity-55"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending || undefined}
            className={cx(
              'min-h-10 rounded-[var(--radius-md)] px-4 text-sm font-semibold disabled:opacity-55',
              destructive
                ? 'border border-[var(--color-danger)]/60 text-[var(--color-danger-text)] hover:bg-[var(--color-danger)]/12'
                : 'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]',
            )}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-[var(--color-fg-muted)]">{body}</div>
    </Modal>
  )
}
