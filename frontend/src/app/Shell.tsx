// PS-0 · App shell: top bar + tab bar + More sheet below 1024 px, sidebar at and
// above it. Owns the session probe, the shared squad store (badge) and the toast region.
import { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Icon } from '../components/Icon'
import { Toaster } from '../components/toast'
import { InstallStrip } from '../components/InstallStrip'
import { onWorkerNavigate } from '../lib/pwa'
import { useStale } from '../components/states'
import { useAccount, useAdminCheck, useSquad, SQUAD_MS, type Member } from '../lib/api'
import { ApiError } from '../lib/http'
import { useDesktop } from '../lib/media'
import { loginUrl, redirectToLogin, useSignedOut } from '../lib/session'
import { useSwipeDown } from '../lib/gestures'
import { usePanelCollapsed } from '../features/chat/panelState'
import { MiniPlayer, PlayerSheet } from '../features/slap/NowPlaying'
import { current as nowPlaying, usePlayer } from '../features/slap/player'
import { WatchPage } from '../features/watch/WatchPage'
import { CallBar, useHuddleBar, useWatchBar } from '../features/watch/WatchBar'
import { useWatchSelect } from '../features/watch/session'
import { DESTS, MORE_ACCOUNT, MORE_SQUAD, SIDEBAR_FOOT, SIDEBAR_MAIN, TAB_IDS, destForPath, helpHref, type DestId } from './nav'

const MASCOT = '/footer-avatar.png'

export function Shell() {
  const desktop = useDesktop()
  const location = useLocation()
  const current = destForPath(location.pathname)
  const admin = useAdminCheck()
  const isAdmin = admin.data?.admin === true // fail closed: errors and loading are non-admin
  const signedOut = useSignedOut()
  const collapsed = usePanelCollapsed()
  const navigate = useNavigate()
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
  const onWatch = current === 'watch'
  const keepWatch = useWatchSelect((s) => s.active) || onWatch
  const watchBar = useWatchBar(onWatch)
  const huddleBar = useHuddleBar(current === 'huddle')
  const callRows = Number(watchBar) + Number(huddleBar)
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
        {signedOut && (
          <div className="banner" role="status" style={{ marginBottom: 'var(--space-5)' }}>
            <span style={{ fontWeight: 700 }}>Sign in to keep up</span>
            <a className="btn btn-secondary" href={loginUrl()}>Sign in</a>
          </div>
        )}
        {!desktop && <InstallStrip />}
        <Outlet context={{ isAdmin, adminKnown: admin.isSuccess || admin.isError }} />
        {keepWatch && <WatchPage visible={onWatch} />}
      </main>
      {!desktop && callRows > 0 && <CallBar variant="bar" watch={watchBar} huddle={huddleBar} />}
      {!desktop && <MiniPlayer variant="bar" />}
      {!desktop && <TabBar current={current} isAdmin={isAdmin} />}
      <PlayerSheet />
      <Toaster />
    </>
  )
}

export type ShellContext = { isAdmin: boolean; adminKnown: boolean }

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
          <AccountControl />
        </div>
      </header>
    </>
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
function TabBar({ current, isAdmin }: { current: DestId | null; isAdmin: boolean }) {
  const [moreOpen, setMoreOpen] = useState(false)
  const badge = useLiveBadge()
  const location = useLocation()
  useEffect(() => { setMoreOpen(false) }, [location.pathname])
  const moreActive = current !== null && !TAB_IDS.includes(current)
  return (
    <nav className="tabbar chrome" aria-label="Tab bar">
      <ul>
        {TAB_IDS.map((id) => {
          const d = DESTS[id]
          const active = current === id
          return (
            <li key={id}>
              <Link className="tab" to={d.path} data-active={active} aria-current={active ? 'page' : undefined}>
                <Icon name={d.icon} />
                {d.label}
                {id === 'squad' && badge > 0 && (
                  <><span className="tab-badge" aria-hidden="true">{badge}</span><span className="sr-only">, {badge} in a game</span></>
                )}
              </Link>
            </li>
          )
        })}
        <li>
          <Dialog.Root open={moreOpen} onOpenChange={setMoreOpen}>
            <Dialog.Trigger asChild>
              <button type="button" className="tab" data-active={moreActive} aria-label={moreActive && current ? `More, current: ${DESTS[current].label}` : 'More'}>
                <Icon name="more" />
                More
              </button>
            </Dialog.Trigger>
            <MoreSheet current={current} isAdmin={isAdmin} onClose={() => setMoreOpen(false)} />
          </Dialog.Root>
        </li>
      </ul>
    </nav>
  )
}

function MoreSheet({ current, isAdmin, onClose }: { current: DestId | null; isAdmin: boolean; onClose: () => void }) {
  const swipe = useSwipeDown(onClose)
  const group = (ids: DestId[]) =>
    ids.filter((id) => !DESTS[id].adminOnly || isAdmin).map((id) => {
      const d = DESTS[id]
      return (
        <li key={id}>
          <Link className="more-row" to={d.path} aria-current={current === id ? 'page' : undefined} onClick={onClose}>
            <Icon name={d.icon} />{d.label}
          </Link>
          <HelpDot id={id} onClick={onClose} />
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
          <ul className="more-list" aria-labelledby="more-squad">{group(MORE_SQUAD)}</ul>
          <h3 className="eyebrow more-group-label" id="more-account">Account</h3>
          <ul className="more-list" aria-labelledby="more-account">{group(MORE_ACCOUNT)}</ul>
        </nav>
      </Dialog.Content>
    </Dialog.Portal>
  )
}

/** The ⓘ beside a menu row: a sibling link (links cannot nest) to that item's Help section. */
function HelpDot({ id, onClick }: { id: DestId; onClick?: () => void }) {
  const href = helpHref(id)
  if (!href) return null
  return (
    <Link className="help-dot" to={href} onClick={onClick} aria-label={`How to use ${DESTS[id].label}`} title={`How to use ${DESTS[id].label}`}>
      <Icon name="info" />
    </Link>
  )
}

// ── Desktop sidebar ──────────────────────────────────────────────────────────
function Sidebar({ current, isAdmin, watchBar, huddleBar }: { current: DestId | null; isAdmin: boolean; watchBar: boolean; huddleBar: boolean }) {
  const badge = useLiveBadge()
  const row = (id: DestId) => {
    const d = DESTS[id]
    if (d.adminOnly && !isAdmin) return null
    return (
      <li key={id}>
        <Link className="nav-row" to={d.path} aria-current={current === id ? 'page' : undefined}>
          <Icon name={d.icon} />
          {d.label}
          {id === 'squad' && badge > 0 && <><span className="nav-badge" aria-hidden="true">{badge}</span><span className="sr-only">, {badge} in a game</span></>}
        </Link>
        <HelpDot id={id} />
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
