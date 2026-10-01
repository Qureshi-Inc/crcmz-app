// PS-5 admin tools (GW-07…GW-12), role-gated on `is_admin`. Each tool is a card
// in lifecycle order; on desktop they sit side by side as the admin desk. Every
// write is an explicit, confirmed tap. A 403 means the role went away: say so,
// re-fetch, and the tools hide.
import { useState, type FormEvent, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ConfirmDialog } from '../clips/ClipSheet'
import { ApiError, NetworkError } from '../../lib/http'
import {
  addEntry, closeGiveaway, createGiveaway, drawAndReveal, fmtWhen, parseWhen, publishGiveaway, redraw, removeEntry, resetAndSeed,
  revealMs, toLocalInput, tzName, updateGiveaway, zonedMs, type Giveaway, type GwData, type GwMember, type GwStatus,
} from '../../lib/giveaway'

const STEPS: [GwStatus | 'none', string][] = [
  ['none', 'None'], ['draft', 'Draft'], ['open', 'Open'], ['locked', 'Locked'], ['drawn', 'Drawn'], ['revealed', 'Revealed'], ['closed', 'Closed'],
]
const LABEL = Object.fromEntries(STEPS) as Record<GwStatus | 'none', string>

function errText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.status === 403 ? 'Admins only' : e.detail || fallback
  if (e instanceof NetworkError) return e.timedOut ? "The server didn't answer in time. Refresh to see if it went through." : "Couldn't reach the app. Check your connection."
  return fallback
}

/** One admin write: busy while it runs, its error inline under it, then a re-fetch. */
function useAction() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<{ at: string; text: string } | null>(null)
  async function run<T>(at: string, fn: () => Promise<T>, fallback: string): Promise<T | undefined> {
    setBusy(at)
    setErr(null)
    try {
      return await fn()
    } catch (e) {
      setErr({ at, text: errText(e, fallback) })
      return undefined
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['giveaway'] })
    }
  }
  const errAt = (at: string) => (err?.at === at ? <p className="field-err" role="alert">{err.text}</p> : null)
  return { busy, run, errAt }
}

export function AdminTools({ d, overdue, defaultOpen }: { d: GwData; overdue: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const shown = open ?? defaultOpen
  const g = d.giveaway
  return (
    <section className="gw-admin" aria-labelledby="gw-admin-h">
      <h2 className="section-h2 gw-admin-h" id="gw-admin-h">
        <button type="button" className="gw-admin-toggle" aria-expanded={shown} aria-controls="gw-admin-body" onClick={() => setOpen(!shown)}>
          Admin tools<Icon name={shown ? 'up' : 'down'} />
        </button>
      </h2>
      <div id="gw-admin-body" hidden={!shown}>
        <Lifecycle status={g?.status ?? 'none'} />
        <div className="gw-desk">
          <StateCard d={d} overdue={overdue} />
          <Entries d={d} />
          <EditCard key={g ? `${g.id}` : 'new'} g={g} tz={d.reveal_tz} />
        </div>
        <DangerZone />
      </div>
    </section>
  )
}

function Lifecycle({ status }: { status: GwStatus | 'none' }) {
  const at = STEPS.findIndex(([s]) => s === status)
  return (
    <ol className="gw-strip" aria-label="Giveaway lifecycle" tabIndex={0}>
      {STEPS.map(([s, l], i) => (
        <li key={s} data-past={i < at || undefined} aria-current={i === at ? 'step' : undefined}>
          {l}{i === at && <span className="sr-only"> (current)</span>}
        </li>
      ))}
    </ol>
  )
}

function Card({ id, title, children, extra }: { id: string; title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="glass gw-card" aria-labelledby={id}>
      <div className="settings-card-head"><h3 className="gw-card-h" id={id}>{title}</h3>{extra}</div>
      {children}
    </section>
  )
}

// ── State + next action (GW-10, GW-11) ───────────────────────────────────────
function StateCard({ d, overdue }: { d: GwData; overdue: boolean }) {
  const g = d.giveaway
  const { busy, run, errAt } = useAction()
  const [confirm, setConfirm] = useState<'draw' | 'reveal' | 'close' | null>(null)
  const [redrawOpen, setRedrawOpen] = useState(false)
  const [more, setMore] = useState(false)

  if (!g) {
    return (
      <Card id="gw-st" title="State">
        <p className="gw-state-line">None · no giveaway yet</p>
        <div><button type="button" className="btn btn-primary" onClick={() => document.getElementById('gw-f-title')?.focus()}><Icon name="plus" />Start a giveaway</button></div>
      </Card>
    )
  }
  const n = g.entries.length
  const reveal = revealMs(g)
  const winner = g.active_draw?.winner_name || 'the current winner'
  async function act(kind: 'publish' | 'draw' | 'reveal' | 'close') {
    if (!g) return
    if (kind === 'publish') {
      const r = await run('main', () => publishGiveaway(g.id), "Couldn't publish")
      if (r) toast(`Published. ${r.entries ?? n} members entered`, 'success')
    } else if (kind === 'close') {
      if (await run('more', () => closeGiveaway(g.id), "Couldn't close it")) toast('Giveaway closed', 'success')
    } else if (await run('main', () => drawAndReveal(g.id), kind === 'draw' ? "Couldn't draw" : "Couldn't reveal")) {
      toast('Winner revealed!', 'success')
    }
  }

  const primary = g.status === 'draft' ? { label: 'Publish', on: () => void act('publish') }
    : g.status === 'open' || g.status === 'locked' ? { label: 'Draw & reveal now', on: () => setConfirm('draw') }
    : g.status === 'drawn' ? { label: 'Reveal now', on: () => setConfirm('reveal') }
    : null
  const canRedraw = g.status === 'drawn' || g.status === 'revealed'
  const canClose = g.status === 'revealed'

  return (
    <Card id="gw-st" title="State">
      <p className="gw-state-line">
        <b>{LABEL[g.status]}</b> · <span className="num">{n}</span> {n === 1 ? 'entry' : 'entries'}{reveal ? ` · reveal ${fmtWhen(reveal)}` : ''}
      </p>
      {overdue && g.status !== 'draft' && <p className="settings-note" role="note">The reveal time has passed. The winner is drawn and revealed automatically within a minute.</p>}
      {primary && (
        <div><button type="button" className="btn btn-primary" onClick={primary.on} disabled={busy !== null}>{busy === 'main' ? 'Working…' : primary.label}</button></div>
      )}
      {errAt('main')}
      {(canRedraw || canClose) && (
        <div className="gw-more">
          <button type="button" className="link-btn" aria-expanded={more} aria-controls="gw-more-body" onClick={() => setMore((v) => !v)}>More actions</button>
          <div id="gw-more-body" className="step-actions" hidden={!more}>
            {canRedraw && <button type="button" className="btn btn-secondary" onClick={() => setRedrawOpen(true)} disabled={busy !== null}>Disqualify & redraw</button>}
            {canClose && <button type="button" className="btn btn-danger" onClick={() => setConfirm('close')} disabled={busy !== null}>{busy === 'more' ? 'Closing…' : 'Close giveaway'}</button>}
          </div>
          {errAt('more')}
        </div>
      )}
      {g.active_draw && <WinnerPreview g={g} />}

      <ConfirmDialog
        open={confirm === 'draw'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Draw & reveal now?"
        body={<p>Draw a winner from {n} {n === 1 ? 'entry' : 'entries'} and reveal immediately. This cannot be undone.</p>}
        action="Draw & reveal now" onConfirm={() => void act('draw')}
      />
      <ConfirmDialog
        open={confirm === 'reveal'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Reveal now?" body={<p>Reveal the winner to everyone now.</p>}
        action="Reveal now" onConfirm={() => void act('reveal')}
      />
      <ConfirmDialog
        open={confirm === 'close'} onOpenChange={(v) => { if (!v) setConfirm(null) }}
        title="Close giveaway?" body={<p>Close '{g.title || 'Giveaway'}'? No more draws can happen after this.</p>}
        action="Close" onConfirm={() => void act('close')}
      />
      <RedrawDialog open={redrawOpen} onClose={() => setRedrawOpen(false)} g={g} winner={winner} />
    </Card>
  )
}

function WinnerPreview({ g }: { g: Giveaway }) {
  const a = g.active_draw!
  async function copy() {
    try { await navigator.clipboard.writeText(a.manifest_hash || ''); toast('Hash copied', 'success') }
    catch { toast('Copy was blocked. Select the hash and copy it.', 'warning') }
  }
  return (
    <div className="gw-preview">
      <h4 className="field-label">Winner preview</h4>
      <dl className="meta-list">
        <dt>Winner</dt><dd><b>{a.winner_name || '—'}</b></dd>
        <dt>Draw</dt><dd className="num">#{a.draw_number}</dd>
        <dt>Drawn</dt><dd>{fmtWhen(parseWhen(a.drawn_at))}</dd>
        <dt>Manifest</dt>
        <dd className="gw-hash"><code>{a.manifest_hash || '—'}</code>{a.manifest_hash && <button type="button" className="btn btn-ghost" onClick={copy} aria-label="Copy manifest hash">Copy</button>}</dd>
      </dl>
      <p className="meta">Only admins see this. Members find out at the reveal.</p>
    </div>
  )
}

function RedrawDialog({ open, onClose, g, winner }: { open: boolean; onClose: () => void; g: Giveaway; winner: string }) {
  const { busy, run, errAt } = useAction()
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const missing = touched && !reason.trim()
  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!reason.trim()) return
    const r = await run('redraw', () => redraw(g.id, reason.trim()), "Couldn't redraw")
    if (r) { toast(r.winner ? `Redrawn. New winner: ${r.winner}` : 'Redrawn', 'success'); setReason(''); setTouched(false); onClose() }
  }
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="rd-desc">
          <Dialog.Title className="dialog-title">Reason for redraw</Dialog.Title>
          <p id="rd-desc" className="dim">{winner} is disqualified and taken out of this draw. A new winner is drawn from everyone else.</p>
          <form className="form-stack" onSubmit={submit} noValidate>
            <div>
              <label className="field-label" htmlFor="rd-why">Why?</label>
              <textarea id="rd-why" className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)}
                aria-invalid={missing} aria-describedby={missing ? 'rd-err' : undefined} />
              {missing && <p className="field-err" id="rd-err">Say why, so there's a record.</p>}
            </div>
            {errAt('redraw')}
            <div className="dialog-actions">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy ? 'Redrawing…' : 'Redraw'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Entries (GW-09) ──────────────────────────────────────────────────────────
function Entries({ d }: { d: GwData }) {
  const g = d.giveaway
  const { busy, run, errAt } = useAction()
  const [drop, setDrop] = useState<{ member_id: string; display_name: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const won = new Set(d.rotation.won_members.map((m) => m.member_id))
  const entries = g?.entries ?? []
  const eligible = entries.filter((e) => !won.has(e.member_id)).length
  const locked = !g || g.status === 'closed'

  async function remove(e: { member_id: string; display_name: string }) {
    if (!g) return
    if (await run('rm', () => removeEntry(g.id, e.member_id), `Couldn't remove ${e.display_name}`)) toast(`Removed ${e.display_name}`, 'success')
  }

  return (
    <Card id="gw-en" title="Entries" extra={g ? <span className="meta num">{entries.length} entered · {eligible} eligible</span> : null}>
      {!g ? <p className="dim">Entries fill in when you publish: everyone with a linked PSN account goes in.</p> : (
        <>
          <div><button type="button" className="btn btn-secondary" onClick={() => setAdding(true)} disabled={locked}>＋ Add entry</button></div>
          {errAt('rm')}
          {entries.length === 0 ? <p className="dim">No entries yet.</p> : (
            <ul className="rows acct-rows gw-entries">
              {entries.map((e) => (
                <li key={e.member_id} className="acct-row">
                  <span className="acct-row-text">
                    <span className="acct-row-title">{e.display_name}</span>
                    <span className="meta">{won.has(e.member_id) ? '🏆 won this cycle' : '✅ eligible'}</span>
                  </span>
                  <button type="button" className="btn btn-ghost" onClick={() => setDrop(e)} disabled={locked || busy !== null} aria-label={`Remove ${e.display_name}`}>
                    <Icon name="close" />Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ConfirmDialog
            open={drop !== null} onOpenChange={(v) => { if (!v) setDrop(null) }}
            title="Remove from this draw?" body={<p>Remove {drop?.display_name} from this draw?</p>}
            action="Remove" onConfirm={() => { if (drop) void remove(drop) }}
          />
          <AddEntryDialog open={adding} onClose={() => setAdding(false)} g={g} members={d.rotation.all_members.filter((m) => !entries.some((e) => e.member_id === m.id))} />
        </>
      )}
    </Card>
  )
}

function AddEntryDialog({ open, onClose, g, members }: { open: boolean; onClose: () => void; g: Giveaway; members: GwMember[] }) {
  const { busy, run, errAt } = useAction()
  const [qText, setQ] = useState('')
  const list = members.filter((m) => m.display.toLowerCase().includes(qText.trim().toLowerCase()))
  async function add(m: GwMember) {
    const r = await run('add', () => addEntry(g.id, m), `Couldn't add ${m.display}`)
    if (r) toast(r.status === 'already_in_giveaway' ? `${m.display} was already in` : `Added ${m.display}`, 'success')
  }
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) { setQ(''); onClose() } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby="ae-desc">
          <Dialog.Title className="dialog-title">Add entry</Dialog.Title>
          <p id="ae-desc" className="dim">Anyone in the rotation who isn't entered yet.</p>
          <label className="field-label" htmlFor="ae-q">Search</label>
          <input id="ae-q" className="input" type="search" value={qText} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          {errAt('add')}
          {list.length === 0 ? <p className="dim">{members.length === 0 ? 'Everyone is already in.' : 'Nobody matches that.'}</p> : (
            <ul className="rows acct-rows gw-pick">
              {list.map((m) => (
                <li key={m.id} className="acct-row">
                  <span className="acct-row-title">{m.display}</span>
                  <button type="button" className="btn btn-secondary" onClick={() => void add(m)} disabled={busy !== null} aria-label={`Add ${m.display}`}>Add</button>
                </li>
              ))}
            </ul>
          )}
          <div className="dialog-actions"><Dialog.Close asChild><button type="button" className="btn btn-secondary">Done</button></Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Create / edit (GW-07, GW-08) ─────────────────────────────────────────────
function EditCard({ g, tz }: { g: Giveaway | null; tz: string | undefined }) {
  const { busy, run, errAt } = useAction()
  const [title, setTitle] = useState(g?.title ?? '')
  const [prize, setPrize] = useState(g?.prize ?? '')
  const [when, setWhen] = useState(() => (!g?.reveal_at ? '' : /[zZ]$|[+-]\d\d:?\d\d$/.test(g.reveal_at) ? toLocalInput(parseWhen(g.reveal_at)) : g.reveal_at.slice(0, 16)))
  const [touched, setTouched] = useState({ title: false, when: false })
  const creating = !g
  // The server reveals at this wall-clock time in its zone, so check "future" there too.
  const whenMs = zonedMs(when, tz)
  const titleErr = touched.title && !title.trim() ? 'Give it a title' : ''
  const whenErr = touched.when && !when ? 'Pick when the winner is revealed'
    : touched.when && creating && whenMs != null && whenMs <= Date.now() ? 'Pick a time in the future' : ''

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched({ title: true, when: true })
    if (!title.trim() || !when || (creating && (whenMs ?? 0) <= Date.now())) return
    const body = { title: title.trim(), prize: prize.trim(), reveal_at: when }
    if (g) {
      if (await run('save', () => updateGiveaway(g.id, body), "Couldn't save")) toast('Saved', 'success')
      return
    }
    const made = await run('save', () => createGiveaway(body), "Couldn't create it")
    if (!made) return
    // Create then publish. If publishing fails it stays a draft with Publish above; no silent retry.
    const pub = await run('save', () => publishGiveaway(made.id), "Saved as a draft, but publishing failed. Use Publish above.")
    toast(pub ? `Published. ${pub.entries ?? 0} members entered` : "Saved as a draft. Publishing didn't go through; use Publish under State.", pub ? 'success' : 'warning')
  }

  return (
    <Card id="gw-ed" title={creating ? 'New giveaway' : 'Edit'}>
      <form className="form-stack" onSubmit={submit} noValidate>
        <div>
          <label className="field-label" htmlFor="gw-f-title">Title</label>
          <input id="gw-f-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, title: true }))}
            placeholder="October giveaway" aria-invalid={!!titleErr} aria-describedby={titleErr ? 'gw-f-title-err' : undefined} />
          {titleErr && <p className="field-err" id="gw-f-title-err">{titleErr}</p>}
        </div>
        <div>
          <label className="field-label" htmlFor="gw-f-prize">Prize</label>
          <input id="gw-f-prize" className="input" value={prize} onChange={(e) => setPrize(e.target.value)} placeholder="$50 PSN card" />
        </div>
        <div>
          <label className="field-label" htmlFor="gw-f-when">Reveal date & time</label>
          <input id="gw-f-when" className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, when: true }))}
            aria-invalid={!!whenErr} aria-describedby={whenErr ? 'gw-f-when-err' : 'gw-f-when-hint'} />
          {whenErr ? <p className="field-err" id="gw-f-when-err">{whenErr}</p> : <p className="field-hint" id="gw-f-when-hint">{tzName(tz)}. The winner is revealed automatically at this time.</p>}
        </div>
        {errAt('save')}
        <div><button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy ? 'Saving…' : creating ? 'Create & publish' : 'Save'}</button></div>
      </form>
    </Card>
  )
}

// ── Danger zone (GW-12) ──────────────────────────────────────────────────────
function DangerZone() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [prize, setPrize] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [pick, setPick] = useState<{ kind: 'no_match' | 'ambiguous'; query: string; members: GwMember[] } | null>(null)

  async function go() {
    setBusy(true); setErr(''); setPick(null)
    try {
      const r = await resetAndSeed({ winner_query: name.trim(), title: title.trim(), prize: prize.trim() })
      if (r.kind === 'ok') {
        toast(`Reset. ${r.winner.display} is recorded as the last winner`, 'success')
        setName(''); setTitle(''); setPrize('')
      } else setPick({ kind: r.kind, query: name.trim(), members: r.members })
    } catch (e) {
      setErr(errText(e, "Couldn't reset"))
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: ['giveaway'] })
    }
  }

  return (
    <section className="gw-danger" aria-labelledby="gw-dz">
      <h3 className="gw-card-h" id="gw-dz">Danger zone</h3>
      <p className="dim">Reset & seed deletes every giveaway, entry, draw and the rotation, then records one past winner to start cycle 1 from.</p>
      <form className="gw-danger-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setConfirm(true) }} noValidate>
        <div>
          <label className="field-label" htmlFor="dz-name">Type the winner's name to confirm</label>
          <input id="dz-name" className="input" value={name} onChange={(e) => { setName(e.target.value); setPick(null) }} autoComplete="off" />
        </div>
        <div>
          <label className="field-label" htmlFor="dz-title">Title <span className="meta">(optional)</span></label>
          <input id="dz-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="dz-prize">Prize <span className="meta">(optional)</span></label>
          <input id="dz-prize" className="input" value={prize} onChange={(e) => setPrize(e.target.value)} />
        </div>
        <div><button type="submit" className="btn btn-danger" disabled={busy || !name.trim()}>{busy ? 'Resetting…' : 'Reset & seed'}</button></div>
      </form>
      {err && <p className="field-err" role="alert">{err}</p>}
      {pick && (
        <div className="gw-picklist" role="status">
          <p>{pick.kind === 'no_match' ? `Nobody matched '${pick.query}'. Try a different name.` : 'Multiple matches. Pick one:'}</p>
          <div className="step-actions">
            {pick.members.map((m) => <button key={m.id} type="button" className="btn btn-secondary" onClick={() => { setName(m.display); setPick(null) }}>{m.display}</button>)}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm}
        title="Wipe every giveaway?"
        body={<p>This deletes every giveaway, entry, draw and the rotation history, then records {name.trim()} as the last winner. This cannot be undone.</p>}
        action="Reset & seed" onConfirm={() => void go()}
      />
    </section>
  )
}
