/**
 * The route table. One list, so navigation, the "More" sheet, the legacy ?p= mapping
 * and the not-found allowlist can never disagree with each other — which is exactly
 * how ?p=huddle ended up deep-linkable to an empty panel in the old dashboard.
 */

export interface RouteDef {
  /** Path under /app. '' is the index. */
  path: string
  label: string
  /** Shown in the nav; short enough for a 390px mobile bar. */
  shortLabel?: string
  icon: string
  /** Where it appears. 'primary' is the mobile bar; 'more' is behind More. */
  placement: 'primary' | 'more' | 'hidden'
  /** Only rendered for an admin. The server remains the authority. */
  adminOnly?: boolean
  /** The legacy ?p= value this replaces, for redirecting old links. */
  legacyP?: string
  /**
   * True when the screen is a handover to the legacy implementation rather than a
   * migrated screen. Used by the parity docs and by the nav, which marks them.
   */
  legacyHandoff?: boolean
}

export const ROUTES: readonly RouteDef[] = [
  { path: '', label: 'Home', icon: '🎮', placement: 'primary', legacyP: 'squad' },
  { path: 'watch', label: 'Watch Party', shortLabel: 'Watch', icon: '🍿', placement: 'primary', legacyP: 'watch', legacyHandoff: true },
  { path: 'clips', label: 'Clips', icon: '🎬', placement: 'primary', legacyP: 'pipeline' },
  { path: 'huddle', label: 'Huddle', icon: '🎥', placement: 'more', legacyP: 'huddle', legacyHandoff: true },
  { path: 'music', label: 'Music', icon: '🎵', placement: 'more', legacyP: 'slap' },
  { path: 'community/whatsapp', label: 'WhatsApp', icon: '💬', placement: 'more', legacyP: 'wa' },
  { path: 'community/giveaways', label: 'Giveaways', icon: '🎁', placement: 'more', legacyP: 'giveaway' },
  { path: 'ai', label: 'Ask AI', icon: '🤖', placement: 'more', legacyP: 'ai' },
  { path: 'settings', label: 'Settings', icon: '⚙️', placement: 'more' },
  { path: 'admin', label: 'Admin', icon: '🛠', placement: 'more', adminOnly: true },
] as const

/** Where the router is mounted. Used for URLs built *outside* the router. */
export const APP_BASE = '/app'

/**
 * A route location for `<Link to>` / `navigate()`.
 *
 * Router-relative, NOT absolute. `<BrowserRouter basename="/app">` prepends the base
 * itself, so returning "/app/clips" here produced href="/app/app/clips" on every single
 * navigation link — the screens still worked on direct entry, which is exactly why it
 * was easy to miss.
 */
export function to(path: string): string {
  return path ? `/${path}` : '/'
}

/** The full URL for a route, for anything outside the router (an <a href>, a redirect). */
export function appUrl(path: string): string {
  return path ? `${APP_BASE}/${path}` : APP_BASE
}

/**
 * Legacy ?p= value → a router location. Used by the compatibility redirect.
 *
 * Unknown values are not guessed: they return null and the caller decides what to do. An
 * allowlist, in other words, which is what keeps a crafted ?p= out of the routing
 * decision.
 */
const BY_LEGACY = new Map(
  ROUTES.filter(r => r.legacyP).map(r => [r.legacyP as string, r.path]),
)

export function pathForLegacy(p: string | null | undefined): string | null {
  if (!p) return null
  const found = BY_LEGACY.get(p)
  return found === undefined ? null : to(found)
}

/**
 * Which route a pathname belongs to.
 *
 * `pathname` is what useLocation() reports, which the router has already stripped of the
 * basename — so it is "/clips", not "/app/clips". Stripping "/app" again here silently
 * matched nothing, leaving the main landmark unlabelled and the error boundary unable to
 * name what crashed.
 */
export function routeFor(pathname: string): RouteDef | undefined {
  const rel = pathname.replace(/^\//, '').replace(/\/$/, '')
  // Longest path first, so 'community/whatsapp' wins over the '' index.
  return [...ROUTES].sort((a, b) => b.path.length - a.path.length).find(r => r.path === rel)
}
