// PS-11 · Admin: service health, the clip queue, PSN tokens and users in one place.
// Gated on /api/admin/check; health, status and jobs poll every 30 s.
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { ShellContext } from '../../app/Shell'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows, StaleMarker, useStale } from '../../components/states'
import { toast } from '../../components/toast'
import { ApiError, getJSON } from '../../lib/http'
import {
  fmtDate, inviteMember, resetUserPassword, type Invite, tokenState, type AdminUser, type OpsStatus, type PipelineHealth, type PsnAccount, type PsnStatus,
  type VideoJobs,
} from '../../lib/account'
import { HelpLink } from '../../components/HelpLink'

const POLL_MS = 30_000
const SERVICES: [string, string][] = [['psn_messenger', 'CRCMZ app'], ['psn_montage', 'Montage builder'], ['wa_bridge', 'WhatsApp bridge']]

export function AdminPage() {
  useTitle('Admin')
  const { isAdmin, adminKnown } = useOutletContext<ShellContext>()
  const users = useQuery({
    queryKey: ['admin', 'users'], enabled: isAdmin,
    queryFn: ({ signal }) => getJSON<{ users: AdminUser[] }>('/api/admin/users', signal),
  })
  const denied = users.error instanceof ApiError && users.error.status === 403

  if (!isAdmin || denied) return <Forbidden known={adminKnown || denied} />
  return (
    <div className="page">
      <h1 className="page-h1" tabIndex={-1}>Admin<HelpLink id="admin" /></h1>
      <div className="admin-cards">
        <Health />
        <Ops />
        <Jobs />
      </div>
      <div className="admin-lists">
        <PsnAccounts />
        <Users q={users} />
        <Invites />
      </div>
      <section className="glass admin-card" aria-labelledby="ad-sc">
        <h2 className="section-h2" id="ad-sc">Shortcuts</h2>
        <div className="step-actions">
          <Link className="btn btn-secondary" to="/giveaway"><Icon name="giveaway" />Giveaway admin</Link>
          <Link className="btn btn-secondary" to="/clips"><Icon name="clips" />Everyone's reels</Link>
          <Link className="btn btn-secondary" to="/whatsapp#wa-import"><Icon name="chat" />WhatsApp import</Link>
        </div>
      </section>
    </div>
  )
}

function Forbidden({ known }: { known: boolean }) {
  return (
    <div className="page page-reading">
      <h1 className="page-h1" tabIndex={-1}>Admin<HelpLink id="admin" /></h1>
      {known ? (
        <section className="glass handoff">
          <p className="handoff-lede">Admins only</p>
          <p className="dim">This page is for the squad admin. Everything else is one tap away.</p>
          <Link className="btn btn-secondary" to="/">Back to Squad</Link>
        </section>
      ) : (
        <section className="glass handoff" aria-busy="true"><div className="skeleton" style={{ height: 20, width: '60%' }} /></section>
      )}
    </div>
  )
}

function CardHead({ id, title, q }: { id: string; title: string; q: UseQueryResult<unknown> }) {
  const { stale, minutes } = useStale(q, POLL_MS)
  return (
    <div className="settings-card-head">
      <h2 className="section-h2" id={id}>{title}</h2>
      {stale && <StaleMarker minutes={minutes} onRetry={() => q.refetch()} />}
    </div>
  )
}

/** First load failed: an error with Retry. A later poll failure keeps the data and goes stale. */
function Body<T>({ q, n = 3, label, children }: { q: UseQueryResult<T>; n?: number; label: string; children: (d: T) => ReactNode }) {
  if (q.data !== undefined) return <>{children(q.data)}</>
  if (q.isError) return <ErrorStrip text={`Couldn't load ${label}`} onRetry={() => q.refetch()} />
  return <SkeletonRows n={n} height={40} />
}

function Health() {
  const q = useQuery({ queryKey: ['admin', 'health'], queryFn: ({ signal }) => getJSON<PipelineHealth>('/api/pipeline-status', signal), refetchInterval: POLL_MS })
  return (
    <section className="glass admin-card" aria-labelledby="ad-h">
      <CardHead id="ad-h" title="Health" q={q} />
      <Body q={q} label="service health">
        {(d) => (
          <ul className="rows">
            {SERVICES.map(([k, name]) => {
              const s = d.services?.[k]
              const st = s?.status ?? 'down'
              return (
                <li key={k} className="svc-row" data-status={st}>
                  <span className="svc-dot" aria-hidden="true" />
                  <span className="svc-name">{name}</span>
                  <span className="svc-state">{st === 'ok' ? 'OK' : st === 'error' ? 'Error' : 'Unreachable'}</span>
                  <span className="meta num">{s?.ms != null && st !== 'down' ? `${s.ms} ms` : '—'}</span>
                </li>
              )
            })}
          </ul>
        )}
      </Body>
    </section>
  )
}

function Ops() {
  const q = useQuery({ queryKey: ['admin', 'status'], queryFn: ({ signal }) => getJSON<OpsStatus>('/status', signal), refetchInterval: POLL_MS })
  return (
    <section className="glass admin-card" aria-labelledby="ad-o">
      <CardHead id="ad-o" title="Ops snapshot" q={q} />
      <Body q={q} label="the ops snapshot">
        {(d) => (
          <dl className="meta-list">
            <dt>PSN</dt><dd data-warn={d.psn !== 'connected'}>{d.psn}</dd>
            <dt>WhatsApp</dt><dd data-warn={d.whatsapp !== 'configured'}>{d.whatsapp.replace('_', ' ')}</dd>
            <dt>Clip store</dt><dd>{d.clip_store}</dd>
            <dt>Groups watched</dt><dd className="num">{d.groups}</dd>
            <dt>Clips</dt><dd className="num">{d.clips_total.toLocaleString()} total · {d.clips_delivered.toLocaleString()} delivered · {d.clips_archived.toLocaleString()} archived</dd>
            <dt>Failed</dt><dd className="num" data-warn={d.clips_failed > 0}>{d.clips_failed.toLocaleString()}</dd>
          </dl>
        )}
      </Body>
    </section>
  )
}

function Jobs() {
  const q = useQuery({ queryKey: ['admin', 'jobs'], queryFn: ({ signal }) => getJSON<VideoJobs>('/api/video-jobs', signal), refetchInterval: POLL_MS })
  return (
    <section className="glass admin-card" aria-labelledby="ad-j">
      <CardHead id="ad-j" title="Job queue" q={q} />
      <Body q={q} label="the job queue">
        {(d) => (
          <>
            <p className="admin-queue" data-busy={d.queue_depth > 0}>{d.queue_depth > 0 ? <><b className="num">{d.queue_depth}</b> waiting to forward</> : 'Queue is clear'}</p>
            <dl className="kpis kpis-2">
              <div><dt>Active</dt><dd className="num">{(d.stats.active ?? 0).toLocaleString()}</dd></div>
              <div><dt>Failed</dt><dd className="num">{(d.stats.failed ?? 0).toLocaleString()}</dd></div>
            </dl>
          </>
        )}
      </Body>
    </section>
  )
}

const RANK = { expired: 0, expiring: 1, unknown: 2, active: 3 } as const

function PsnAccounts() {
  const q = useQuery({ queryKey: ['account', 'psn'], queryFn: ({ signal }) => getJSON<PsnStatus>('/auth/settings/psn', signal) })
  const list = [...(q.data?.users ?? [])]
    .map((u) => ({ u, st: tokenState({ refresh_expires_at: u.refresh_expires_at }) }))
    .sort((a, b) => RANK[a.st.kind] - RANK[b.st.kind] || (a.u.refresh_expires_at ?? 0) - (b.u.refresh_expires_at ?? 0))
  return (
    <section className="glass admin-card" aria-labelledby="ad-p">
      <div className="settings-card-head">
        <h2 className="section-h2" id="ad-p">PSN accounts{list.length ? <span className="meta num"> · {list.length}</span> : null}</h2>
        <button type="button" className="icon-btn" onClick={() => q.refetch()} aria-label="Refresh PSN accounts" disabled={q.isFetching}><Icon name="refresh" /></button>
      </div>
      <Body q={q} label="PSN accounts">
        {() => list.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No one has linked PSN yet</p>
            <p className="dim">Send the squad the Link PSN page.</p>
            <Link className="btn btn-secondary" to="/portal"><Icon name="link" />Open Link PSN</Link>
          </div>
        ) : (
          <ul className="rows acct-rows">
            {list.map(({ u, st }, i) => <PsnRow key={`${u.account_id ?? u.online_id}-${i}`} u={u} label={st.label} kind={st.kind} />)}
          </ul>
        )}
      </Body>
    </section>
  )
}

function PsnRow({ u, label, kind }: { u: PsnAccount; label: string; kind: string }) {
  return (
    <li className="acct-row">
      <span className="acct-row-text">
        <span className="acct-row-title">{u.online_id ?? 'Unnamed'}</span>
        <span className="meta">
          {u.mm_username ? `@${u.mm_username} · ` : ''}{u.zitadel_user_id ? 'claimed' : 'unclaimed'} · linked {fmtDate(u.linked_at)}
          {u.refresh_expires_at ? ` · runs out ${fmtDate(u.refresh_expires_at)}` : ''}
        </span>
      </span>
      <span className="badge" data-tone={kind === 'active' ? 'live' : 'warn'}>{label}</span>
    </li>
  )
}

function Users({ q }: { q: UseQueryResult<{ users: AdminUser[] }> }) {
  const [who, setWho] = useState<AdminUser | null>(null)
  const down = q.error instanceof ApiError && (q.error.status === 502 || q.error.status === 503)
  const list = q.data?.users ?? []
  return (
    <section className="glass admin-card" aria-labelledby="ad-u">
      <div className="settings-card-head">
        <h2 className="section-h2" id="ad-u">Users{list.length ? <span className="meta num"> · {list.length}</span> : null}</h2>
        <button type="button" className="icon-btn" onClick={() => q.refetch()} aria-label="Refresh users" disabled={q.isFetching}><Icon name="refresh" /></button>
      </div>
      {q.data === undefined && q.isError ? <ErrorStrip text={down ? "Sign-in service didn't answer" : "Couldn't load users"} onRetry={() => q.refetch()} />
        : q.data === undefined ? <SkeletonRows n={3} height={40} />
        : list.length === 0 ? <ErrorStrip text="No users returned" onRetry={() => q.refetch()} />
        : (
          <ul className="rows acct-rows">
            {list.map((u) => (
              <li key={u.userId} className="acct-row">
                <span className="acct-row-text">
                  <span className="acct-row-title">{u.displayName || u.userName}</span>
                  <span className="meta">{u.email || u.userName}{u.state && !/ACTIVE/i.test(u.state) ? ` · ${u.state.replace(/^USER_STATE_/, '').toLowerCase()}` : ''}</span>
                </span>
                <button type="button" className="btn btn-ghost" onClick={() => setWho(u)} aria-label={`Reset password for ${u.displayName || u.userName}`}>Reset password</button>
              </li>
            ))}
          </ul>
        )}
      <ResetDialog user={who} onClose={() => setWho(null)} />
    </section>
  )
}

function ResetDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [pw, setPw] = useState('')
  const [conf, setConf] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const name = user ? user.displayName || user.userName : ''
  const short = touched && pw.length > 0 && pw.length < 8
  const mismatch = touched && conf.length > 0 && conf !== pw

  function close() { setPw(''); setConf(''); setTouched(false); setErr(''); onClose() }
  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!user || pw.length < 8 || conf !== pw) return
    setBusy(true)
    setErr('')
    try {
      await resetUserPassword(user.userId, pw)
      toast(`Password reset for ${name}`, 'success')
      close()
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 403 ? 'Admins only.' : e2 instanceof ApiError && e2.detail ? e2.detail : "Couldn't reset it. Try again.")
    } finally { setBusy(false) }
  }

  return (
    <Dialog.Root open={user !== null} onOpenChange={(v) => { if (!v) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="rp-desc">
          <Dialog.Title className="dialog-title">Reset {name}'s password</Dialog.Title>
          <p id="rp-desc" className="dim">They'll sign in with this new password. Tell them yourself; nothing is sent.</p>
          <form className="form-stack" onSubmit={submit} noValidate>
            <div>
              <label className="field-label" htmlFor="rp-new">New password</label>
              <input id="rp-new" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)}
                onBlur={() => setTouched(true)} aria-invalid={short} aria-describedby="rp-hint" />
              <p className={short ? 'field-err' : 'field-hint'} id="rp-hint">At least 8 characters.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="rp-conf">Type it again</label>
              <input id="rp-conf" className="input" type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)}
                onBlur={() => setTouched(true)} aria-invalid={mismatch} aria-describedby={mismatch ? 'rp-conf-err' : undefined} />
              {mismatch && <p className="field-err" id="rp-conf-err">Doesn't match</p>}
            </div>
            {err && <p className="field-err" role="alert">{err}</p>}
            <div className="dialog-actions">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={busy || !pw || !conf}>{busy ? 'Resetting…' : `Reset ${name}'s password`}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Invites() {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ['admin', 'invites'],
    queryFn: ({ signal }) => getJSON<{ invites: Invite[] }>('/api/invites/vip?limit=15', signal),
  })
  const list = q.data?.invites ?? []
  return (
    <section className="glass admin-card" aria-labelledby="ad-inv">
      <div className="settings-card-head">
        <h2 className="section-h2" id="ad-inv">Invites</h2>
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" />Invite member</button>
      </div>
      <p className="dim">They get an email, pick their username and password, and that name follows them into Mattermost and the PSN link.</p>
      {q.data === undefined && q.isError ? <ErrorStrip text="Couldn't load invites" onRetry={() => q.refetch()} />
        : q.data === undefined ? <SkeletonRows n={3} height={40} />
        : list.length === 0 ? <p className="meta">No invites sent yet.</p>
        : (
          <ul className="rows acct-rows">
            {list.map((v) => (
              <li key={v.id} className="acct-row">
                <span className="acct-row-text">
                  <span className="acct-row-title">{v.gamer_tag || v.email}{v.mm_username ? <span className="meta"> · @{v.mm_username}</span> : null}</span>
                  <span className="meta">{v.email} · {v.status === 'failed' ? `failed: ${v.error}` : v.status === 'accepted' ? 'joined' : v.kind === 'welcome' ? 'already had an account' : 'waiting'} · {v.source || 'api'} · {fmtDate(Date.parse(v.created_at) / 1000)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      <InviteDialog open={open} onClose={() => { setOpen(false); q.refetch() }} />
    </section>
  )
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [vip, setVip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

  function close() { setEmail(''); setName(''); setVip(false); setErr(''); onClose() }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid) { setErr('Enter a valid email.'); return }
    setBusy(true)
    setErr('')
    try {
      const r = await inviteMember({ email: email.trim(), name: name.trim(), vip })
      toast(r.duplicate ? 'Already invited' : r.kind === 'welcome' ? `${email.trim()} already had an account; sent a heads-up` : `Invite sent to ${email.trim()}`, 'success')
      close()
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 403 ? 'Admins only.' : e2 instanceof ApiError && e2.detail ? e2.detail : "Couldn't send it. Try again.")
    } finally { setBusy(false) }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="inv-desc">
          <Dialog.Title className="dialog-title">Invite a member</Dialog.Title>
          <p id="inv-desc" className="dim">Creates their account and emails a link. They choose their username there.</p>
          <form className="form-stack" onSubmit={submit} noValidate>
            <div>
              <label className="field-label" htmlFor="inv-email">Email</label>
              <input id="inv-email" className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="field-label" htmlFor="inv-name">Name or gamer tag</label>
              <input id="inv-name" className="input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="inv-name-hint" />
              <p className="field-hint" id="inv-name-hint">Optional. Used in the email and to suggest a username.</p>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} /> VIP Clan Member
            </label>
            {err && <p className="field-err" role="alert">{err}</p>}
            <div className="dialog-actions">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={busy || !email}>{busy ? 'Sending…' : 'Send invite'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
