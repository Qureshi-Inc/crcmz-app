// PS-12 · Link PSN: one wizard for the first link, the ~60-day relink and claiming
// an account linked before sign-in. A vertical stepper whose later steps stay
// visible but locked, so the whole path is known up front.
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { ErrorStrip } from '../../components/states'
import { ApiError, NetworkError } from '../../lib/http'
import { fmtDate, linkPsn, tokenState } from '../../lib/account'
import { usePsnStatus } from '../settings/SettingsPage'
import { ClaimList } from './Claim'
import { HelpLink } from '../../components/HelpLink'

const PS_HOME = 'https://www.playstation.com'
const SSO_COOKIE = 'https://ca.account.sony.com/api/v1/ssocookie'

export function PortalPage() {
  useTitle('Link PSN')
  const qc = useQueryClient()
  const q = usePsnStatus()
  // 1 → ①, 2 → ②, 3 → ③. Step 0 (claim) is open on its own whenever it shows.
  const [step, setStep] = useState(1)
  const [done, setDone] = useState<number[]>([])
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [pasteNote, setPasteNote] = useState<string | null>(null)
  const [linked, setLinked] = useState<string | null>(null)

  const d = q.data
  const unclaimed = d && !d.linked ? d.unclaimed ?? [] : []
  const known = q.isSuccess
  const finish = (n: number) => { setDone((x) => (x.includes(n) ? x : [...x, n])); setStep(n + 1) }

  async function paste() {
    setPasteNote(null)
    try {
      const t = await navigator.clipboard.readText()
      if (!t.trim()) { setPasteNote('The clipboard is empty. Copy the token from step ② first.'); return }
      setToken(t.trim())
      setShow(false)
    } catch {
      setPasteNote('Paste it manually (long-press → Paste).')
    }
  }
  async function link(e: FormEvent) {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = await linkPsn(token.trim())
      setToken('')
      setLinked(r.online_id || 'your account')
      void qc.invalidateQueries({ queryKey: ['account', 'psn'] })
      void qc.invalidateQueries({ queryKey: ['squad'] })
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.detail || 'Something went wrong. Try a fresh token.'
        : e2 instanceof NetworkError && e2.timedOut ? "Sony didn't answer in time. Try again in a minute."
        : "Couldn't reach the app. Check your connection.")
    } finally { setBusy(false) }
  }

  if (linked) {
    return (
      <div className="page page-reading">
        <h1 className="page-h1" tabIndex={-1}>Link PSN<HelpLink id="portal" /></h1>
        <section className="glass portal-done" role="status" aria-labelledby="po-done">
          <p className="portal-done-emoji" aria-hidden="true">🎮</p>
          <h2 className="section-h2" id="po-done">Linked as {linked}</h2>
          <p className="dim">You're on the squad board now. Sony asks again in about two months; we'll show it in Settings before it runs out.</p>
          <Link className="btn btn-primary" to="/">See the Squad</Link>
        </section>
      </div>
    )
  }

  return (
    <div className="page page-reading">
      <h1 className="page-h1" tabIndex={-1}>Link PSN<HelpLink id="portal" /></h1>
      <StatusCard q={q} />
      <ol className="stepper" aria-label="Link your PSN account">
        {unclaimed.length > 0 && (
          <Step n={0} label="0" title="Already linked? Claim it" state="open">
            <p className="dim">Someone linked these before sign-in existed. If one is yours, claim it and you're done.</p>
            <ClaimList items={unclaimed} />
            <p className="meta">Not on the list? Carry on below.</p>
          </Step>
        )}
        <Step n={1} label="1" title="Sign in at PlayStation" state={!known ? 'locked' : step === 1 ? 'open' : done.includes(1) ? 'done' : 'locked'} onReopen={() => setStep(1)}>
          <p className="dim">Open playstation.com in a new tab and sign in with the account you play on.</p>
          <div className="step-actions">
            <a className="btn btn-primary" href={PS_HOME} target="_blank" rel="noopener noreferrer" onClick={() => finish(1)}><Icon name="external" />Open playstation.com</a>
            <button type="button" className="btn btn-ghost" onClick={() => finish(1)}>I'm already signed in</button>
          </div>
        </Step>
        <Step n={2} label="2" title="Copy your token" state={!known ? 'locked' : step === 2 ? 'open' : done.includes(2) ? 'done' : 'locked'} onReopen={() => setStep(2)}>
          <p className="dim">This page shows a line like <code>{'{"npsso":"…"}'}</code>. Copy the long code between the quotes (copying the whole line works too).</p>
          <div className="step-actions">
            <a className="btn btn-primary" href={SSO_COOKIE} target="_blank" rel="noopener noreferrer" onClick={() => finish(2)}><Icon name="external" />Get my token</a>
            <button type="button" className="btn btn-ghost" onClick={() => finish(2)}>I've copied it</button>
          </div>
          <p className="meta">The token is a password for your PSN account. Paste it here only, and never share it.</p>
        </Step>
        <Step n={3} label="3" title="Paste it and link" state={!known ? 'locked' : step === 3 ? 'open' : 'locked'}>
          <form className="form-stack" onSubmit={link}>
            <div>
              <label className="field-label" htmlFor="po-token">Your token</label>
              <textarea id="po-token" className="input token-input" rows={3} value={token} spellCheck={false} autoComplete="off" autoCapitalize="off"
                data-masked={!show && token.length > 0} onChange={(e) => { setToken(e.target.value); setErr(null) }}
                onPaste={() => setShow(false)} placeholder="Paste the code from step 2" aria-describedby={err ? 'po-err' : pasteNote ? 'po-paste' : undefined} />
              {pasteNote && <p className="field-hint" id="po-paste" role="status">{pasteNote}</p>}
            </div>
            <div className="step-actions">
              <button type="button" className="btn btn-secondary" onClick={paste}>📋 Paste</button>
              <button type="button" className="btn btn-ghost" onClick={() => setShow((v) => !v)} aria-pressed={show} disabled={!token}>{show ? 'Hide' : 'Show'}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>{busy ? 'Linking…' : '🔗 Link my account'}</button>
            </div>
            {err && (
              <div className="error-strip po-err" id="po-err" role="alert">
                <span>{err}</span>
                <button type="button" className="btn btn-secondary" onClick={() => { setErr(null); setStep(2) }}>Try a fresh token</button>
              </div>
            )}
          </form>
        </Step>
      </ol>
    </div>
  )
}

function StatusCard({ q }: { q: ReturnType<typeof usePsnStatus> }) {
  if (q.isPending) return <section className="glass settings-card" aria-busy="true"><div className="skeleton" style={{ height: 20, width: '60%' }} /></section>
  if (q.isError) return <section className="glass settings-card"><ErrorStrip text="Couldn't check your PSN link" onRetry={() => q.refetch()} /></section>
  const d = q.data
  if (!d.linked) {
    return (
      <section className="glass settings-card acct-status">
        <span className="acct-status-emoji" aria-hidden="true">🎮</span>
        <span className="acct-row-text"><span className="acct-row-title">Not linked yet</span><span className="meta">Three steps, about a minute.</span></span>
      </section>
    )
  }
  const st = tokenState(d)
  return (
    <section className="glass settings-card acct-status">
      <span className="acct-status-emoji" aria-hidden="true">🎮</span>
      <span className="acct-row-text">
        <span className="acct-row-title">Linked as {d.online_id ?? '—'}</span>
        <span className="meta">{st.kind === 'active' ? `Since ${fmtDate(d.linked_at)}. Re-link any time below.` : 'Re-link below to show up on Squad again.'}</span>
      </span>
      <span className="badge" data-tone={st.kind === 'active' ? 'live' : 'warn'}>{st.label}</span>
    </section>
  )
}

function Step({ n, label, title, state, onReopen, children }: {
  n: number; label: string; title: string; state: 'open' | 'done' | 'locked'; onReopen?: () => void; children: ReactNode
}) {
  const id = `po-step-${n}`
  return (
    <li className="step" data-state={state} aria-current={state === 'open' ? 'step' : undefined}>
      <span className="step-num" aria-hidden="true">{state === 'done' ? '✓' : label}</span>
      <div className="step-body">
        <div className="step-head">
          <h2 className="step-title" id={id}>{title}<span className="sr-only">{state === 'done' ? ' (done)' : state === 'locked' ? ' (locked)' : ''}</span></h2>
          {state === 'done' && onReopen && <button type="button" className="btn btn-ghost" onClick={onReopen} aria-describedby={id}>Reopen</button>}
        </div>
        {state === 'open' && children}
      </div>
    </li>
  )
}
