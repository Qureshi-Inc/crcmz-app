// PS-0 · App shell: top bar + tab bar + More sheet below 1024 px, sidebar at and
// above it. Owns the session probe, the shared squad store (badge) and the toast region.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useQuery } from '@tanstack/react-query'
import { Icon } from '../components/Icon'
import { Toaster } from '../components/toast'
import { InstallStrip } from '../components/InstallStrip'
import { UpdateStrip } from '../components/UpdateStrip'
import { usePendingShare } from '../features/share/SharePage'
import { onWorkerNavigate } from '../lib/pwa'
import { useStale } from '../components/states'
import { useAccount, useAdminCheck, useSquad, SQUAD_MS, type Member } from '../lib/api'
import { ApiError, getJSON } from '../lib/http'
import { useDesktop, useReducedMotion } from '../lib/media'
import { useUnread } from '../lib/notifications'
import { loginUrl, redirectToLogin, useSignedOut } from '../lib/session'
import { useSwipeDown } from '../lib/gestures'
import { usePanelCollapsed } from '../features/chat/panelState'
import { MiniPlayer, PlayerSheet } from '../features/slap/NowPlaying'
import { current as nowPlaying, usePlayer } from '../features/slap/player'
import { WatchPage } from '../features/watch/WatchPage'
import { CallBar, useHuddleBar, useWatchBar } from '../features/watch/WatchBar'
import { useWatchSelect } from '../features/watch/session'
import { DESTS, MORE_ACCOUNT, SIDEBAR_FOOT, SIDEBAR_MAIN, destForPath, moreSquad, type DestId } from './nav'
import { useTabs } from './tabs'
import { useSlapNames } from '../lib/slap'
import { nativeShell, onShellGo, toShell } from '../lib/nativeShell'
import { DrawerGrip, useDrawerNav } from './drawer'

const MASCOT = '/footer-avatar.png'

export function Shell() {
  const desktop = useDesktop()
  const location = useLocation()
  const current = destForPath(location.pathname)
  const admin = useAdminCheck()
  const isAdmin = admin.data?.admin === true // fail closed: errors and loading are non-admin
  const signedOut = useSignedOut()
  // Slap's "added by" / "picked for" names, for everyone in the squad (lib/slap.ts).
  useSlapNames(!signedOut)
  const collapsed = usePanelCollapsed()
  const navigate = useNavigate()
  const reducedMotion = useReducedMotion()
  useDrawerNav(desktop, reducedMotion)
  // A tapped notification while the app is open routes here, so calls and music keep going.
  useEffect(() => onWorkerNavigate((path) => navigate(path)), [navigate])

  // Boot probe: a 401 before the app ever had a session answer means the cookie is
  // gone. Send them to sign in and come straight back here.
  const probed = useRef(false)
  useEffect(() => {
    if (probed.current) return
    if (admin.isSuccess) probed.current = true
    else if (admin.error instanceof ApiError && admin.error.status === 401) {
      probed.current = true
      redirectToLogin()
    }
  }, [admin.isSuccess, admin.error])

  // Move focus to the new page's heading on in-app navigation (not on first load).
  // Tracks the previous path, not a "first run" flag: StrictMode runs effects twice.
  const prevPath = useRef(location.pathname)
  useEffect(() => {
    if (prevPath.current === location.pathname) return
    prevPath.current = location.pathname
    // The Watch page can stay mounted (hidden) behind other pages: pick the visible heading.
    const h = [...document.querySelectorAll<HTMLElement>('#main h1')].find((el) => el.offsetParent !== null)
    h?.focus({ preventScroll: true })
    // A #section link (Help's ⓘ) scrolls itself to that section.
    if (!location.hash) window.scrollTo(0, 0)
  }, [location.pathname, location.hash])

  const chatMode = current === 'squad' ? (desktop ? (collapsed ? 'rail' : 'panel') : 'mobile') : undefined

  // The mini-player is page chrome: while it shows, content and toasts make room for it.
  const player = usePlayer()
  const hasPlayer = !!nowPlaying(player) || player.mode === 'together'
  useEffect(() => {
    const d = document.documentElement.dataset
    if (hasPlayer) d.player = ''
    else delete d.player
  }, [hasPlayer])

  // Watch Party stays mounted once started, so the video and call survive navigation.
  // /watch is the Movies home; the party itself is /watch/party.
  const onWatch = /^\/watch\/party\/?$/.test(location.pathname)
  const keepWatch = useWatchSelect((s) => s.active) || onWatch
  const watchBar = useWatchBar(onWatch)
  const huddleBar = useHuddleBar(current === 'huddle')
  const callRows = Number(watchBar) + Number(huddleBar)
  usePendingShare(nativeShell())
  useEffect(() => {
    const html = document.documentElement
    if (callRows && !desktop) { html.dataset.watchbar = ''; html.style.setProperty('--callbar-rows', String(callRows)) }
    else { delete html.dataset.watchbar; html.style.removeProperty('--callbar-rows') }
  }, [callRows, desktop])

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      {desktop ? <Sidebar current={current} isAdmin={isAdmin} watchBar={watchBar} huddleBar={huddleBar} /> : <TopBar />}
      <main id="main" className="app-main" data-chat={chatMode} tabIndex={-1} style={{ outline: 'none' }}>
        {!desktop && <DrawerGrip />}
        {signedOut && (
          <div className="banner" role="status" style={{ marginBottom: 'var(--space-5)' }}>
            <span style={{ fontWeight: 700 }}>Sign in to keep up</span>
            <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
          </div>
        )}
        <UpdateStrip />
        {!desktop && <InstallStrip />}
        {!signedOut && <SessionBanner />}
        <Outlet context={{ isAdmin, adminKnown: admin.isSuccess || admin.isError }} />
        {keepWatch && <WatchPage visible={onWatch} />}
      </main>
      {!desktop && callRows > 0 && <CallBar variant="bar" watch={watchBar} huddle={huddleBar} />}
      {!desktop && <MiniPlayer variant="bar" />}
      {!desktop && (nativeShell() ? <NativeTabs current={current} isAdmin={isAdmin} /> : <TabBar current={current} isAdmin={isAdmin} />)}
      <PlayerSheet />
      <Toaster />
    </>
  )
}

export type ShellContext = { isAdmin: boolean; adminKnown: boolean }

// ── Active-session banner ────────────────────────────────────────────────────
type ActiveSession = { type: 'huddle' | 'watch' | 'slap'; name: string; participant_count: number; join_url: string }

function useActiveSessions() {
  return useQuery({
    queryKey: ['sessions', 'active'],
    queryFn: ({ signal }) => getJSON<{ sessions: ActiveSession[] }>('/api/sessions/active', signal),
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
  })
}

function SessionBanner() {
  const q = useActiveSessions()
  const sessions = q.data?.sessions ?? []
  if (!sessions.length) return null
  return (
    <div className="session-banner" role="status" aria-label="Live sessions" style={{ marginBottom: 'var(--space-5)' }}>
      {sessions.map((s) => (
        <Link
          key={`${s.type}-${s.name}`}
          to={s.join_url}
          className="session-chip"
          aria-label={`Join ${s.type === 'huddle' ? 'Huddle' : 'Watch Party'}: ${s.name}, ${s.participant_count} ${s.participant_count === 1 ? 'person' : 'people'}`}
        >
          <Icon name={s.type === 'huddle' ? 'huddle' : s.type === 'watch' ? 'watch' : 'slap'} />
          <span className="session-chip-label">
            <span className="session-chip-type">{s.type === 'huddle' ? 'Huddle' : s.type === 'watch' ? 'Watch Party' : 'Slap'}</span>
            <span className="session-chip-name">{s.name}</span>
          </span>
          <span className="session-chip-count">{s.participant_count}</span>
        </Link>
      ))}
    </div>
  )
}

/** G-05: the live count on the Squad nav item. Hidden when 0, on error, or while stale. */
function useLiveBadge(): number {
  const q = useSquad()
  const { stale } = useStale(q, SQUAD_MS)
  if (!q.data || q.isError || stale) return 0
  return q.data.squad.filter((m) => m.playing).length
}

// ── Mobile top bar ───────────────────────────────────────────────────────────
function TopBar() {
  const [condensed, setCondensed] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  // A 1 px sentinel at the condense threshold (DESIGN.md §Navigation: mobile top bar).
  // No scroll listener, no layout reads on scroll.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setCondensed(!(e?.isIntersecting ?? true)))
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <>
      <div ref={sentinel} className="topbar-sentinel" aria-hidden="true" />
      <header className={`topbar chrome${condensed ? ' condensed' : ''}`} data-condensed={condensed}>
        <div className="topbar-row">
          <Link to="/" className="topbar-brand" aria-label="CRCMZ APP, go to Squad">
            <img className="mascot" src={MASCOT} alt="" width={64} height={64} decoding="async" />
            <span className="topbar-words">
              <span className="wordmark-wrap"><span className="wordmark-text">CRCMZ APP</span></span>
              <span className="tagline topbar-tagline" aria-hidden={condensed}>YES. WE HAVE ONE.</span>
            </span>
          </Link>
          <span className="topbar-spacer" />
          <BellLink />
          <AccountControl />
        </div>
      </header>
    </>
  )
}

/** The bell: unread count, straight to the notification centre. Hidden when signed out. */
function BellLink() {
  const acct = useAccount()
  const signedIn = acct.data?.state === 'signed-in'
  const n = useUnread(signedIn)
  if (!signedIn) return null
  return (
    <Link to="/notifications" className="bell-btn" aria-label={n ? `Notifications, ${n} unread` : 'Notifications'}>
      <Icon name="bell" />
      {n > 0 && <span className="tab-badge bell-badge" aria-hidden="true">{n > 99 ? '99+' : n}</span>}
    </Link>
  )
}

// ── Account (G-04) ───────────────────────────────────────────────────────────
function useMe(): { name: string | null; avatar: string | null; signedIn: boolean | null; linked: boolean } {
  const acct = useAccount()
  const squad = useSquad()
  const a = acct.data
  if (!a || a.state === 'unknown') return { name: null, avatar: null, signedIn: null, linked: false }
  if (a.state === 'signed-out') return { name: null, avatar: null, signedIn: false, linked: false }
  const me: Member | undefined = a.onlineId
    ? squad.data?.squad.find((m) => (m.online_id || '').toLowerCase() === a.onlineId!.toLowerCase())
    : undefined
  return { name: a.onlineId, avatar: me?.avatar || null, signedIn: true, linked: a.linked }
}

function AvatarFace({ name, avatar }: { name: string | null; avatar: string | null }) {
  if (avatar) return <img src={avatar} alt="" referrerPolicy="no-referrer" />
  if (name) return <span aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
  return <Icon name="user" />
}

function AccountControl({ variant = 'topbar' }: { variant?: 'topbar' | 'sidebar' }) {
  const me = useMe()
  if (me.signedIn === false) {
    return <a className="btn btn-secondary signin-link" href={loginUrl()}>Sign in</a>
  }
  const label = me.name ? `Account: ${me.name}` : 'Account'
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        {variant === 'sidebar' ? (
          <button type="button" className="account-trigger" aria-label={label}>
            <span className="avatar-btn"><AvatarFace name={me.name} avatar={me.avatar} /></span>
            <span className="account-name">{me.name || 'Account'}</span>
          </button>
        ) : (
          <button type="button" className="avatar-btn" aria-label={label}>
            <AvatarFace name={me.name} avatar={me.avatar} />
          </button>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-content" sideOffset={8} align={variant === 'sidebar' ? 'start' : 'end'} side={variant === 'sidebar' ? 'top' : 'bottom'}>
          {me.name && <Menu.Label className="menu-label meta">Signed in as {me.name}</Menu.Label>}
          <Menu.Item asChild>
            <Link className="menu-item" to="/settings"><Icon name="settings" />Settings</Link>
          </Menu.Item>
          {me.signedIn && !me.linked && (
            <Menu.Item asChild>
              <Link className="menu-item" to="/portal"><Icon name="link" />Link PSN</Link>
            </Menu.Item>
          )}
          <Menu.Item asChild>
            <a className="menu-item" href="/auth/logout"><Icon name="signout" />Sign out</a>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}

// ── Mobile tab bar + More sheet ──────────────────────────────────────────────
// [slot] [slot] (Ask AI) [slot] [More]: the slots are the user's pick (Settings → App).
function TabBar({ current, isAdmin }: { current: DestId | null; isAdmin: boolean }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const badge = useLiveBadge()
  const location = useLocation()
  const tabs = useTabs()
  useEffect(() => { setMoreOpen(false) }, [location.pathname])
  const moreActive = current !== null && current !== 'ask' && !tabs.includes(current)
  const tab = (id: DestId) => {
    const d = DESTS[id]
    const active = current === id
    return (
      <li key={id}>
        <Link className="tab" to={d.path} data-active={active} aria-current={active ? 'page' : undefined}>
          <Icon name={d.icon} />
          <span className="tab-label">{d.label}</span>
          {id === 'squad' && badge > 0 && (
            <><span className="tab-badge" aria-hidden="true">{badge}</span><span className="sr-only">, {badge} in a game</span></>
          )}
        </Link>
      </li>
    )
  }
  return (
    <nav className="tabbar chrome" aria-label="Tab bar">
      <ul>
        {tab(tabs[0]!)}
        {tab(tabs[1]!)}
        <AskTab active={current === 'ask'} />
        {tab(tabs[2]!)}
        <li>
          <Dialog.Root open={moreOpen} onOpenChange={setMoreOpen}>
            <Dialog.Trigger asChild>
              <button type="button" className="tab" data-active={moreActive} aria-label={moreActive && current ? `More, current: ${DESTS[current].label}` : 'More'}>
                <Icon name="more" />
                <span className="tab-label">More</span>
              </button>
            </Dialog.Trigger>
            <MoreSheet current={current} isAdmin={isAdmin} tabs={tabs} onClose={() => setMoreOpen(false)} />
          </Dialog.Root>
        </li>
      </ul>
    </nav>
  )
}

/** The iOS app's own tab bar: the same slots and More list, drawn natively. */
function NativeTabs({ current, isAdmin }: { current: DestId | null; isAdmin: boolean }) {
  const badge = useLiveBadge()
  const tabs = useTabs()
  const navigate = useNavigate()
  const fs = useWatchSelect((s) => s.fs)
  useEffect(() => onShellGo((path) => navigate(path)), [navigate])
  useEffect(() => {
    const item = (id: DestId, group?: 'squad' | 'account') => ({ id, label: DESTS[id].label, path: DESTS[id].path, ...(group ? { group } : {}) })
    const allowed = (id: DestId) => (!DESTS[id].adminOnly || isAdmin) && id !== 'getapp'   // already in the app
    toShell({
      tabs: [item(tabs[0]!), item(tabs[1]!), item('ask'), item(tabs[2]!)],
      more: [...moreSquad(tabs).filter(allowed).map((id) => item(id, 'squad')), ...MORE_ACCOUNT.filter(allowed).map((id) => item(id, 'account'))],
      active: current, badge, hidden: fs,
    })
  }, [tabs, current, badge, fs, isAdmin])
  return null
}

/**
 * Ask AI: a glowing orb in the middle of the bar. Tapping it launches the orb up into
 * the middle of the screen, where it zooms until it fills the screen and opens the chat.
 */
function AskTab({ active }: { active: boolean }) {
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  const orb = useRef<HTMLSpanElement>(null)
  const [flying, setFlying] = useState(false)
  function go(e: MouseEvent<HTMLAnchorElement>) {
    // Already there, a new-tab click, or reduced motion: a plain link.
    if (active || reduced || flying || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    const el = orb.current
    if (!el || typeof el.animate !== 'function') return
    e.preventDefault()
    setFlying(true)
    launch(el, () => navigate('/ask'), () => setFlying(false))
  }
  return (
    <li className="tab-ask-slot">
      <Link className="tab tab-ask" to="/ask" data-active={active} data-flying={flying} aria-current={active ? 'page' : undefined} onClick={go}>
        <span className="tab-ask-orb" ref={orb}><Icon name="aiChat" /></span>
        <span className="tab-label">Ask AI</span>
      </Link>
    </li>
  )
}

/** The flight: a copy of the orb rises to the screen centre, spins, then zooms past the edges and fades over the chat. */
function launch(from: HTMLElement, arrive: () => void, done: () => void) {
  const r = from.getBoundingClientRect()
  const fly = document.createElement('div')
  fly.className = 'ask-fly'
  fly.setAttribute('aria-hidden', 'true')
  fly.innerHTML = from.innerHTML
  Object.assign(fly.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  document.body.appendChild(fly)
  const dx = window.innerWidth / 2 - (r.left + r.width / 2)
  const dy = window.innerHeight * 0.42 - (r.top + r.height / 2)
  // Big enough that the circle covers the corners from the centre.
  const cover = (Math.hypot(window.innerWidth, window.innerHeight) / r.width) * 1.15
  const icon = fly.firstElementChild as HTMLElement | null
  const flight = fly.animate([
    { transform: 'translate(0, 0) scale(1) rotate(0deg)', offset: 0 },
    { transform: `translate(0, 8px) scale(.86) rotate(0deg)`, offset: 0.1 },
    { transform: `translate(${dx}px, ${dy}px) scale(1.9) rotate(-14deg)`, offset: 0.48, easing: 'cubic-bezier(.5, 0, .2, 1)' },
    { transform: `translate(${dx}px, ${dy}px) scale(1.7) rotate(4deg)`, offset: 0.6, easing: 'cubic-bezier(.7, 0, .9, .4)' },
    { transform: `translate(${dx}px, ${dy}px) scale(${cover}) rotate(0deg)`, offset: 1 },
  ], { duration: 820, easing: 'cubic-bezier(.3, .7, .4, 1)', fill: 'forwards' })
  icon?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: 820, fill: 'forwards' })
  flight.finished.then(() => {
    arrive()
    done()
    // The chat is underneath now: let it show through.
    fly.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-out', fill: 'forwards' }).finished
      .finally(() => fly.remove())
  }, () => { fly.remove(); done() })
}

function MoreSheet({ current, isAdmin, tabs, onClose }: { current: DestId | null; isAdmin: boolean; tabs: DestId[]; onClose: () => void }) {
  const swipe = useSwipeDown(onClose)
  const group = (ids: DestId[]) =>
    ids.filter((id) => !DESTS[id].adminOnly || isAdmin).map((id) => {
      const d = DESTS[id]
      return (
        <li key={id}>
          <Link className="more-row" to={d.path} aria-current={current === id ? 'page' : undefined} onClick={onClose}>
            <Icon name={d.icon} />{d.label}
          </Link>
        </li>
      )
    })
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="scrim" />
      <Dialog.Content className="sheet sheet-more" aria-describedby={undefined}>
        <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>
        <div className="sheet-title-row">
          <Dialog.Title className="sheet-title">More</Dialog.Title>
          <Dialog.Close asChild>
            <button type="button" className="icon-btn" aria-label="Close More"><Icon name="close" /></button>
          </Dialog.Close>
        </div>
        <nav aria-label="More">
          <h3 className="eyebrow more-group-label" id="more-squad">Squad</h3>
          <ul className="more-list" aria-labelledby="more-squad">{group(moreSquad(tabs))}</ul>
          <h3 className="eyebrow more-group-label" id="more-account">Account</h3>
          <ul className="more-list" aria-labelledby="more-account">{group(MORE_ACCOUNT)}</ul>
        </nav>
        <Link className="btn btn-ghost more-edit" to="/settings/app#tabbar" onClick={onClose}><Icon name="edit" />Change the tab bar</Link>
      </Dialog.Content>
    </Dialog.Portal>
  )
}

// ── Desktop sidebar ──────────────────────────────────────────────────────────
function Sidebar({ current, isAdmin, watchBar, huddleBar }: { current: DestId | null; isAdmin: boolean; watchBar: boolean; huddleBar: boolean }) {
  const badge = useLiveBadge()
  const acct = useAccount()
  const unread = useUnread(acct.data?.state === 'signed-in')
  const row = (id: DestId) => {
    const d = DESTS[id]
    if (d.adminOnly && !isAdmin) return null
    return (
      <li key={id}>
        <Link className="nav-row" to={d.path} aria-current={current === id ? 'page' : undefined}>
          <Icon name={d.icon} />
          {d.label}
          {id === 'squad' && badge > 0 && <><span className="nav-badge" aria-hidden="true">{badge}</span><span className="sr-only">, {badge} in a game</span></>}
          {id === 'notifications' && unread > 0 && <><span className="nav-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span><span className="sr-only">, {unread} unread</span></>}
        </Link>
      </li>
    )
  }
  return (
    <aside className="sidebar chrome" aria-label="Sidebar">
      <Link to="/" className="sidebar-brand" aria-label="CRCMZ APP, go to Squad">
        <img className="mascot" src={MASCOT} alt="" width={64} height={64} decoding="async" />
        <span className="topbar-words">
          <span className="wordmark-wrap"><span className="wordmark-text">CRCMZ APP</span></span>
          <span className="tagline">YES. WE HAVE ONE.</span>
        </span>
      </Link>
      <nav aria-label="Primary" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
        <ul className="sidebar-group">{SIDEBAR_MAIN.map(row)}</ul>
        <div className="sidebar-spacer" />
        <ul className="sidebar-group">{SIDEBAR_FOOT.map(row)}</ul>
      </nav>
      {(watchBar || huddleBar) && <CallBar variant="sidebar" watch={watchBar} huddle={huddleBar} />}
      <MiniPlayer variant="sidebar" />
      <div className="sidebar-account">
        <AccountControl variant="sidebar" />
      </div>
    </aside>
  )
}
