// PS-10 · Settings: sign-in methods, PSN status and connected apps. Each tab is a
// sub-route (/app/settings/<tab>), so tabs deep-link and Back works.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import * as Tabs from '@radix-ui/react-tabs'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { ConfirmDialog } from '../clips/ClipSheet'
import { ClaimList } from '../portal/Claim'
import { OrbPosControl } from '../watch/WatchPage'
import { ApiError, getJSON } from '../../lib/http'
import {
  addPasskey, changePassword, fmtDate, fmtDateTime, MCP_CONFIG, passkeysSupported, removePasskey, revokeMcp, tokenState,
  unlinkMattermost, type McpStatus, type MmStatus, type Passkey, type PsnStatus,
} from '../../lib/account'

const TABS = [
  { id: 'passkeys', label: 'Passkeys' },
  { id: 'security', label: 'Password' },
  { id: 'psn', label: 'PSN' },
  { id: 'mattermost', label: 'Mattermost' },
  { id: 'mcp', label: 'MCP' },
  { id: 'watch', label: 'Watch' },
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
      <h1 className="page-h1" tabIndex={-1}>Settings</h1>
      <Tabs.Root value={tab} onValueChange={(t) => nav(`/settings/${t}`)} activationMode="manual">
        <Tabs.List className="tabstrip" aria-label="Settings sections">
          {TABS.map((t) => <Tabs.Trigger key={t.id} value={t.id} className="tabstrip-tab">{t.label}</Tabs.Trigger>)}
        </Tabs.List>
        <Tabs.Content value="passkeys" className="settings-panel"><PasskeysTab /></Tabs.Content>
        <Tabs.Content value="security" className="settings-panel"><SecurityTab /></Tabs.Content>
        <Tabs.Content value="psn" className="settings-panel"><PsnTab /></Tabs.Content>
        <Tabs.Content value="mattermost" className="settings-panel"><MattermostTab /></Tabs.Content>
        <Tabs.Content value="mcp" className="settings-panel"><McpTab /></Tabs.Content>
        <Tabs.Content value="watch" className="settings-panel"><WatchTab /></Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

const failText = (e: unknown, fallback: string) => (e instanceof ApiError && e.status === 503 ? 'Sign-in service is not set up right now' : fallback)

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
      <p className="dim">Where the camera orbs sit: above the video, below it, or over it in a corner. Saved on this device; you can also change it on the Watch page.</p>
      <OrbPosControl id="st-orbpos" />
    </section>
  )
}
