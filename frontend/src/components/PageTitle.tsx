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
  /**
   * Undefined reserves the line and leaves it blank — use that while loading. Pass null
   * only for a screen that will never have a subtitle, which collapses the space.
   */
  subtitle?: ReactNode | null
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
        {/* The line is always present, even before the data that fills it.
            Rendering it conditionally pushed every section below down by 22px the moment
            the first response landed, which on its own was most of a 0.118 CLS. */}
        {subtitle !== null && (
          <p className="mt-0.5 min-h-[1.36em] text-sm text-[var(--color-fg-muted)]">
            {subtitle ?? '\u00A0'}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {meta}
        {action}
      </div>
    </header>
  )
}
