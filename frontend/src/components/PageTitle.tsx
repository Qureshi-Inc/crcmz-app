import { useEffect } from 'react'
import type { ReactNode } from 'react'

/**
 * The one h1 on a screen, plus the document title.
 *
 * Both matter for the same reason: after a client-side navigation the browser does not
 * change either, so without this every screen in the app is called "CRCMZ" in the tab,
 * the history entry and the screen-reader's page announcement.
 */
export function PageTitle({
  title,
  subtitle,
  meta,
  action,
}: {
  title: string
  subtitle?: ReactNode
  /** Small right-aligned text, e.g. data freshness. */
  meta?: ReactNode
  action?: ReactNode
}) {
  useEffect(() => {
    document.title = `${title} · CRCMZ`
  }, [title])

  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">{subtitle}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {meta}
        {action}
      </div>
    </header>
  )
}
