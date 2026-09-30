// Monochrome nav/chrome icons (DESIGN.md §Nav icon pattern). Paths are taken from
// the rendered reference (.design-foundations/build/components.html). 20 × 20,
// currentColor, stroke 1.5. No emoji in chrome.
import type { ReactNode } from 'react'

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const PATHS: Record<string, ReactNode> = {
  squad: (<g {...S}><rect x="1" y="5" width="18" height="11" rx="3" /><path d="M6 10h4M8 8v4" /><circle cx="14" cy="9.5" r=".75" fill="currentColor" stroke="none" /><circle cx="14" cy="12" r=".75" fill="currentColor" stroke="none" /></g>),
  watch: (<g {...S}><rect x="2" y="3" width="16" height="11" rx="2" /><path d="M7 17h6M10 14v3" /></g>),
  clips: (<g {...S}><rect x="1" y="4" width="18" height="12" rx="2" /><path d="M1 8h18M1 12h18M6 4v4M6 12v4M14 4v4M14 12v4" /></g>),
  more: (<g fill="currentColor"><circle cx="4" cy="10" r="1.75" /><circle cx="10" cy="10" r="1.75" /><circle cx="16" cy="10" r="1.75" /></g>),
  huddle: (<g {...S}><rect x="7" y="1" width="6" height="9" rx="3" /><path d="M4 9a6 6 0 0 0 12 0M10 18v-3M7 18h6" /></g>),
  slap: (<g {...S}><path d="M7 15V5l12-2v10" /><circle cx="4.5" cy="15" r="2.5" /><circle cx="16.5" cy="13" r="2.5" /></g>),
  chat: (<g {...S}><path d="M17 12a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2z" /></g>),
  giveaway: (<g {...S}><polyline points="17,9 17,19 3,19 3,9" /><rect x="1" y="5" width="18" height="4" /><line x1="10" y1="19" x2="10" y2="5" /><path d="M10 5H6.5a2 2 0 0 1 0-4C9 1 10 5 10 5z" /><path d="M10 5h3.5a2 2 0 0 0 0-4C11 1 10 5 10 5z" /></g>),
  ask: (<g {...S}><path d="M10 1v3M10 16v3M1 10h3M16 10h3M3.5 3.5l2 2M14.5 14.5l2 2M16.5 3.5l-2 2M5.5 14.5l-2 2" /><circle cx="10" cy="10" r="3.5" /></g>),
  coach: (<g {...S}><circle cx="10" cy="10" r="8" /><circle cx="10" cy="10" r="4.5" /><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" /></g>),
  link: (<g {...S}><path d="M8 11a4 4 0 0 0 5.66.54l2.5-2.5A4 4 0 0 0 10.5 3.3L9.08 4.72" /><path d="M12 9a4 4 0 0 0-5.66-.54l-2.5 2.5a4 4 0 0 0 5.66 5.66l1.42-1.42" /></g>),
  settings: (<g {...S}><circle cx="10" cy="10" r="3" /><path d="M10 1v2M10 17v2M1 10h2M17 10h2M3.2 3.2l1.4 1.4M15.4 15.4l1.4 1.4M16.8 3.2l-1.4 1.4M4.6 15.4l-1.4 1.4" /></g>),
  admin: (<g {...S}><path d="M10 18.5s7-3.5 7-8.5V4l-7-2.5L3 4v6c0 5 7 8.5 7 8.5z" /></g>),
  close: (<g {...S}><path d="M5 5l10 10M15 5L5 15" /></g>),
  up: (<g {...S}><path d="M5 12l5-5 5 5" /></g>),
  down: (<g {...S}><path d="M5 8l5 5 5-5" /></g>),
  left: (<g {...S}><path d="M13 5l-5 5 5 5" /></g>),
  right: (<g {...S}><path d="M7 5l5 5-5 5" /></g>),
  expand: (<g {...S}><path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4" /></g>),
  collapse: (<g {...S}><path d="M8 4v4H4M12 4v4h4M8 16v-4H4M12 16v-4h4" /></g>),
  user: (<g {...S}><circle cx="10" cy="7" r="3.5" /><path d="M3.5 18c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /></g>),
  signout: (<g {...S}><path d="M8 3H4v14h4M13 6l4 4-4 4M17 10H8" /></g>),
  external: (<g {...S}><path d="M11 3h6v6M17 3l-8 8M15 12v5H3V5h5" /></g>),
}

export type IconName = keyof typeof PATHS

export function Icon({ name, className = 'nav-icon' }: { name: IconName; className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 20 20" focusable="false">{PATHS[name]}</svg>
    </span>
  )
}
