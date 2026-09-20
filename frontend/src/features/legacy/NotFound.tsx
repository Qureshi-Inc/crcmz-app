import { Link, useLocation } from 'react-router-dom'
import { ROUTES, to } from '@/app/routes'
import { Card } from '@/components/ui'
import { PageTitle } from '@/components/PageTitle'

/**
 * An unknown /app path.
 *
 * Useful rather than decorative: it says which address failed and lists where the user
 * could have meant to go, because the most common reason to land here is a stale
 * bookmark from the old ?p= scheme that pathForLegacy did not recognise.
 */
export function NotFound() {
  const location = useLocation()
  return (
    <div className="mx-auto w-full max-w-[var(--content-width-read)]">
      <PageTitle title="Not found" />
      <Card className="px-5 py-6">
        <p className="text-sm text-[var(--color-fg-muted)]">
          There is nothing at{' '}
          <code className="font-[family-name:var(--font-mono)] text-[var(--color-fg)]">
            /app{location.pathname}
          </code>
          .
        </p>
        <h2 className="mt-5 text-base font-bold">Try one of these</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {ROUTES.filter(r => r.placement !== 'hidden' && !r.adminOnly).map(r => (
            <li key={r.path}>
              <Link
                to={to(r.path)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 text-sm font-semibold hover:bg-[var(--color-surface-3)]"
              >
                <span aria-hidden="true">{r.icon}</span> {r.label}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
