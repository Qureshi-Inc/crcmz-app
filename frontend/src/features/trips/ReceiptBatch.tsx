// Several receipts at once (Scan receipts, or the phone's share sheet). Each is made
// small, then read by the server's AI two at a time, smallest first so answers start
// coming quickly, and listed in the order they were picked. Every amount can be fixed
// before anything is saved; Add saves them one after another, each with its receipt,
// paid by whoever's picked and split equally between everyone on the trip.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { centsText, initial, parseCents, shrinkImage, tripsApi, type Split } from '../../lib/trips'
import { errText } from '../tourney/Report'

type State = 'queued' | 'reading' | 'ready' | 'failed' | 'added' | 'removed'
type Item = {
  key: number; file: File; size: number; state: State; cents: number; currency: string | null; desc: string
  blob: Blob | null; url: string; note: string; descTouched: boolean; amtTouched: boolean
}

const MAX_AT_ONCE = 2

export function ReceiptBatch({ tripId, split, files, onDone }: {
  tripId: string; split: Split; files: File[]; onDone?: (added: number) => void
}) {
  const qc = useQueryClient()
  const items = useRef<Item[]>(files.slice(0, 30).map((f, i) => ({
    key: i, file: f, size: f.size || 0, state: 'queued', cents: 0, currency: null, desc: '', blob: null, url: '', note: '',
    descTouched: false, amtTouched: false,
  })))
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const running = useRef(0)
  const alive = useRef(true)
  const [payer, setPayer] = useState<string | null>(split.me)
  const [saving, setSaving] = useState('')

  const pump = useCallback(() => {
    while (running.current < MAX_AT_ONCE) {
      const next = items.current.filter((x) => x.state === 'queued').sort((a, b) => a.size - b.size)[0]
      if (!next) break
      running.current++
      next.state = 'reading'
      bump()
      void (async () => {
        try {
          const small = await shrinkImage(next.file)
          next.blob = small.blob
          next.url = small.url
          if (alive.current) bump()
          const r = await tripsApi.scan(small.blob)
          if (next.state === 'removed') return
          if (!next.amtTouched) next.cents = r.cents
          if (r.currency) next.currency = r.currency
          if (!next.descTouched) next.desc = [r.merchant, r.summary].filter(Boolean).join(' · ').slice(0, 80)
          next.note = r.other_currency ? `In ${r.other_currency}? Put it in ${split.currencies.join(' or ')}.` : r.merchant ? `Read from ${r.merchant}` : 'Read off the receipt'
          next.state = 'ready'
        } catch (e) {
          if (next.state !== 'removed') { next.state = 'failed'; next.note = errText(e) || "Couldn't read it. Type the amount." }
        } finally {
          running.current--
          if (alive.current) { bump(); pump() }
        }
      })()
    }
  }, [split.currencies])

  useEffect(() => {
    alive.current = true
    pump()
    return () => { alive.current = false }
  }, [pump])
  useEffect(() => () => { items.current.forEach((x) => x.url && URL.revokeObjectURL(x.url)) }, [])

  const live = items.current.filter((x) => x.state !== 'removed')
  const done = live.filter((x) => x.state === 'ready' || x.state === 'failed' || x.state === 'added').length
  const ready = live.filter((x) => x.cents > 0 && (x.state === 'ready' || x.state === 'failed'))
  const curOf = (x: Item) => x.currency || split.currency
  const nameOf = (k: string) => split.people.find((p) => p.key === k)?.name || k

  async function save() {
    if (!payer || !ready.length) return
    const todo = ready.slice()
    let n = 0
    let failed = 0
    for (const it of todo) {
      setSaving(`Adding ${++n} of ${todo.length}…`)
      try {
        const receipt = it.blob ? (await tripsApi.receipt(tripId, it.blob)).receipt : undefined
        await tripsApi.addExpense(tripId, {
          payer, desc: it.desc.trim() || 'Receipt', currency: curOf(it), orig_cents: it.cents,
          parts: split.people.map((p) => p.key), ...(receipt ? { receipt } : {}),
        })
        it.state = 'added'
      } catch (e) {
        failed++
        it.state = 'failed'
        it.note = `Couldn't save this one: ${errText(e)}`
      }
      bump()
    }
    setSaving('')
    void qc.invalidateQueries({ queryKey: ['trips', 'split', tripId] })
    const added = todo.length - failed
    if (added) toast(`${added} ${added === 1 ? 'expense' : 'expenses'} added`, 'success')
    if (!failed) onDone?.(added)
  }

  return (
    <div className="tr-batch">
      <p className="dim tr-batch-sub" aria-live="polite">
        {done < live.length ? `Reading ${done} of ${live.length}…` : 'All read. Check the amounts, then add them.'}
      </p>
      <div>
        <span className="field-label" id="tr-batch-payer">Who paid</span>
        <div className="tr-chips" role="group" aria-labelledby="tr-batch-payer">
          {split.people.map((p) => (
            <button key={p.key} type="button" className="chip tr-chip" aria-pressed={payer === p.key} onClick={() => setPayer(p.key)}>
              <span className="tr-av" aria-hidden="true">{initial(p.name)}</span>{p.name}{p.key === split.me ? <span className="chip-n"> you</span> : null}
            </button>
          ))}
        </div>
        <p className="field-hint">Each one splits equally between everyone. Open one afterwards to change it.</p>
      </div>
      <ul className="tr-batch-list">
        {live.map((it) => (
          <li key={it.key} className={`tr-batch-row glass${it.state === 'added' ? ' is-added' : ''}`}>
            {it.url ? <img className="tr-thumb" src={it.url} alt={`Receipt ${it.key + 1}`} /> : <span className="tr-thumb tr-thumb-empty" aria-hidden="true" />}
            <div className="tr-batch-main">
              <input className="input" type="text" maxLength={80} placeholder="What was it?" aria-label={`Receipt ${it.key + 1} description`}
                value={it.desc} onChange={(e) => { it.desc = e.target.value; it.descTouched = true; bump() }} disabled={it.state === 'added'} />
              <div className="tr-amt">
                <input className="input tr-amt-in" type="text" inputMode="numeric" placeholder="0.00" aria-label={`Receipt ${it.key + 1} amount in ${curOf(it)}`}
                  value={centsText(it.cents)} onChange={(e) => { it.cents = parseCents(e.target.value); it.amtTouched = true; bump() }} disabled={it.state === 'added'} />
                <button type="button" className="btn btn-secondary tr-cur" aria-label={`Currency ${curOf(it)}, tap to change`} disabled={it.state === 'added' || split.currencies.length < 2}
                  onClick={() => { const cs = split.currencies; it.currency = cs[(cs.indexOf(curOf(it)) + 1) % cs.length] ?? split.currency; bump() }}>
                  {curOf(it)}
                </button>
              </div>
              <p className={`tr-state${it.state === 'failed' ? ' is-bad' : ''}`} aria-live="polite">
                {it.state === 'queued' ? 'Waiting…' : it.state === 'reading' ? 'Reading…' : it.state === 'added' ? 'Added ✓' : it.note}
              </p>
            </div>
            {it.state !== 'added' && (
              <button type="button" className="icon-btn" aria-label={`Leave receipt ${it.key + 1} out`} onClick={() => { it.state = 'removed'; bump() }}>
                <Icon name="close" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-primary tr-wide" disabled={Boolean(saving) || !payer || !ready.length} onClick={() => void save()}>
        {saving || (ready.length ? `Add ${ready.length} ${ready.length === 1 ? 'expense' : 'expenses'}` : 'Add expenses')}
      </button>
      {payer && ready.length > 0 && !saving && <p className="field-hint">Paid by {nameOf(payer)}.</p>}
    </div>
  )
}
