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
  /** Ask AI's tab orb: a chat bubble with a spark. */
  aiChat: (<g {...S}><path d="M10.5 3H4.5a2 2 0 0 0-2 2v8.5l3-2.5h8a2 2 0 0 0 2-2V8" /><path d="M15 1l.8 2 2 .8-2 .8L15 6.6l-.8-2-2-.8 2-.8z" fill="currentColor" /><path d="M6 7h4" /></g>),
  ask: (<g {...S}><path d="M10 1v3M10 16v3M1 10h3M16 10h3M3.5 3.5l2 2M14.5 14.5l2 2M16.5 3.5l-2 2M5.5 14.5l-2 2" /><circle cx="10" cy="10" r="3.5" /></g>),
  coach: (<g {...S}><circle cx="10" cy="10" r="8" /><circle cx="10" cy="10" r="4.5" /><circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" /></g>),
  link: (<g {...S}><path d="M8 11a4 4 0 0 0 5.66.54l2.5-2.5A4 4 0 0 0 10.5 3.3L9.08 4.72" /><path d="M12 9a4 4 0 0 0-5.66-.54l-2.5 2.5a4 4 0 0 0 5.66 5.66l1.42-1.42" /></g>),
  settings: (<g {...S}><circle cx="10" cy="10" r="3" /><path d="M10 1v2M10 17v2M1 10h2M17 10h2M3.2 3.2l1.4 1.4M15.4 15.4l1.4 1.4M16.8 3.2l-1.4 1.4M4.6 15.4l-1.4 1.4" /></g>),
  admin: (<g {...S}><path d="M10 18.5s7-3.5 7-8.5V4l-7-2.5L3 4v6c0 5 7 8.5 7 8.5z" /></g>),
  info: (<g {...S}><circle cx="10" cy="10" r="8" /><path d="M10 9v5" /><circle cx="10" cy="6.2" r=".9" fill="currentColor" stroke="none" /></g>),
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
  play: (<g fill="currentColor"><path d="M6 3.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L6.9 3a.6.6 0 0 0-.9.5z" /></g>),
  pause: (<g fill="currentColor"><rect x="4.5" y="3" width="4" height="14" rx="1" /><rect x="11.5" y="3" width="4" height="14" rx="1" /></g>),
  next: (<g fill="currentColor"><path d="M3 4.2v11.6a.5.5 0 0 0 .8.4l8.4-5.8a.5.5 0 0 0 0-.8L3.8 3.8a.5.5 0 0 0-.8.4z" /><rect x="14" y="3.5" width="2.5" height="13" rx=".8" /></g>),
  prev: (<g fill="currentColor"><path d="M17 4.2v11.6a.5.5 0 0 1-.8.4L7.8 10.4a.5.5 0 0 1 0-.8l8.4-5.8a.5.5 0 0 1 .8.4z" /><rect x="3.5" y="3.5" width="2.5" height="13" rx=".8" /></g>),
  shuffle: (<g {...S}><path d="M2 5h3.5c4 0 5 10 9 10H18M2 15h3.5c1.6 0 2.7-1.6 3.6-3.6M11 8.6c.9-2 2-3.6 3.5-3.6H18M15.5 2.5 18 5l-2.5 2.5M15.5 12.5 18 15l-2.5 2.5" /></g>),
  repeat: (<g {...S}><path d="M3 9V7a3 3 0 0 1 3-3h11M14 1l3 3-3 3M17 11v2a3 3 0 0 1-3 3H3M6 19l-3-3 3-3" /></g>),
  queue: (<g {...S}><path d="M2 4h11M2 9h11M2 14h6M15 11v7M12 15l3 3 3-3" /></g>),
  heart: (<g {...S}><path d="M10 17s-7-4.4-7-9.2A3.8 3.8 0 0 1 10 5.6a3.8 3.8 0 0 1 7 2.2C17 12.6 10 17 10 17z" /></g>),
  heartFill: (<g fill="currentColor"><path d="M10 17s-7-4.4-7-9.2A3.8 3.8 0 0 1 10 5.6a3.8 3.8 0 0 1 7 2.2C17 12.6 10 17 10 17z" /></g>),
  thumbUp: (<g {...S}><path d="M6 9v9H3V9zM6 9l3.5-7a2 2 0 0 1 2 2.3L11 8h5a1.5 1.5 0 0 1 1.5 1.8l-1.3 6.6A2 2 0 0 1 14.3 18H6" /></g>),
  thumbDown: (<g {...S}><path d="M6 11V2H3v9zM6 11l3.5 7a2 2 0 0 0 2-2.3L11 12h5a1.5 1.5 0 0 0 1.5-1.8l-1.3-6.6A2 2 0 0 0 14.3 2H6" /></g>),
  plus: (<g {...S}><path d="M10 4v12M4 10h12" /></g>),
  search: (<g {...S}><circle cx="8.5" cy="8.5" r="5.5" /><path d="M13 13l5 5" /></g>),
  together: (<g {...S}><circle cx="6.5" cy="7" r="2.5" /><circle cx="13.5" cy="7" r="2.5" /><path d="M1.5 16c.5-2.6 2.5-4 5-4s4.5 1.4 5 4M10 13c.9-.7 2.1-1 3.5-1 2.5 0 4.5 1.4 5 4" /></g>),
  trash: (<g {...S}><path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12" /></g>),
  edit: (<g {...S}><path d="M13.5 3.5l3 3L7 16H4v-3z" /></g>),
  refresh: (<g {...S}><path d="M16.5 8A7 7 0 0 0 4 5.5M3.5 12A7 7 0 0 0 16 14.5M4 2v3.5h3.5M16 18v-3.5h-3.5" /></g>),
  vol: (<g {...S}><path d="M3 7.5v5h3l4.5 3.5v-12L6 7.5z" /><path d="M13.5 7a4 4 0 0 1 0 6M15.5 4.5a7.5 7.5 0 0 1 0 11" /></g>),
  volLow: (<g {...S}><path d="M3 7.5v5h3l4.5 3.5v-12L6 7.5z" /><path d="M13.5 7a4 4 0 0 1 0 6" /></g>),
  volMute: (<g {...S}><path d="M3 7.5v5h3l4.5 3.5v-12L6 7.5z" /><path d="M13.5 7.5l5 5M18.5 7.5l-5 5" /></g>),
  mic: (<g {...S}><rect x="7" y="1.5" width="6" height="10" rx="3" /><path d="M4 9.5a6 6 0 0 0 12 0M10 15.5v3" /></g>),
  micOff: (<g {...S}><path d="M13 8.5V4.5a3 3 0 0 0-5.8-1M7 7v1.5a3 3 0 0 0 4.7 2.5M4 9.5a6 6 0 0 0 9.6 4.8M16 9.5a6 6 0 0 1-.5 2.4M10 15.5v3M2.5 2.5l15 15" /></g>),
  cam: (<g {...S}><rect x="1.5" y="5" width="12" height="10" rx="2" /><path d="M13.5 8.5l5-3v9l-5-3" /></g>),
  camOff: (<g {...S}><path d="M13.5 11v2a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1M8 5h3.5a2 2 0 0 1 2 2v1.5l5-3v9M2 2l16 16" /></g>),
  fs: (<g {...S}><path d="M2.5 7V2.5H7M13 2.5h4.5V7M17.5 13v4.5H13M7 17.5H2.5V13" /></g>),
  fsExit: (<g {...S}><path d="M7 2.5V7H2.5M17.5 7H13V2.5M13 17.5V13h4.5M2.5 13H7v4.5" /></g>),
  sync: (<g {...S}><path d="M3 10a7 7 0 0 1 12-4.9L17 7M17 3v4h-4M17 10a7 7 0 0 1-12 4.9L3 13M3 17v-4h4" /></g>),
  back10: (<g {...S}><path d="M4.5 6.5A7 7 0 1 1 3 10.5" /><path d="M4.5 2.5v4h4" /><text x="10.3" y="13.2" fontSize="6.2" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">10</text></g>),
  fwd10: (<g {...S}><path d="M15.5 6.5A7 7 0 1 0 17 10.5" /><path d="M15.5 2.5v4h-4" /><text x="9.7" y="13.2" fontSize="6.2" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">10</text></g>),
  smile: (<g {...S}><circle cx="10" cy="10" r="8" /><path d="M6.5 12a4 4 0 0 0 7 0" /><circle cx="7.3" cy="8" r=".8" fill="currentColor" stroke="none" /><circle cx="12.7" cy="8" r=".8" fill="currentColor" stroke="none" /></g>),
  flip: (<g {...S}><path d="M3 8a7 7 0 0 1 12.5-3M17 12a7 7 0 0 1-12.5 3M15.5 1.5V5H12M4.5 18.5V15H8" /><circle cx="10" cy="10" r="2" /></g>),
  kick: (<g {...S}><circle cx="8" cy="6.5" r="3" /><path d="M2 17c.5-3 3-5 6-5 1.2 0 2.3.3 3.2.9M13 13l5 5M18 13l-5 5" /></g>),
  leave: (<g {...S}><path d="M2.5 11.5c4.2-3.6 10.8-3.6 15 0l-1.8 2.6-3-1.1v-2.2a9 9 0 0 0-5.4 0V13l-3 1.1z" /></g>),
  grid: (<g {...S}><rect x="2" y="2" width="7" height="7" rx="1.5" /><rect x="11" y="2" width="7" height="7" rx="1.5" /><rect x="2" y="11" width="7" height="7" rx="1.5" /><rect x="11" y="11" width="7" height="7" rx="1.5" /></g>),
  screen: (<g {...S}><rect x="1.5" y="2.5" width="17" height="11" rx="2" /><path d="M7 17.5h6M10 13.5v4M10 10.5v-5M7.5 8l2.5-2.5L12.5 8" /></g>),
  blur: (<g {...S}><circle cx="10" cy="7" r="3" /><path d="M4 17.5a6 6 0 0 1 12 0" /><path d="M1.5 4v.01M1.5 9v.01M1.5 14v.01M18.5 4v.01M18.5 9v.01M18.5 14v.01" strokeWidth="2.2" /></g>),
  spotlight: (<g {...S}><rect x="1.5" y="2.5" width="17" height="10" rx="1.5" /><rect x="1.5" y="14.5" width="5" height="3" rx="1" /><rect x="7.5" y="14.5" width="5" height="3" rx="1" /><rect x="13.5" y="14.5" width="5" height="3" rx="1" /></g>),
  notes: (<g {...S}><rect x="3.5" y="2" width="13" height="16" rx="2" /><path d="M7 6.5h6M7 10h6M7 13.5h3.5" /></g>),
  download: (<g {...S}><path d="M10 2.5v10M5.5 8.5 10 13l4.5-4.5M3 17h14" /></g>),
  send: (<g {...S}><path d="M18 2L9 11M18 2l-5.5 16-3.5-7-7-3.5z" /></g>),
  bell: (<g {...S}><path d="M5 8a5 5 0 0 1 10 0c0 4.5 2 6 2 6H3s2-1.5 2-6M8.3 17a1.9 1.9 0 0 0 3.4 0" /></g>),
  megaphone: (<g {...S}><path d="M3 8v4h2.5L14 16V4L5.5 8zM5.5 12l1 5h2.5l-1-4.2M16.5 7.5a3 3 0 0 1 0 5" /></g>),
}

export type IconName = keyof typeof PATHS

export function Icon({ name, className = 'nav-icon' }: { name: IconName; className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 20 20" focusable="false">{PATHS[name]}</svg>
    </span>
  )
}
