// A trip's Split: what everyone's spent, who owes whom, and adding expenses by hand
// or straight off receipt photos (one fills the Add expense sheet; several go to the
// batch review).
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { ErrorStrip, SkeletonRows } from '../../components/states'
import { toast } from '../../components/toast'
import { centsText, initial, isImageFile, money, parseCents, shrinkImage, tripsApi, useSplit, type Split, type Trip } from '../../lib/trips'
import { Sheet, errText } from '../tourney/Report'
import { ReceiptBatch } from './ReceiptBatch'

export function SplitTab({ trip }: { trip: Trip }) {
  const q = useSplit(trip.id)
  const qc = useQueryClient()
  const pick = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState<{ file: File | null } | null>(null)
  const [batch, setBatch] = useState<File[] | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [busy, setBusy] = useState('')

  if (q.isError && !q.data) return <ErrorStrip text="Couldn't load the Split" onRetry={() => q.refetch()} />
  if (!q.data) return <SkeletonRows n={4} />
  const s = q.data
  const name = (k: string) => s.people.find((p) => p.key === k)?.name || k
  const mine = s.me ? s.balances[s.me] ?? 0 : null
  const refresh = () => qc.invalidateQueries({ queryKey: ['trips', 'split', trip.id] })

  function picked(list: FileList | null) {
    const fs = Array.from(list || []).filter(isImageFile)
    if (pick.current) pick.current.value = ''
    if (!fs.length) return
    if (fs.length === 1) setAdding({ file: fs[0]! })
    else setBatch(fs)
  }

  async function markPaid(from: string, to: string, cents: number) {
    setBusy(`${from}>${to}`)
    try {
      await tripsApi.settle(trip.id, { from, to, cents })
      toast(`${name(from)} paid ${name(to)} ${money(cents, s.currency)}`, 'success')
      await refresh()
    } catch (e) { toast(errText(e), 'error') } finally { setBusy('') }
  }

  async function remove(eid: string) {
    if (!window.confirm('Delete this expense for everyone?')) return
    try { await tripsApi.removeExpense(trip.id, eid); toast('Expense deleted'); await refresh() } catch (e) { toast(errText(e), 'error') }
  }

  return (
    <div className="tr-split">
      <section className="glass tr-sum" aria-label="Totals">
        <div>
          <span className="eyebrow">Trip total</span>
          <span className="tr-big num">{money(s.total_cents, s.currency)}</span>
          <span className="meta">{s.expenses.length} {s.expenses.length === 1 ? 'expense' : 'expenses'}</span>
        </div>
        {mine !== null && (
          <div>
            <span className="eyebrow">You</span>
            <span className={`tr-big num ${mine > 0 ? 'is-owed' : mine < 0 ? 'is-owes' : ''}`}>{mine === 0 ? 'All square' : money(Math.abs(mine), s.currency)}</span>
            <span className="meta">{mine > 0 ? "you're owed" : mine < 0 ? 'you owe' : 'nothing owed either way'}</span>
          </div>
        )}
      </section>

      <div className="tr-actions">
        <button type="button" className="btn btn-primary" onClick={() => setAdding({ file: null })}><Icon name="plus" className="btn-ico" />Add expense</button>
        <button type="button" className="btn btn-secondary" onClick={() => pick.current?.click()}><Icon name="cam" className="btn-ico" />Scan receipts</button>
        <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => picked(e.target.files)} aria-label="Receipt photos" />
      </div>

      {s.settle.length > 0 && (
        <section className="tn-group" aria-labelledby="tr-settle-h">
          <h2 className="eyebrow" id="tr-settle-h">Settle up</h2>
          <ul className="tr-list glass">
            {s.settle.map((x) => (
              <li key={`${x.from}>${x.to}`} className="tr-row">
                <span className="tr-row-main"><span><b>{name(x.from)}</b> pays <b>{name(x.to)}</b></span></span>
                <span className="num tr-row-amt">{money(x.cents, s.currency)}</span>
                <button type="button" className="btn btn-ghost" disabled={busy === `${x.from}>${x.to}`} onClick={() => void markPaid(x.from, x.to, x.cents)}>Mark paid</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tn-group" aria-labelledby="tr-exp-h">
        <h2 className="eyebrow" id="tr-exp-h">Expenses</h2>
        {s.expenses.length === 0 ? (
          <div className="empty glass">
            <p className="empty-title">Nothing yet</p>
            <p className="dim">Add the first one, or snap the receipt and let it read the total.</p>
          </div>
        ) : (
          <ul className="tr-list glass">
            {s.expenses.slice().sort((a, b) => (a.added_at < b.added_at ? 1 : -1)).map((e) => (
              <li key={e.id} className="tr-row">
                {e.receipt_url ? (
                  <button type="button" className="tr-thumb-btn" aria-label={`Receipt for ${e.desc}`} onClick={() => setViewing(e.receipt_url)}>
                    <img className="tr-thumb tr-thumb-sm" src={e.receipt_url} alt="" loading="lazy" />
                  </button>
                ) : <span className="tr-av tr-av-lg" aria-hidden="true">{initial(name(e.payer))}</span>}
                <span className="tr-row-main">
                  <b className="tr-ellipsis">{e.desc}</b>
                  <span className="meta">Paid by {name(e.payer)} · {new Date(e.added_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}</span>
                </span>
                <span className="tr-row-amt num">
                  {money(e.orig_cents, e.currency)}
                  {e.currency !== s.currency && <span className="meta"> {money(e.cents, s.currency)}</span>}
                </span>
                {e.can_delete && (
                  <button type="button" className="icon-btn" aria-label={`Delete ${e.desc}`} onClick={() => void remove(e.id)}><Icon name="trash" /></button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Sheet open={Boolean(adding)} onOpenChange={(v) => { if (!v) setAdding(null) }} title="Add expense">
        {adding && <AddExpense trip={trip} split={s} file={adding.file} onDone={() => { setAdding(null); void refresh() }} />}
      </Sheet>
      <Sheet open={Boolean(batch)} onOpenChange={(v) => { if (!v) setBatch(null) }} title={batch ? `${batch.length} receipts` : 'Receipts'}>
        {batch && <ReceiptBatch tripId={trip.id} split={s} files={batch} onDone={() => setBatch(null)} />}
      </Sheet>
      <Sheet open={Boolean(viewing)} onOpenChange={(v) => { if (!v) setViewing(null) }} title="Receipt">
        {viewing && <img className="tr-full" src={viewing} alt="Receipt" />}
      </Sheet>
    </div>
  )
}

function AddExpense({ trip, split, file, onDone }: { trip: Trip; split: Split; file: File | null; onDone: () => void }) {
  const [cents, setCents] = useState(0)
  const [currency, setCurrency] = useState(split.currency)
  const [payer, setPayer] = useState<string | null>(split.me)
  const [parts, setParts] = useState<string[]>(split.people.map((p) => p.key))
  const [desc, setDesc] = useState('')
  const [receipt, setReceipt] = useState<{ blob: Blob; url: string } | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const started = useRef(false)
  const pick = useRef<HTMLInputElement>(null)
  const centsRef = useRef(0)
  centsRef.current = cents

  async function takeReceipt(f: File, scan: boolean) {
    try {
      const small = await shrinkImage(f)
      setReceipt(small)
      if (!scan) return
      setNote({ text: 'Reading the receipt…' })
      const r = await tripsApi.scan(small.blob)
      if (centsRef.current) { setNote({ text: `The receipt says ${money(r.cents, r.currency || currency)}. Your amount was kept.` }); return }
      setCents(r.cents)
      if (r.currency && split.currencies.includes(r.currency)) setCurrency(r.currency)
      setDesc((d) => d || [r.merchant, r.summary].filter(Boolean).join(' · ').slice(0, 80))
      setNote(r.other_currency
        ? { text: `The receipt looks like it's in ${r.other_currency}. Put the amount in ${split.currencies.join(' or ')} before saving.`, bad: true }
        : { text: `Read off the receipt${r.merchant ? ` from ${r.merchant}` : ''}. Check the amount, then save.` })
    } catch (e) {
      setNote({ text: errText(e), bad: true })
    }
  }
  // A photo picked with Scan receipts: attach it and read it, once (Strict Mode runs effects twice).
  useEffect(() => {
    if (file && !started.current) { started.current = true; void takeReceipt(file, true) }
  }, [file])

  const share = parts.length ? Math.floor(cents / parts.length) : 0
  const ok = Boolean(payer) && cents > 0 && parts.length > 0 && !saving

  async function save() {
    if (!ok || !payer) return
    setSaving(true)
    try {
      const r = receipt ? (await tripsApi.receipt(trip.id, receipt.blob)).receipt : undefined
      await tripsApi.addExpense(trip.id, { payer, desc: desc.trim() || 'Expense', currency, orig_cents: cents, parts, ...(r ? { receipt: r } : {}) })
      toast('Expense added', 'success')
      onDone()
    } catch (e) {
      toast(errText(e), 'error')
      setSaving(false)
    }
  }

  return (
    <form className="sheet-body tr-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <div>
        <label className="field-label" htmlFor="tr-amt">Amount</label>
        <div className="tr-amt">
          <input id="tr-amt" className="input tr-amt-in tr-amt-big" type="text" inputMode="numeric" placeholder="0.00" autoComplete="off"
            value={centsText(cents)} onChange={(e) => setCents(parseCents(e.target.value))} />
          {split.currencies.length > 1 && (
            <div className="seg" role="group" aria-label="Currency" style={{ gridTemplateColumns: `repeat(${split.currencies.length}, 1fr)` }}>
              {split.currencies.map((c) => (
                <button key={c} type="button" className="seg-tab" data-state={currency === c ? 'active' : 'inactive'} aria-pressed={currency === c} onClick={() => setCurrency(c)}>{c}</button>
              ))}
            </div>
          )}
        </div>
        {currency !== split.currency && cents > 0 && split.fx[currency] && (
          <p className="field-hint">≈ {money(Math.round(cents * split.fx[currency]!), split.currency)}</p>
        )}
        {note && <p className={note.bad ? 'field-err' : 'field-hint'} aria-live="polite">{note.text}</p>}
      </div>
      <div>
        <span className="field-label" id="tr-payer">Who paid</span>
        <div className="tr-chips" role="group" aria-labelledby="tr-payer">
          {split.people.map((p) => (
            <button key={p.key} type="button" className="chip tr-chip" aria-pressed={payer === p.key} onClick={() => setPayer(p.key)}>
              <span className="tr-av" aria-hidden="true">{initial(p.name)}</span>{p.name}{p.key === split.me ? <span className="chip-n"> you</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="field-label" id="tr-parts">Split equally between</span>
        <div className="tr-chips" role="group" aria-labelledby="tr-parts">
          {split.people.map((p) => {
            const on = parts.includes(p.key)
            return (
              <button key={p.key} type="button" className="chip tr-chip" aria-pressed={on}
                onClick={() => setParts((xs) => (on ? xs.filter((x) => x !== p.key) : [...xs, p.key]))}>
                {p.name}{on && cents > 0 ? <span className="chip-n"> {money(share, currency)}</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      <div>
        <label className="field-label" htmlFor="tr-desc">Description</label>
        <input id="tr-desc" className="input" type="text" maxLength={80} placeholder="Groceries, gas, dinner…" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="tr-receipt">
        {receipt ? <img className="tr-thumb" src={receipt.url} alt="Receipt" /> : null}
        <button type="button" className="btn btn-secondary" onClick={() => pick.current?.click()}><Icon name="cam" className="btn-ico" />{receipt ? 'Change receipt' : 'Add receipt'}</button>
        {receipt && <button type="button" className="btn btn-ghost" onClick={() => { setReceipt(null); setNote(null) }}>Remove</button>}
        <input ref={pick} type="file" accept="image/*" hidden aria-label="Receipt photo"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void takeReceipt(f, !centsRef.current) }} />
      </div>
      <button type="submit" className="btn btn-primary tr-wide" disabled={!ok}>{saving ? 'Saving…' : 'Save expense'}</button>
    </form>
  )
}
