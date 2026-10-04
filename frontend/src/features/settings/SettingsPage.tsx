// PS-10 · Settings: sign-in methods, PSN status and connected apps. Each tab is a
// sub-route (/app/settings/<tab>), so tabs deep-link and Back works.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import * as Tabs from '@radix-ui/react-tabs'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { ConfirmDialog } from '../clips/ClipSheet'
import { ClaimList } from '../portal/Claim'
import { OrbPosControl } from '../watch/WatchPage'
import { ApiError, getJSON, request } from '../../lib/http'
import { nativeShell } from '../../lib/nativeShell'
import {
  addPasskey, changePassword, fmtDate, fmtDateTime, MCP_CONFIG, passkeysSupported, removePasskey, revokeMcp, tokenState,
  setPrimaryPlatform, setSquadName, unlinkMattermost, unlinkSteam, type McpStatus, type MmStatus, type Passkey, type PsnStatus, type SteamStatus, type ProfileStatus,
} from '../../lib/account'
import {
  currentSubscription, disablePush, enablePush, fetchPushConfig, isIOS, isStandalone, promptInstall, pushSupported,
  savePushPrefs, sendTestPush, useInstall,
} from '../../lib/pwa'
import { HelpLink } from '../../components/HelpLink'
import { DESTS, TAB_CHOICES } from '../../app/nav'
import { isDefaultTabs, resetTabs, setTab, useTabs } from '../../app/tabs'

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'passkeys', label: 'Passkeys' },
  { id: 'security', label: 'Password' },
  { id: 'psn', label: 'PSN' },
  { id: 'steam', label: 'Steam' },
  { id: 'mattermost', label: 'Mattermost' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'mcp', label: 'MCP' },
  { id: 'watch', label: 'Watch' },
  { id: 'app', label: 'App' },
] as const
type TabId = (typeof TABS)[number]['id']
const LAST = 'crcmz_app_settings_tab'
const isTab = (t: string | null | undefined): t is TabId => TABS.some((x) => x.id === t)

export function SettingsPage() {
  useTitle('Settings')
  const { tab } = useParams()
  const nav = useNavigate()
  useEffect(() => {
    if (!isTab(tab)) return
    try { localStorage.setItem(LAST, tab) } catch { /* private mode */ }
    // A deep link to a later tab keeps it in view on a narrow strip.
    document.querySelector('.tabstrip-tab[data-state="active"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab])
  if (!isTab(tab)) {
    let last: string | null = null
    try { last = localStorage.getItem(LAST) } catch { /* private mode */ }
    return <Navigate to={`/settings/${isTab(last) ? last : 'passkeys'}`} replace />
  }

  return (
    <div className="page page-reading">
      <h1 className="page-h1" tabIndex={-1}>Settings<HelpLink id="settings" /></h1>
      <Tabs.Root value={tab} onValueChange={(t) => nav(`/settings/${t}`)} activationMode="manual">
        <Tabs.List className="tabstrip" aria-label="Settings sections">
          {TABS.map((t) => <Tabs.Trigger key={t.id} value={t.id} className="tabstrip-tab">{t.label}</Tabs.Trigger>)}
        </Tabs.List>
        <Tabs.Content value="profile" className="settings-panel"><ProfileTab /></Tabs.Content>
        <Tabs.Content value="passkeys" className="settings-panel"><PasskeysTab /></Tabs.Content>
        <Tabs.Content value="security" className="settings-panel"><SecurityTab /></Tabs.Content>
        <Tabs.Content value="psn" className="settings-panel"><PsnTab /></Tabs.Content>
        <Tabs.Content value="steam" className="settings-panel"><SteamTab /></Tabs.Content>
        <Tabs.Content value="mattermost" className="settings-panel"><MattermostTab /></Tabs.Content>
        <Tabs.Content value="whatsapp" className="settings-panel"><WhatsappTab /></Tabs.Content>
        <Tabs.Content value="mcp" className="settings-panel"><McpTab /></Tabs.Content>
        <Tabs.Content value="watch" className="settings-panel"><WatchTab /></Tabs.Content>
        <Tabs.Content value="app" className="settings-panel"><AppTab /></Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

const failText = (e: unknown, fallback: string) => (e instanceof ApiError && e.status === 503 ? 'Sign-in service is not set up right now' : fallback)

// ── Profile: the name shown for you on Squad (squad_name tag) ────────────────
function ProfileTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['account', 'profile'], queryFn: ({ signal }) => getJSON<ProfileStatus>('/auth/settings/profile', signal) })
  const [name, setName] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const value = name ?? q.data?.squad_name ?? ''

  async function save(e: FormEvent, next = value) {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await setSquadName(next.trim())
      toast(next.trim() ? 'Squad name saved' : 'Squad name cleared', 'success')
      setName(null)
      void qc.invalidateQueries({ queryKey: ['account', 'profile'] })
      void qc.invalidateQueries({ queryKey: ['squad'] })
    } catch (ex) {
      setErr(ex instanceof ApiError && ex.status !== 502 ? ex.message : "Couldn't save. Try again.")
    } finally { setBusy(false) }
  }

  return (
    <section className="glass settings-card" aria-labelledby="profile-h">
      <h2 className="section-h2" id="profile-h">Squad name</h2>
      {q.isPending ? <SkeletonRows n={1} />
        : q.isError ? <ErrorStrip text="Couldn't load your profile" onRetry={() => q.refetch()} />
        : (
          <form onSubmit={(e) => void save(e)} noValidate>
            <label className="field-label" htmlFor="squad-name">Name shown on Squad and in Ranks</label>
            <input
              id="squad-name" className="input" value={value} maxLength={q.data.max} autoComplete="nickname"
              placeholder={q.data.default_name || 'Your name'} aria-invalid={err ? true : undefined}
              aria-describedby="squad-name-help" onChange={(e) => { setName(e.target.value); setErr(null) }}
            />
            <p className="meta" id="squad-name-help" style={{ marginTop: 'var(--space-1)' }}>
              {q.data.min}-{q.data.max} characters. Leave it blank to show {q.data.default_name ? <b>{q.data.default_name}</b> : 'your PSN name'}. The bot knows you by it too.
            </p>
            {err && <p className="field-err" role="alert">{err}</p>}
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
              <button type="submit" className="btn btn-primary" disabled={busy || value.trim() === (q.data.squad_name ?? '')}>{busy ? 'Saving…' : 'Save'}</button>
              {q.data.squad_name && <button type="button" className="btn btn-secondary" disabled={busy} onClick={(e) => void save(e, '')}>Use default</button>}
            </div>
          </form>
        )}
    </section>
  )
}

// ── Passkeys (ST-01, ST-02) ──────────────────────────────────────────────────
function PasskeysTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['account', 'passkeys'], queryFn: ({ signal }) => getJSON<{ passkeys: Passkey[] }>('/auth/settings/passkeys', signal) })
  const [adding, setAdding] = useState(false)
  const [drop, setDrop] = useState<Passkey | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const supported = passkeysSupported()

  async function add() {
    setAdding(true)
    try {
      if (await addPasskey()) toast('Passkey added', 'success')
    } catch (e) {
      toast(e instanceof ApiError ? failText(e, "Couldn't add the passkey") : (e as Error)?.message || "Couldn't add the passkey", 'error')
    } finally {
      setAdding(false)
      void qc.invalidateQueries({ queryKey: ['account', 'passkeys'] })
    }
  }
  async function remove(p: Passkey) {
    setRemoving(p.id)
    try {
      await removePasskey(p.id)
      toast(`Removed ${p.name}`, 'success')
    } catch (e) {
      toast(failText(e, `Couldn't remove ${p.name}`), 'error')
    } finally {
      setRemoving(null)
      void qc.invalidateQueries({ queryKey: ['account', 'passkeys'] })
    }
  }

  const list = q.data?.passkeys ?? []
  return (
    <section className="glass settings-card" aria-labelledby="pk-h">
      <div className="settings-card-head">
        <h2 className="section-h2" id="pk-h">Passkeys</h2>
        {list.length > 0 && <button type="button" className="btn btn-primary" onClick={add} disabled={adding || !supported}><Icon name="plus" />{adding ? 'Waiting for your device…' : 'Add a passkey'}</button>}
      </div>
      <p className="dim">Sign in with your face, fingerprint or screen lock instead of a password.</p>
      {!supported && <p className="settings-note" role="note">This browser can't make passkeys. Try your phone's browser.</p>}
      {q.isPending ? <SkeletonRows n={2} />
        : q.isError ? <ErrorStrip text="Couldn't load your passkeys" onRetry={() => q.refetch()} />
        : list.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No passkeys yet</p>
            <p className="dim">Already made one? The list can come back empty when sign-in is slow. <button type="button" className="link-btn" onClick={() => q.refetch()}>Check again</button></p>
            <button type="button" className="btn btn-primary" onClick={add} disabled={adding || !supported}><Icon name="plus" />{adding ? 'Waiting for your device…' : 'Add a passkey'}</button>
          </div>
        ) : (
          <ul className="rows acct-rows">
            {list.map((p) => (
              <li key={p.id} className="acct-row">
                <span className="acct-row-text"><span className="acct-row-title">🔑 {p.name}</span></span>
                <button type="button" className="btn btn-ghost" onClick={() => setDrop(p)} disabled={removing === p.id} aria-label={`Remove ${p.name}`}>
                  <Icon name="trash" />{removing === p.id ? 'Removing…' : 'Remove'}
                </button>
              </li>
            ))}
          </ul>
        )}
      <ConfirmDialog
        open={drop !== null} onOpenChange={(v) => { if (!v) setDrop(null) }}
        title="Remove this passkey?"
        body={<p>{drop?.name} won't sign you in any more. You can add it again later.</p>}
        action="Remove passkey"
        onConfirm={() => { if (drop) void remove(drop) }}
      />
    </section>
  )
}

// ── Password (ST-03) ─────────────────────────────────────────────────────────
function SecurityTab() {
  const [cur, setCur] = useState('')
  const [nw, setNw] = useState('')
  const [conf, setConf] = useState('')
  const [touched, setTouched] = useState({ nw: false, conf: false })
  const [curErr, setCurErr] = useState('')
  const [busy, setBusy] = useState(false)
  const curRef = useRef<HTMLInputElement>(null)

  const nwErr = touched.nw && nw.length > 0 && nw.length < 8 ? 'At least 8 characters' : ''
  const confErr = touched.conf && conf.length > 0 && conf !== nw ? "Doesn't match the new password" : ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched({ nw: true, conf: true })
    if (!cur || nw.length < 8 || conf !== nw) return
    setBusy(true)
    setCurErr('')
    try {
      await changePassword(cur, nw)
      toast('Password changed', 'success')
      setCur(''); setNw(''); setConf(''); setTouched({ nw: false, conf: false })
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setCurErr(err.detail && err.detail !== 'missing fields' ? err.detail : 'Check your current password')
        curRef.current?.focus()
      } else toast(failText(err, "Couldn't change the password. Try again."), 'error')
    } finally { setBusy(false) }
  }

  return (
    <section className="glass settings-card" aria-labelledby="pw-h">
      <h2 className="section-h2" id="pw-h">Change password</h2>
      <form className="form-stack settings-form" onSubmit={submit} noValidate>
        <div>
          <label className="field-label" htmlFor="pw-cur">Current password</label>
          <input id="pw-cur" ref={curRef} className="input" type="password" autoComplete="current-password" value={cur}
            onChange={(e) => { setCur(e.target.value); setCurErr('') }} aria-invalid={!!curErr} aria-describedby={curErr ? 'pw-cur-err' : undefined} />
          {curErr && <p className="field-err" id="pw-cur-err">{curErr}</p>}
        </div>
        <div>
          <label className="field-label" htmlFor="pw-new">New password</label>
          <input id="pw-new" className="input" type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, nw: true }))} aria-invalid={!!nwErr} aria-describedby="pw-new-hint" />
          <p className={nwErr ? 'field-err' : 'field-hint'} id="pw-new-hint">{nwErr || 'At least 8 characters.'}</p>
        </div>
        <div>
          <label className="field-label" htmlFor="pw-conf">Type it again</label>
          <input id="pw-conf" className="input" type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, conf: true }))} aria-invalid={!!confErr} aria-describedby={confErr ? 'pw-conf-err' : undefined} />
          {confErr && <p className="field-err" id="pw-conf-err">{confErr}</p>}
        </div>
        <div><button type="submit" className="btn btn-primary" disabled={busy || !cur || !nw || !conf}>{busy ? 'Changing…' : 'Change password'}</button></div>
      </form>
    </section>
  )
}

// ── PSN (ST-04, ST-05) ───────────────────────────────────────────────────────
export function usePsnStatus() {
  return useQuery({ queryKey: ['account', 'psn'], queryFn: ({ signal }) => getJSON<PsnStatus>('/auth/settings/psn', signal) })
}

function PsnTab() {
  const q = usePsnStatus()
  if (q.isPending) return <section className="glass settings-card"><SkeletonRows n={2} /></section>
  if (q.isError) return <section className="glass settings-card"><ErrorStrip text="Couldn't load your PSN status" onRetry={() => q.refetch()} /></section>
  const d = q.data
  if (d.linked) {
    const st = tokenState(d)
    return (
      <section className="glass settings-card" aria-labelledby="psn-h">
        <h2 className="section-h2" id="psn-h">PlayStation</h2>
        <div className="acct-status">
          <span className="acct-status-emoji" aria-hidden="true">🎮</span>
          <span className="acct-row-text">
            <span className="acct-row-title">{d.online_id ?? '—'}</span>
            <span className="meta">Linked on {fmtDate(d.linked_at)}</span>
          </span>
          <span className="badge" data-tone={st.kind === 'active' ? 'live' : 'warn'} data-state={st.kind}>{st.label}</span>
        </div>
        {st.kind === 'expired' && <p className="settings-note" role="note">Your PSN sign-in ran out, so you won't show up on Squad. Re-link to fix it.</p>}
        {st.kind === 'expiring' && <p className="settings-note" role="note">Sony makes us ask again every couple of months. Re-link before it runs out.</p>}
        <PrimaryStatsControl />
        <div><Link className={st.kind === 'active' ? 'btn btn-secondary' : 'btn btn-primary'} to="/portal"><Icon name="link" />Re-link in Link PSN</Link></div>
      </section>
    )
  }
  const unclaimed = d.unclaimed ?? []
  return (
    <section className="glass settings-card" aria-labelledby="psn-h">
      <h2 className="section-h2" id="psn-h">PlayStation</h2>
      <p className="dim">Not linked yet. Link your PSN account so you show up on Squad and your clips find you.</p>
      {unclaimed.length > 0 && (
        <>
          <p className="field-label">Already linked before sign-in? Claim yours.</p>
          <ClaimList items={unclaimed} />
        </>
      )}
      <div><Link className="btn btn-primary" to="/portal"><Icon name="link" />Link your PSN account</Link></div>
    </section>
  )
}

// ── Steam ────────────────────────────────────────────────────────────────────
const STEAM_CONNECT = '/auth/settings/steam/connect'

function useSteamStatus() {
  return useQuery({ queryKey: ['account', 'steam'], queryFn: ({ signal }) => getJSON<SteamStatus>('/auth/settings/steam', signal) })
}

const PRIMARY_OPTS = [{ id: 'psn', name: 'PlayStation' }, { id: 'steam', name: 'Steam' }] as const

/** Shown in both the PSN and Steam tabs, only to people with both linked. */
function PrimaryStatsControl() {
  const qc = useQueryClient()
  const q = useSteamStatus()
  const [busy, setBusy] = useState(false)
  if (!q.data?.linked || !q.data.has_psn) return null
  const current = q.data.primary
  async function pick(p: 'psn' | 'steam') {
    if (p === current || busy) return
    setBusy(true)
    try { await setPrimaryPlatform(p); toast(`${p === 'steam' ? 'Steam' : 'PlayStation'} stats lead your Squad row now`, 'success') }
    catch { toast("Couldn't save. Try again.", 'error') }
    finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['account', 'steam'] })
      void qc.invalidateQueries({ queryKey: ['squad'] })
    }
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = current === 'psn' ? 'steam' : 'psn'
    void pick(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-platform="${next}"]`)?.focus()
  }
  return (
    <div>
      <span className="field-label" id="primary-stats-l">Main stats on Squad</span>
      <div className="seg" role="radiogroup" aria-labelledby="primary-stats-l" aria-busy={busy || undefined} onKeyDown={onKey}>
        {PRIMARY_OPTS.map((o) => {
          const on = current === o.id
          return (
            <button key={o.id} type="button" role="radio" className="seg-tab" data-platform={o.id} aria-checked={on}
              data-state={on ? 'active' : 'inactive'} tabIndex={on ? 0 : -1} onClick={() => void pick(o.id)}>
              {o.name}
            </button>
          )
        })}
      </div>
      <p className="meta" style={{ marginTop: 'var(--space-1)' }}>Picks the badge, level and last game on your row. If you're in a game on the other one, that still shows.</p>
    </div>
  )
}

function SteamTab() {
  const qc = useQueryClient()
  const q = useSteamStatus()
  const [blocked, setBlocked] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (e.data === 'steam_linked') toast('Steam connected', 'success')
      else if (e.data === 'steam_failed') toast("Steam didn't connect. Try again.", 'error')
      else return
      void qc.invalidateQueries({ queryKey: ['account', 'steam'] })
      void qc.invalidateQueries({ queryKey: ['steam-squad'] })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [qc])

  function connect() {
    const w = window.open(STEAM_CONNECT, 'steam_openid', 'width=800,height=760,menubar=no,toolbar=no')
    setBlocked(!w)
  }
  async function unlink() {
    setBusy(true)
    try { await unlinkSteam(); toast('Steam disconnected', 'success') }
    catch { toast("Couldn't disconnect. Try again.", 'error') }
    finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['account', 'steam'] })
      void qc.invalidateQueries({ queryKey: ['steam-squad'] })
    }
  }

  return (
    <section className="glass settings-card" aria-labelledby="steam-h">
      <h2 className="section-h2" id="steam-h">Steam</h2>
      {q.isPending ? <SkeletonRows n={1} />
        : q.isError ? <ErrorStrip text="Couldn't load your Steam status" onRetry={() => q.refetch()} />
        : q.data.linked ? (
          <>
            <div className="acct-status">
              {q.data.avatar
                ? <img className="av" src={q.data.avatar} alt="" referrerPolicy="no-referrer" style={{ width: 40, height: 40 }} />
                : <span className="acct-status-emoji" aria-hidden="true">🕹️</span>}
              <span className="acct-row-text">
                <span className="acct-row-title">{q.data.persona_name ?? 'Steam account'}</span>
                <span className="meta">
                  {q.data.profile_url ? <a href={q.data.profile_url} target="_blank" rel="noopener noreferrer">View Steam profile</a> : `SteamID ${q.data.steam_id}`}
                </span>
              </span>
              <span className="badge" data-tone="live">Linked</span>
            </div>
            <PrimaryStatsControl />
            {q.data.games_private ? (
              <p className="settings-note" role="note">
                Steam is hiding your games, so your hours and library don't count on Squad yet. In Steam, open
                {' '}<a href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noopener noreferrer">Privacy Settings</a>{' '}
                and set <b>Game details</b> to <b>Public</b>. It shows up here within 30 minutes.
              </p>
            ) : <p className="settings-note" role="note">Your games and hours only show on Squad if your Steam profile's game details are public.</p>}
            <div><button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</button></div>
          </>
        ) : (
          <>
            <p className="dim">Not linked. Sign in with Steam so the squad can see when you're on and what you're playing.</p>
            {q.data.connect_available
              ? <div><button type="button" className="btn btn-primary" onClick={connect}><Icon name="link" />Sign in with Steam</button></div>
              : <p className="settings-note" role="note">Steam isn't switched on for this server yet.</p>}
            {blocked && <p className="field-err" role="alert">The pop-up was blocked. Allow pop-ups, or <a href={STEAM_CONNECT} target="_blank" rel="noopener">open the Steam sign-in</a>.</p>}
            <p className="meta">Steam only tells us your SteamID. We never see your password.</p>
          </>
        )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm}
        title="Disconnect Steam?"
        body={<p>You'll drop off the Steam card on Squad until you sign in again.</p>}
        action="Disconnect"
        onConfirm={() => void unlink()}
      />
    </section>
  )
}

// ── Mattermost (ST-08) ───────────────────────────────────────────────────────
const MM_CONNECT = '/auth/settings/mattermost/connect'

function MattermostTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['account', 'mm'], queryFn: ({ signal }) => getJSON<MmStatus>('/auth/settings/mattermost', signal) })
  const [blocked, setBlocked] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data === 'mm_linked') {
        toast('Mattermost connected', 'success')
        void qc.invalidateQueries({ queryKey: ['account', 'mm'] })
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [qc])

  function connect() {
    const w = window.open(MM_CONNECT, 'mm_oauth', 'width=600,height=700,menubar=no,toolbar=no')
    setBlocked(!w)
  }
  async function unlink() {
    setBusy(true)
    try { await unlinkMattermost(); toast('Mattermost disconnected', 'success') }
    catch (e) { toast(failText(e, "Couldn't disconnect. Try again."), 'error') }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: ['account', 'mm'] }) }
  }

  return (
    <section className="glass settings-card" aria-labelledby="mm-h">
      <h2 className="section-h2" id="mm-h">Mattermost</h2>
      {q.isPending ? <SkeletonRows n={1} />
        : q.isError ? <ErrorStrip text={q.error instanceof ApiError && q.error.status === 503 ? 'Mattermost is not set up on the server' : "Couldn't load Mattermost"} onRetry={() => q.refetch()} />
        : q.data.linked ? (
          <>
            <div className="acct-status">
              <span className="acct-status-emoji" aria-hidden="true">💬</span>
              <span className="acct-row-text">
                <span className="acct-row-title">Connected</span>
                <span className="meta">Since {fmtDate(q.data.linked_at)}. The assistant can post as you.</span>
              </span>
              <span className="badge" data-tone="live">Active</span>
            </div>
            <div><button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)} disabled={busy}>{busy ? 'Disconnecting…' : 'Disconnect'}</button></div>
          </>
        ) : (
          <>
            <p className="dim">Not connected. Link your Mattermost account so the assistant can send messages as you.</p>
            {q.data.connect_available
              ? <div><button type="button" className="btn btn-primary" onClick={connect}><Icon name="link" />Connect Mattermost</button></div>
              : <p className="settings-note" role="note">Connecting isn't switched on for this server yet.</p>}
            {blocked && <p className="field-err" role="alert">The pop-up was blocked. Allow pop-ups, or <a href={MM_CONNECT} target="_blank" rel="noopener">open the connect page</a>.</p>}
            <p className="meta">It opens in a pop-up, so a call you're in keeps going.</p>
          </>
        )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm}
        title="Disconnect Mattermost?"
        body={<p>The assistant won't be able to post as you until you connect again.</p>}
        action="Disconnect"
        onConfirm={() => void unlink()}
      />
    </section>
  )
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────
// Your WhatsApp messages count for you once your WhatsApp name is linked. Send the bot the
// message below: its one-time code is what tells it the name is yours (wa_link.py).
type WaLink = { names: string[]; bot: string; code: string; message: string; expires_in: number }

function WhatsappTab() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['account', 'whatsapp'],
    queryFn: ({ signal }) => getJSON<WaLink>('/api/settings/whatsapp', signal),
    refetchInterval: 5000,   // the bot links you in the background: show it when it does
  })
  const seen = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [drop, setDrop] = useState('')
  const n = q.data?.names.length
  useEffect(() => {
    if (n === undefined) return
    if (seen.current !== null && n > seen.current) toast('WhatsApp linked', 'success')
    seen.current = n
  }, [n])

  async function copy() {
    if (!q.data) return
    try { await navigator.clipboard.writeText(q.data.message); setCopied(true); window.setTimeout(() => setCopied(false), 2000) }
    catch { toast('Copy was blocked. Select the text and copy it.', 'warning') }
  }
  async function unlink(name: string) {
    try {
      await request('/api/settings/whatsapp/unlink', { body: { name } })
      toast(`“${name}” isn't linked any more`, 'success')
    } catch (e) { toast(failText(e, "Couldn't unlink. Try again."), 'error') }
    finally { void qc.invalidateQueries({ queryKey: ['account', 'whatsapp'] }) }
  }

  return (
    <section className="glass settings-card" aria-labelledby="wa-h">
      <h2 className="section-h2" id="wa-h">WhatsApp</h2>
      {q.isPending ? <SkeletonRows n={2} />
        : q.isError ? <ErrorStrip text="Couldn't load WhatsApp" onRetry={() => q.refetch()} />
        : (
          <>
            {q.data.names.length ? (
              <div className="acct-status">
                <span className="acct-status-emoji" aria-hidden="true">🟢</span>
                <span className="acct-row-text">
                  <span className="acct-row-title">Linked</span>
                  <span className="meta">Messages from these WhatsApp names count as yours.</span>
                </span>
                <span className="badge" data-tone="live">Active</span>
              </div>
            ) : (
              <p className="dim">Not linked yet, so your WhatsApp messages don't count for you in Squad stats or the assistant.</p>
            )}
            {q.data.names.length > 0 && (
              <ul className="wa-names" aria-label="Linked WhatsApp names">
                {q.data.names.map((name) => (
                  <li key={name} className="chip wa-name">{name}
                    <button type="button" className="icon-btn" onClick={() => setDrop(name)} aria-label={`Unlink ${name}`}><Icon name="close" /></button>
                  </li>
                ))}
              </ul>
            )}
            <ol className="steps-plain">
              <li>Copy this message.</li>
              <li>Send it in the CRCMZ WhatsApp group, or straight to {q.data.bot}. Tagging the bot is optional: the code is what it looks for.</li>
              <li>The bot answers “Linked”, and it shows up here.</li>
            </ol>
            <div className="code-block">
              <pre aria-label="Message to send on WhatsApp" tabIndex={0}>{q.data.message}</pre>
              <button type="button" className="btn btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <div className="wa-acts">
              <a className="btn btn-primary" href={`https://wa.me/?text=${encodeURIComponent(q.data.message)}`} target="_blank" rel="noopener"><Icon name="send" />Open in WhatsApp</a>
            </div>
            <p className="meta">The code ({q.data.code}) is what proves it's you. It works once, for the next {Math.max(1, Math.round(q.data.expires_in / 60))} minutes. Posting under another name too? Send it again from there.</p>
          </>
        )}
      <ConfirmDialog
        open={!!drop} onOpenChange={(v) => { if (!v) setDrop('') }}
        title="Unlink this WhatsApp name?" action="Unlink"
        body={<p>Messages from “{drop}” won't count as yours any more.</p>}
        onConfirm={() => { const d = drop; setDrop(''); if (d) void unlink(d) }}
      />
    </section>
  )
}

// ── MCP (ST-09) ──────────────────────────────────────────────────────────────
function McpTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['account', 'mcp'], queryFn: ({ signal }) => getJSON<McpStatus>('/auth/settings/mcp', signal) })
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try { await navigator.clipboard.writeText(MCP_CONFIG); setCopied(true); window.setTimeout(() => setCopied(false), 2000) }
    catch { toast('Copy was blocked. Select the text and copy it.', 'warning') }
  }
  async function revoke() {
    setBusy(true)
    try { await revokeMcp(); toast('MCP access revoked', 'success') }
    catch { toast("Couldn't revoke. Try again.", 'error') }
    finally { setBusy(false); void qc.invalidateQueries({ queryKey: ['account', 'mcp'] }) }
  }

  return (
    <section className="glass settings-card" aria-labelledby="mcp-h">
      <div className="settings-card-head">
        <h2 className="section-h2" id="mcp-h">MCP</h2>
        <button type="button" className="btn btn-ghost" onClick={() => q.refetch()} disabled={q.isFetching}><Icon name="refresh" />{q.isFetching ? 'Checking…' : 'Refresh'}</button>
      </div>
      {q.isPending ? <SkeletonRows n={1} />
        : q.isError ? <ErrorStrip text="Couldn't load MCP status" onRetry={() => q.refetch()} />
        : q.data.active ? (
          <>
            <div className="acct-status">
              <span className="acct-status-emoji" aria-hidden="true">🤖</span>
              <span className="acct-row-text">
                <span className="acct-row-title">Connected</span>
                <span className="meta">An MCP client can act for you. Last used {fmtDateTime(q.data.last_used_at)}.</span>
              </span>
              <span className="badge" data-tone="live">Active</span>
            </div>
            <div><button type="button" className="btn btn-danger" onClick={() => setConfirm(true)} disabled={busy}>{busy ? 'Revoking…' : 'Revoke access'}</button></div>
          </>
        ) : (
          <>
            <p className="dim">Not connected. Hook Claude (or any MCP client) up to the squad.</p>
            <ol className="steps-plain">
              <li>Add the config below to your MCP client (Claude Desktop: <code>claude_desktop_config.json</code>).</li>
              <li>Restart the client. It opens a browser window by itself.</li>
              <li>Sign in with your CRCMZ account and tap <b>Allow</b>.</li>
              <li>Come back here and tap Refresh.</li>
            </ol>
            <div className="code-block">
              <pre aria-label="Claude Desktop config" tabIndex={0}>{MCP_CONFIG}</pre>
              <button type="button" className="btn btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </>
        )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm}
        title="Revoke MCP access?"
        body={<p>Every connected client stops working right away. You can connect again later.</p>}
        action="Revoke access"
        onConfirm={() => void revoke()}
      />
    </section>
  )
}

// ── Watch (this device) ──────────────────────────────────────────────────────
function WatchTab() {
  return (
    <section className="glass settings-card" aria-labelledby="st-watch-h">
      <h2 className="section-h2" id="st-watch-h">Watch Party</h2>
      <p className="dim">Where the camera orbs sit: above the video, below it, or on it along the top, the bottom or the side. Saved on this device; you can also change it on the Watch page.</p>
      <OrbPosControl id="st-orbpos" />
    </section>
  )
}

// ── App: install + notifications ─────────────────────────────────────────────
function AppTab() {
  return (
    <>
      <TabBarCard />
      <InstallCard />
      <NotificationsCard />
      {!nativeShell() && <ClassicCard />}
    </>
  )
}

/** app.crcmz.me opens this app; anyone who'd rather have the classic dashboard there can
 *  switch (a cookie, per browser; server.py /view/classic). The phone apps always open this app. */
function ClassicCard() {
  return (
    <section className="glass settings-card" aria-labelledby="st-classic-h">
      <h2 className="section-h2" id="st-classic-h">Classic dashboard</h2>
      <p className="meta">app.crcmz.me opens this app. The classic dashboard is still at <a href="/dashboard">app.crcmz.me/dashboard</a>;
        switch to make it what app.crcmz.me opens in this browser. A button on it brings you back.</p>
      <a className="btn btn-secondary" href="/view/classic">Use the classic dashboard</a>
    </section>
  )
}

// ── Tab bar: the three pages in the phone's bottom bar ───────────────────────
const SLOT_NAMES = ['first', 'second', 'fourth'] as const
function TabBarCard() {
  const tabs = useTabs()
  const [slot, setSlot] = useState(0)
  const { hash } = useLocation()
  const card = useRef<HTMLElement>(null)
  // "Change the tab bar" in the More sheet lands here.
  useEffect(() => { if (hash === '#tabbar') card.current?.scrollIntoView({ block: 'start' }) }, [hash])
  const picked = tabs[slot]!
  const slotBtn = (i: number) => {
    const d = DESTS[tabs[i]!]
    return (
      <button
        key={i} type="button" className="tb-prev-slot" aria-pressed={slot === i} onClick={() => setSlot(i)}
        aria-label={`Change the ${SLOT_NAMES[i]} button, now ${d.label}`}
      >
        <Icon name={d.icon} /><span>{d.label}</span>
      </button>
    )
  }
  return (
    <section className="glass settings-card tb-card" id="tabbar" ref={card} aria-labelledby="st-tabbar-h">
      <div className="settings-card-head">
        <h2 className="section-h2" id="st-tabbar-h">Tab bar</h2>
        {!isDefaultTabs(tabs) && <button type="button" className="btn btn-ghost" onClick={() => { resetTabs(); setSlot(0) }}>Reset</button>}
      </div>
      <p className="dim">Pick the three pages you use most for the bar at the bottom of your phone. Ask AI stays in the middle, and everything else is under More. Saved on this device.</p>
      <div className="tb-prev" role="group" aria-label="Your tab bar">
        {slotBtn(0)}
        {slotBtn(1)}
        <span className="tb-prev-ask" aria-hidden="true"><span className="tab-ask-orb"><Icon name="aiChat" /></span><span>Ask AI</span></span>
        {slotBtn(2)}
        <span className="tb-prev-more" aria-hidden="true"><Icon name="more" /><span>More</span></span>
      </div>
      <p className="tb-step" id="tb-pick-h">Tap a button above, then pick what goes there:</p>
      <ul className="tb-choices" aria-labelledby="tb-pick-h">
        {TAB_CHOICES.map((id) => {
          const d = DESTS[id]
          const at = tabs.indexOf(id)
          return (
            <li key={id}>
              <button
                type="button" className="tb-choice" aria-pressed={id === picked}
                onClick={() => setTab(slot, id)}
              >
                <Icon name={d.icon} />
                <span className="tb-choice-text">
                  {d.label}
                  {at >= 0 && at !== slot && <span className="tb-choice-note">In the bar</span>}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="meta">Picking a page that's already in the bar swaps the two.</p>
    </section>
  )
}

function InstallCard() {
  const state = useInstall()
  return (
    <section className="glass settings-card" aria-labelledby="st-app-h">
      <div className="settings-card-head">
        <h2 className="section-h2" id="st-app-h">Install CRCMZ</h2>
        {state === 'prompt' && <button type="button" className="btn btn-primary" onClick={() => { void promptInstall() }}><Icon name="plus" />Install</button>}
      </div>
      {state === 'installed' ? (
        <p className="dim">Installed. CRCMZ opens full screen from your home screen, with lock-screen controls for music and calls.</p>
      ) : state === 'ios' ? (
        <>
          <p className="dim">Add it to your Home Screen to get full screen, lock-screen controls and notifications.</p>
          <ol className="steps-plain">
            <li>In Safari, tap <b>Share</b> (the square with the arrow).</li>
            <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            <li>Open CRCMZ from the new icon and sign in once.</li>
          </ol>
        </>
      ) : state === 'prompt' ? (
        <p className="dim">Put CRCMZ on your home screen: full screen, lock-screen controls and notifications.</p>
      ) : (
        <p className="dim">Open app.crcmz.me in Chrome on Android or Safari on iPhone to install it. On a computer, use Chrome or Edge's install button in the address bar.</p>
      )}
    </section>
  )
}

function NotificationsCard() {
  const qc = useQueryClient()
  const cfg = useQuery({ queryKey: ['push', 'config'], queryFn: ({ signal }) => fetchPushConfig(signal) })
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'default'))
  useEffect(() => { void currentSubscription().then((s) => setOn(!!s)).catch(() => setOn(false)) }, [])

  const iosNeedsInstall = isIOS() && !isStandalone()
  const supported = pushSupported()

  async function toggle() {
    setBusy(true)
    try {
      if (on) {
        await disablePush()
        setOn(false)
        toast('Notifications off on this device', 'success')
      } else {
        const r = await enablePush()
        if ('Notification' in window) setPerm(Notification.permission)
        if (r === 'on') { setOn(true); toast('Notifications on', 'success') }
        else if (r === 'denied') toast('Notifications are blocked for CRCMZ', 'error')
        else toast("This browser can't show notifications", 'error')
      }
    } catch {
      toast(on ? "Couldn't turn notifications off" : "Couldn't turn notifications on", 'error')
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['push', 'config'] })
    }
  }
  async function test() {
    try {
      const r = await sendTestPush()
      toast(r.delivered ? 'Sent. It should pop up in a moment.' : 'Nothing was delivered. Turn notifications off and on again.', r.delivered ? 'success' : 'error')
    } catch (e) {
      toast(e instanceof ApiError && e.status === 429 ? 'Wait a minute before the next test' : "Couldn't send a test", 'error')
    }
  }
  async function setPref(id: string, value: boolean) {
    qc.setQueryData(['push', 'config'], (d: typeof cfg.data) => (d ? { ...d, prefs: { ...d.prefs, [id]: value } } : d))
    try {
      await savePushPrefs({ [id]: value })
    } catch {
      toast("Couldn't save that", 'error')
      void qc.invalidateQueries({ queryKey: ['push', 'config'] })
    }
  }

  return (
    <section className="glass settings-card" aria-labelledby="st-push-h">
      <div className="settings-card-head">
        <h2 className="section-h2" id="st-push-h">Notifications</h2>
        {supported && !iosNeedsInstall && perm !== 'denied' && on !== null && (
          <button type="button" className={on ? 'btn btn-secondary' : 'btn btn-primary'} onClick={toggle} disabled={busy}>
            {busy ? 'One moment…' : on ? 'Turn off here' : 'Turn on'}
          </button>
        )}
      </div>
      <p className="dim">Squad Up rallies, parties and huddles starting, giveaways, new clips, @mentions and new movies. You choose which below; they apply to every device you turn on. Every one also lands in <Link to="/notifications">Notifications</Link>, where you can switch on WhatsApp and Mattermost DMs for @mentions and new movies. Switching movies off here stops their DMs too.</p>
      {iosNeedsInstall ? (
        <p className="settings-note" role="note">On iPhone, notifications only work in the installed app. Add CRCMZ to your Home Screen (above), open it from there, then turn them on.</p>
      ) : !supported ? (
        <p className="settings-note" role="note">This browser can't show notifications.</p>
      ) : perm === 'denied' ? (
        <p className="settings-note" role="note">Notifications are blocked for CRCMZ. Allow them in your browser or phone settings, then come back.</p>
      ) : null}
      {cfg.isPending ? <SkeletonRows n={3} />
        : cfg.isError ? <ErrorStrip text="Couldn't load your notification choices" onRetry={() => cfg.refetch()} />
        : (
          <fieldset className="push-cats" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="meta" style={{ padding: 0, marginBottom: 'var(--space-2)' }}>Tell me when</legend>
            {cfg.data.categories.map((c) => (
              <label key={c.id} className="check-row">
                <input type="checkbox" checked={cfg.data.prefs[c.id] !== false} onChange={(e) => { void setPref(c.id, e.target.checked) }} />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}
      {on && <div><button type="button" className="btn btn-secondary" onClick={test}><Icon name="megaphone" />Send me a test</button></div>}
      {cfg.data && <p className="meta">{cfg.data.devices === 0 ? 'No devices yet.' : cfg.data.devices === 1 ? 'On for 1 device.' : `On for ${cfg.data.devices} devices.`}</p>}
    </section>
  )
}
