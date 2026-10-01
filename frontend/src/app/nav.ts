// The information architecture (JOURNEY.md §IA): 12 destinations, their routes, the
// nav surfaces each one appears in, and where it still lives in the classic app.
import type { IconName } from '../components/Icon'

export type DestId =
  | 'squad' | 'clips' | 'slap' | 'whatsapp' | 'giveaway' | 'watch' | 'huddle'
  | 'coach' | 'ask' | 'portal' | 'settings' | 'help' | 'admin'

export type Dest = {
  id: DestId
  label: string
  /** Router path, relative to basename /app. */
  path: string
  icon: IconName
  /** Where the capability lives today. Verified against `_DASHBOARD_TMPL` panel ids. */
  classicHref: string
  /** How to reach it in the classic app when the URL alone does not open it. */
  classicHint?: string
  adminOnly?: boolean
  /** Short, in-voice description for the "lives in the classic app" screen. */
  blurb: string
}

export const DESTS: Record<DestId, Dest> = {
  squad: { id: 'squad', label: 'Squad', path: '/', icon: 'squad', classicHref: '/?p=squad', blurb: 'Who is on, and the Chat Board.' },
  clips: { id: 'clips', label: 'Clips', path: '/clips', icon: 'clips', classicHref: '/?p=pipeline', blurb: 'Reels, sending videos and the monthly montage.' },
  slap: { id: 'slap', label: 'Slap', path: '/slap', icon: 'slap', classicHref: '/?p=slap', blurb: "The squad's music: charts, streaks and the throne." },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', path: '/whatsapp', icon: 'chat', classicHref: '/?p=wa', blurb: 'Group stats, awards and the activity heatmap.' },
  giveaway: { id: 'giveaway', label: 'Giveaway', path: '/giveaway', icon: 'giveaway', classicHref: '/?p=giveaway', blurb: 'This round, the countdown and the draw.' },
  watch: { id: 'watch', label: 'Watch', path: '/watch', icon: 'watch', classicHref: '/?p=watch', blurb: 'Watch Party: one screen, the whole squad.' },
  huddle: { id: 'huddle', label: 'Huddle', path: '/huddle', icon: 'huddle', classicHref: '/?p=huddle', blurb: 'Drop into a voice and video call.' },
  coach: { id: 'coach', label: 'AI Coach', path: '/coach', icon: 'coach', classicHref: '/?p=coach', blurb: 'Your match notes and the squad digest.' },
  ask: { id: 'ask', label: 'Ask AI', path: '/ask', icon: 'ask', classicHref: '/?p=ai', blurb: 'Ask anything about the squad.' },
  portal: { id: 'portal', label: 'Link PSN', path: '/portal', icon: 'link', classicHref: '/portal', blurb: 'Link your PlayStation account so you show up on Squad.' },
  settings: {
    id: 'settings', label: 'Settings', path: '/settings', icon: 'settings', classicHref: '/',
    classicHint: 'Open the account menu at the top right, then Settings.',
    blurb: 'Passkeys, password, PSN, Mattermost, MCP and Watch.',
  },
  help: { id: 'help', label: 'Help', path: '/help', icon: 'info', classicHref: '/', blurb: 'How to use each part of the app.' },
  admin: {
    id: 'admin', label: 'Admin', path: '/admin', icon: 'admin', classicHref: '/', adminOnly: true,
    classicHint: 'Open the account menu, then Settings, then Users.',
    blurb: 'Users, PSN accounts and service health.',
  },
}

/** Mobile tab bar (< 1024 px). */
export const TAB_IDS: DestId[] = ['squad', 'watch', 'clips']
/** More sheet groups, research order (JOURNEY.md §IA → Mobile More sheet). */
export const MORE_SQUAD: DestId[] = ['slap', 'whatsapp', 'giveaway', 'huddle', 'coach', 'ask']
export const MORE_ACCOUNT: DestId[] = ['portal', 'settings', 'help', 'admin']
/** Desktop sidebar (≥ 1024 px). */
export const SIDEBAR_MAIN: DestId[] = ['squad', 'clips', 'slap', 'whatsapp', 'giveaway', 'watch', 'huddle', 'coach', 'ask']
export const SIDEBAR_FOOT: DestId[] = ['portal', 'settings', 'help', 'admin']

/** The ⓘ beside a menu item: that item's section on the Help page. */
export function helpHref(id: DestId): string | null {
  return id === 'help' ? null : `/help#${id}`
}

/** Which destination owns an in-app pathname (relative to /app). */
export function destForPath(pathname: string): DestId | null {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/' || p === '/squad') return 'squad'
  for (const d of Object.values(DESTS)) {
    if (d.path !== '/' && (p === d.path || p.startsWith(d.path + '/'))) return d.id
  }
  return null
}

/**
 * Legacy deep links: /app?p=<key>. An allowlist, never an open redirect. Keys are
 * the classic dashboard's panel ids plus `upload` (§IA → Legacy URL map).
 */
const LEGACY_P: Record<string, string> = {
  squad: '/app',
  pipeline: '/app/clips',
  upload: '/app/clips?upload',
  slap: '/app/slap',
  wa: '/app/whatsapp',
  giveaway: '/app/giveaway',
  watch: '/app/watch',
  huddle: '/app/huddle',
  coach: '/app/coach',
  ai: '/app/ask',
}

/** Rewrite /app?p=<key> in place, before the router reads the URL. Unknown keys go to /app. */
export function applyLegacyDeepLink() {
  const { pathname, search, hash } = window.location
  if (pathname !== '/app' && pathname !== '/app/') return
  const params = new URLSearchParams(search)
  const key = params.get('p')
  if (key === null) return
  const target = Object.prototype.hasOwnProperty.call(LEGACY_P, key) ? LEGACY_P[key]! : '/app'
  window.history.replaceState(null, '', target + hash)
}
