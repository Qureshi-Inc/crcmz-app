import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ROUTES, routeFor, to } from './routes'
import { useSession } from './session'
import { RouteErrorBoundary } from './ErrorBoundary'
import { Badge, Button, cx } from '@/components/ui'
import { Drawer } from '@/components/ui/overlay'
import { ChatBoard } from '@/features/soundboard/ChatBoard'

/**
 * The application frame: sidebar on desktop, compact bar on mobile.
 *
 * Two things the legacy dashboard did that this deliberately does not:
 *
 *   - It constrained every screen to 760px, which left roughly half of a 1440px
 *     window empty. Width is now a per-screen decision (`--content-width` for most,
 *     `-read` for conversations, `-wide` for media grids).
 *   - It kept the Chat Board permanently expanded at the bottom of every screen,
 *     roughly 350px of it, on top of the Ask AI composer. It is now a launcher plus a
 *     drawer, so it is available everywhere and in the way nowhere.
 */

export function Shell() {
  const location = useLocation()
  const session = useSession()
  const [moreOpen, setMoreOpen] = useState(false)
  const [boardOpen, setBoardOpen] = useState(false)

  const current = routeFor(location.pathname)
  const visible = ROUTES.filter(r => r.placement !== 'hidden' && (!r.adminOnly || session.isAdmin))
  const primary = visible.filter(r => r.placement === 'primary')
  const more = visible.filter(r => r.placement === 'more')

  // Close the transient surfaces on navigation. Leaving a sheet open across a route
  // change is how you end up with a drawer covering a screen the user just asked for.
  useEffect(() => {
    setMoreOpen(false)
  }, [location.pathname])

  // Move focus to the new screen's heading on navigation, and announce it. Without
  // this a keyboard user's focus stays on the nav link and a screen-reader user is
  // never told the page changed — the standard client-routing regression.
  useEffect(() => {
    const main = document.getElementById('app-main')
    if (main) main.focus({ preventScroll: true })
  }, [location.pathname])

  return (
    <div className="min-h-dvh md:flex">
      <a href="#app-main" className="skip-link">
        Skip to content
      </a>

      <Sidebar primary={primary} more={more} onOpenBoard={() => setBoardOpen(true)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileHeader onOpenBoard={() => setBoardOpen(true)} />

        {session.expired && <SessionExpiredBanner onSignIn={session.signIn} />}

        <main
          id="app-main"
          // tabIndex -1 so it can receive focus programmatically without entering the
          // tab order itself.
          tabIndex={-1}
          aria-label={current?.label ?? 'CRCMZ'}
          className={cx(
            'min-w-0 flex-1 outline-none',
            'px-4 pt-4 sm:px-6 lg:px-8',
            // Room for the mobile nav bar and the safe area; on desktop, room for the
            // floating board launcher, which is 48px tall and sits 20px from the bottom.
            // md:pb-10 was not enough and it covered the last row of a long table.
            'pb-[calc(var(--mobile-nav-height)+var(--safe-bottom)+1.5rem)] md:pb-24',
          )}
        >
          <RouteErrorBoundary resetKey={location.pathname} what={current?.label}>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>

      <MobileNav primary={primary} onOpenMore={() => setMoreOpen(true)} />

      {/* More: the rest of the app, spelled out. Never a hidden gesture. */}
      <Drawer
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title="Everything else"
        description="The rest of CRCMZ"
      >
        <nav aria-label="More destinations" className="overflow-y-auto p-3">
          <ul className="flex flex-col gap-1">
            {more.map(r => (
              <li key={r.path}>
                <NavLink
                  to={to(r.path)}
                  className={({ isActive }) =>
                    cx(
                      'flex min-h-[var(--tap-target)] items-center gap-3 rounded-[var(--radius-md)] px-3',
                      'text-base font-semibold',
                      isActive
                        ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent-text)]'
                        : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]',
                    )
                  }
                >
                  <span aria-hidden="true" className="text-lg">
                    {r.icon}
                  </span>
                  <span className="flex-1">{r.label}</span>
                  {r.legacyHandoff && <Badge tone="neutral">Classic</Badge>}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </Drawer>

      {/* The Chat Board, on demand, from anywhere. */}
      <Drawer
        open={boardOpen}
        onOpenChange={setBoardOpen}
        title="Chat Board"
        description="Fire a line at the squad"
      >
        <ChatBoard />
      </Drawer>

      <BoardLauncher onClick={() => setBoardOpen(true)} />
    </div>
  )
}

function Sidebar({
  primary,
  more,
  onOpenBoard,
}: {
  primary: readonly {
    path: string
    label: string
    shortLabel?: string
    icon: string
    legacyHandoff?: boolean
  }[]
  more: readonly {
    path: string
    label: string
    shortLabel?: string
    icon: string
    legacyHandoff?: boolean
  }[]
  onOpenBoard: () => void
}) {
  return (
    <div
      className={cx(
        'hidden shrink-0 md:flex md:flex-col',
        'w-[var(--sidebar-width)] border-r border-[var(--color-border)] bg-[var(--color-surface-1)]',
        'sticky top-0 h-dvh',
      )}
    >
      <div className="flex items-center gap-2.5 px-4 py-4">
        {/* shrink-0 on the mark and min-w-0 + truncate on the text: without them the
            tagline wrapped onto three lines and shoved the logo out of alignment. */}
        <img
          src="/crcmz-logo.png"
          alt=""
          width={34}
          height={34}
          className="size-[34px] shrink-0 rounded-[var(--radius-md)] object-contain"
        />
        <div className="min-w-0">
          <p className="wordmark truncate text-lg leading-tight">CRCMZ</p>
          {/* Not uppercase + wide tracking: at 11px in the ~185px the sidebar leaves,
              that rendered as "YES. WE HAVE O…". */}
          <p className="truncate text-xs text-[var(--color-fg-subtle)]">
            Yes. We have one.
          </p>
        </div>
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SidebarGroup items={primary} />
        <hr className="my-3 border-[var(--color-border)]" />
        <SidebarGroup items={more} />
      </nav>

      <div className="border-t border-[var(--color-border)] p-3">
        <Button variant="secondary" size="md" className="w-full" onClick={onOpenBoard}>
          <span aria-hidden="true">💬</span> Chat Board
        </Button>
      </div>
    </div>
  )
}

function SidebarGroup({
  items,
}: {
  items: readonly {
    path: string
    label: string
    shortLabel?: string
    icon: string
    legacyHandoff?: boolean
  }[]
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map(r => (
        <li key={r.path}>
          <NavLink
            to={to(r.path)}
            // `end` on the index route only, or '/app' would stay active everywhere.
            end={r.path === ''}
            className={({ isActive }) =>
              cx(
                'flex min-h-10 items-center gap-2.5 rounded-[var(--radius-md)] px-3',
                'text-sm font-semibold',
                'transition-colors duration-[var(--dur-fast)]',
                isActive
                  ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent-text)]'
                  : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]',
              )
            }
          >
            <span aria-hidden="true" className="w-5 shrink-0 text-center">
              {r.icon}
            </span>
            {/* shortLabel here: "Watch Party" plus the classic tag does not fit 244px and
                truncated to "Watch Pa…". The full name is still the accessible name. */}
            <span className="min-w-0 flex-1 truncate">{r.shortLabel ?? r.label}</span>
            {r.legacyHandoff && (
              <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] px-1.5 py-px text-2xs font-semibold text-[var(--color-fg-subtle)]">
                classic
              </span>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  )
}

function MobileHeader({ onOpenBoard }: { onOpenBoard: () => void }) {
  return (
    <header
      className={cx(
        'sticky top-0 z-30 flex items-center gap-3 md:hidden',
        'border-b border-[var(--color-border)] bg-[var(--color-surface-base)]/92 backdrop-blur',
        'px-4 pb-2.5 pt-[calc(var(--safe-top)+0.625rem)]',
      )}
    >
      <img src="/crcmz-logo.png" alt="" width={28} height={28} className="rounded-[var(--radius-sm)]" />
      <p className="wordmark flex-1 text-base">CRCMZ</p>
      <button
        type="button"
        onClick={onOpenBoard}
        aria-label="Open the Chat Board"
        className="grid size-10 place-items-center rounded-[var(--radius-md)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)]"
      >
        <span aria-hidden="true">💬</span>
      </button>
    </header>
  )
}

function MobileNav({
  primary,
  onOpenMore,
}: {
  primary: readonly { path: string; label: string; shortLabel?: string; icon: string }[]
  onOpenMore: () => void
}) {
  return (
    <nav
      aria-label="Main"
      className={cx(
        'fixed inset-x-0 bottom-0 z-40 md:hidden',
        'border-t border-[var(--color-border)] bg-[var(--color-surface-1)]/97 backdrop-blur',
        'pb-[var(--safe-bottom)]',
      )}
    >
      <ul className="flex">
        {primary.map(r => (
          <li key={r.path} className="flex-1">
            <NavLink
              to={to(r.path)}
              end={r.path === ''}
              className={({ isActive }) =>
                cx(
                  'flex h-[var(--mobile-nav-height)] flex-col items-center justify-center gap-0.5',
                  'text-2xs font-semibold',
                  isActive ? 'text-[var(--color-accent-text)]' : 'text-[var(--color-fg-subtle)]',
                )
              }
            >
              <span aria-hidden="true" className="text-lg leading-none">
                {r.icon}
              </span>
              <span>{r.shortLabel ?? r.label}</span>
            </NavLink>
          </li>
        ))}
        <li className="flex-1">
          <button
            type="button"
            onClick={onOpenMore}
            className={cx(
              'flex h-[var(--mobile-nav-height)] w-full flex-col items-center justify-center gap-0.5',
              'text-2xs font-semibold text-[var(--color-fg-subtle)]',
            )}
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ⋯
            </span>
            <span>More</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

/**
 * Desktop-only floating launcher for the board. On mobile the header button does the
 * job, and a floating button there would sit on top of the nav bar.
 */
function BoardLauncher({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'fixed bottom-5 right-5 z-30 hidden md:inline-flex',
        'min-h-12 items-center gap-2 rounded-[var(--radius-full)] px-5',
        'bg-[var(--color-accent)] text-[var(--color-accent-fg)] font-semibold',
        'shadow-[var(--shadow-lg)] hover:bg-[var(--color-accent-hover)]',
      )}
    >
      <span aria-hidden="true">💬</span> Chat Board
    </button>
  )
}

function SessionExpiredBanner({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8',
        'border-b border-[var(--color-warn)]/40 bg-[var(--color-warn)]/12',
        'text-sm text-[var(--color-warn-text)]',
      )}
    >
      <span>Your session expired. Anything you typed is still here — sign in to send it.</span>
      <Button variant="secondary" size="sm" onClick={onSignIn}>
        Sign in
      </Button>
    </div>
  )
}
