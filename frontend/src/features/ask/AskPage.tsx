// PS-9 · Ask AI: ask something that already knows the squad's history (J8). The
// composer, chips and nav are fixed anchors; the answers are the only
// non-deterministic part. It reads, it never acts.
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { useNow } from '../../components/states'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { useSwipeDown } from '../../lib/gestures'
import {
  addFact, ask, clearThread, deleteFact, loadDraft, MAX_IMG_BYTES, MAX_Q, readImage, saveDraft, staged, SUGGESTIONS,
  useFacts, useHistory, useTools, type History, type Image, type Msg,
} from '../../lib/ask'

const SEEN_KEY = 'crcmz.ask.seen'
const status = (e: unknown) => (e instanceof ApiError ? e.status : 0)

/** Seconds left until `until` (ms), ticking each second; 0 once it passes. */
function useCountdown(until: number) {
  useNow(1000) // re-render each second; read the real clock so the first value is exact
  return Math.max(0, Math.ceil((until - Date.now()) / 1000))
}

export function AskPage() {
  useTitle('Ask AI')
  const tools = useTools()
  const hist = useHistory()
  const facts = useFacts()
  const qc = useQueryClient()
  const [draft, setDraftState] = useState(loadDraft)
  const [img, setImgState] = useState<Image | null>(staged.img)
  const [offline, setOffline] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [factsOpen, setFactsOpen] = useState(false)
  const setDraft = (v: string) => { setDraftState(v); saveDraft(v) }
  const setImg = (v: Image | null) => { staged.img = v; setImgState(v) }

  const msgs = hist.data?.messages ?? []
  const pending = !!hist.data?.pending
  const loading = tools.isPending || hist.isPending
  const signedOut = status(tools.error) === 401 || status(hist.error) === 401
  const down = offline || tools.data?.available === false
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs.length, pending])

  async function clear() {
    setConfirmClear(false)
    try {
      await clearThread()
      qc.setQueryData<History>(['ask', 'history'], { messages: [], pending: false, count: 0 })
      toast('Conversation cleared', 'success')
    } catch {
      toast("Couldn't clear the conversation", 'error')
    }
  }

  const factCount = facts.data?.total
  return (
    <div className="page page-reading ask-page">
      <div className="ask-head">
        <div className="ask-head-t">
          <h1 className="page-h1" tabIndex={-1}>Ask AI</h1>
          {tools.data?.available && <p className="meta ask-model">{tools.data.model} · {tools.data.tools.length} tools</p>}
        </div>
        <div className="ask-head-b">
          <button type="button" className="btn btn-secondary" aria-haspopup="dialog" onClick={() => setFactsOpen(true)}>
            <span aria-hidden="true">🧠</span>Squad facts{factCount != null && ` (${factCount})`}
          </button>
          <button type="button" className="btn btn-ghost" disabled={!msgs.length || pending} onClick={() => setConfirmClear(true)}>
            <Icon name="trash" />Clear
          </button>
        </div>
      </div>
      <Explainer />

      {down && (
        <div className="banner ask-offline" role="alert">
          <span style={{ fontWeight: 700 }}>The AI is offline (it runs on the Mac at home)</span>
          <span>Try <Link to="/">Squad</Link>, <Link to="/whatsapp">WhatsApp</Link>, or <Link to="/slap">Slap</Link> instead.</span>
        </div>
      )}

      <section className="ask-thread" aria-label="Conversation">
        {loading && !signedOut ? (
          <div className="ask-skel" aria-hidden="true">
            <div className="skeleton" data-role="user" /><div className="skeleton" data-role="assistant" /><div className="skeleton" data-role="user" />
          </div>
        ) : hist.isError && !hist.data && !signedOut ? (
          <div className="glass stat-err" role="alert">
            <span>Didn't load</span>
            <button type="button" className="btn btn-secondary" onClick={() => void hist.refetch()}>Retry</button>
          </div>
        ) : (
          <div role="log" aria-live="polite" aria-relevant="additions text"><ol className="ask-log">
            {msgs.map((m, i) => (
              <Bubble key={m.id} m={m} stale={hist.isError} onAgain={() => {
                const q = [...msgs.slice(0, i)].reverse().find((x) => x.role === 'user')
                if (q) setDraft(q.content)
                document.getElementById('ask-q')?.focus()
              }} />
            ))}
          </ol></div>
        )}
        <div ref={end} />
      </section>

      <Composer
        draft={draft} setDraft={setDraft} img={img} setImg={setImg} empty={!msgs.length && !loading}
        disabledWhy={loading && !signedOut ? 'Loading…' : signedOut ? 'Sign in to ask.' : down ? 'The AI is offline.' : pending ? 'Still answering your last one.' : null}
        onOffline={() => setOffline(true)}
        onSent={() => void qc.invalidateQueries({ queryKey: ['ask', 'history'] })}
      />

      <Dialog.Root open={confirmClear} onOpenChange={setConfirmClear}>
        <Dialog.Portal>
          <Dialog.Overlay className="scrim" />
          <Dialog.Content className="dialog dialog-confirm" role="alertdialog" aria-describedby="ask-clear-d">
            <Dialog.Title className="sheet-title">Clear all messages?</Dialog.Title>
            <p id="ask-clear-d" className="dim">Your facts stay, just the conversation goes.</p>
            <div className="dialog-actions">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary">Cancel</button></Dialog.Close>
              <button type="button" className="btn btn-primary" onClick={() => void clear()}>Clear</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <FactsSheet open={factsOpen} onOpenChange={setFactsOpen} />
    </div>
  )
}

/** Open on the first visit, a tap away after that. */
function Explainer() {
  const [first] = useState(() => { try { return !localStorage.getItem(SEEN_KEY) } catch { return true } })
  useEffect(() => { try { localStorage.setItem(SEEN_KEY, '1') } catch { /* private mode */ } }, [])
  return (
    <details className="glass ask-explain" open={first}>
      <summary>What is this?</summary>
      <p>It knows the squad — clips, scores, vibes. It can look things up but never acts. Ask it anything.</p>
    </details>
  )
}

function Bubble({ m, stale, onAgain }: { m: Msg; stale: boolean; onAgain: () => void }) {
  const now = useNow(1000)
  if (m.role === 'user') return <li className="ask-msg" data-role="user"><p>{m.content}</p></li>
  if (m.status === 'pending') {
    const s = Math.max(0, Math.round(now / 1000 - m.created_at))
    return (
      <li className="ask-msg" data-role="assistant" data-status="pending">
        <p role="status"><span className="spinner" aria-hidden="true" />{stale ? 'Still waiting — reconnecting' : `thinking… ${s}s`}</p>
      </li>
    )
  }
  if (m.status === 'error') {
    return (
      <li className="ask-msg" data-role="assistant" data-status="error">
        <p className="ask-err">Couldn't get an answer</p>
        {m.content && <p className="meta">{m.content}</p>}
        <button type="button" className="btn btn-ghost ask-again" onClick={onAgain}><Icon name="refresh" />Ask again</button>
      </li>
    )
  }
  return (
    <li className="ask-msg" data-role="assistant">
      <p>{m.content}</p>
      <p className="meta ask-meta">{m.tools.length ? m.tools.join(', ') : 'no tools'} · {(m.elapsed_ms ?? 0).toLocaleString()}ms</p>
    </li>
  )
}

function Composer({ draft, setDraft, img, setImg, empty, disabledWhy, onOffline, onSent }: {
  draft: string; setDraft: (v: string) => void; img: Image | null; setImg: (v: Image | null) => void; empty: boolean
  disabledWhy: string | null; onOffline: () => void; onSent: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [until, setUntil] = useState(0)
  const wait = useCountdown(until)
  const file = useRef<HTMLInputElement>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  const len = draft.length
  const tooLong = len > MAX_Q
  // Grows to four lines, then scrolls.
  useEffect(() => {
    const el = text.current
    if (!el) return
    el.style.height = 'auto'
    if (draft) el.style.height = `${el.scrollHeight + 2}px`
  }, [draft])

  async function send(q: string) {
    const question = q.trim()
    if (!question || disabledWhy || busy || wait) return
    if (question.length > MAX_Q) { setErr('Too long — keep it under 1 000 characters.'); return }
    setBusy(true)
    setErr(null)
    try {
      await ask(question, img)
      setDraft('')
      setImg(null)
      onSent()
    } catch (e) {
      const s = status(e)
      if (s === 429) setUntil(Date.now() + ((e as ApiError).retryAfter ?? 10) * 1000)
      else if (s === 503) onOffline()
      else if (s === 409) { setErr('Still answering your last one.'); onSent() }
      else if (s === 400) setErr(/too long/i.test((e as ApiError).detail) ? 'Too long — keep it under 1 000 characters.' : (e as ApiError).detail || "Couldn't send that")
      else if (s !== 401) setErr("Couldn't send that. Try again.")
      if (s !== 400) setDraft(q)
    } finally {
      setBusy(false)
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    void send(draft)
  }
  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!f.type.startsWith('image/')) { setErr('That isn\'t an image.'); return }
    if (f.size > MAX_IMG_BYTES) { setErr('Image is too large — keep it under 4 MB.'); return }
    setErr(null)
    setImg(await readImage(f))
  }

  const blocked = !!disabledWhy || busy
  const reason = disabledWhy ?? (wait ? `Try again in ${wait}s.` : null)
  return (
    <div className="ask-dock">
      <Suggestions open={empty} disabled={blocked || !!wait} onPick={(q) => void send(q)} />
      <form className="glass ask-composer" onSubmit={submit} aria-busy={busy || undefined}>
        <label className="field-label" htmlFor="ask-q">Ask something</label>
        {img && (
          <div className="ask-img">
            <img src={img.dataUrl} alt="" />
            <span className="meta">{img.name}</span>
            <button type="button" className="icon-btn" aria-label="Remove image" onClick={() => setImg(null)}><Icon name="close" /></button>
          </div>
        )}
        <div className="ask-row">
          <button type="button" className="icon-btn ask-attach" aria-label="Attach an image" disabled={blocked} onClick={() => file.current?.click()}>
            <span aria-hidden="true">📎</span>
          </button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void pick(e)} />
          <textarea
            id="ask-q" ref={text} className="input ask-input" rows={1} value={draft} placeholder="What's the squad up to?"
            aria-describedby="ask-why" disabled={!!disabledWhy && disabledWhy !== 'Still answering your last one.'}
            onChange={(e) => { setErr(null); setDraft(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft) } }}
          />
          <button type="submit" className="btn btn-primary ask-send" disabled={blocked || !!wait || !draft.trim() || tooLong}>
            <Icon name="send" /><span className="ask-send-t">Send</span>
          </button>
        </div>
        <div className="ask-foot" id="ask-why">
          {(err || reason) && <span className={err ? 'ask-ferr' : 'meta'} role={err ? 'alert' : 'status'}>{err ?? reason}</span>}
          {len >= 900 && <span className="ask-count num" data-over={tooLong || undefined}>{len}/1000</span>}
        </div>
      </form>
    </div>
  )
}

function Suggestions({ open, disabled, onPick }: { open: boolean; disabled: boolean; onPick: (q: string) => void }) {
  const chips = (
    <div className="ask-chips" role="group" aria-label="Suggestions">
      {SUGGESTIONS.map(([label, q]) => <button key={label} type="button" className="chip" disabled={disabled} onClick={() => onPick(q)}>{label}</button>)}
    </div>
  )
  if (open) return chips
  return <details className="ask-sugg"><summary>Suggestions</summary>{chips}</details>
}

// ── Squad facts (AI-06) ─────────────────────────────────────────────────────
function FactsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const desktop = useDesktop()
  const swipe = useSwipeDown(() => onOpenChange(false))
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className={desktop ? 'side-sheet ask-facts-side' : 'sheet ask-facts-sheet'} aria-describedby={undefined}>
          {!desktop && <div className="sheet-knob-row" {...swipe}><span className="sheet-knob" /></div>}
          <div className="sheet-title-row">
            <Dialog.Title className="sheet-title">Squad facts</Dialog.Title>
            <Dialog.Close asChild><button type="button" className="icon-btn" aria-label="Close squad facts"><Icon name="close" /></button></Dialog.Close>
          </div>
          <FactsBody />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function FactsBody() {
  const q = useFacts()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [subject, setSubject] = useState('')
  const [filter, setFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [until, setUntil] = useState(0)
  const wait = useCountdown(until)
  const d = q.data
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (d?.facts ?? []).filter((x) => !f || `${x.subject} ${x.text} ${x.author}`.toLowerCase().includes(f))
  }, [d, filter])

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || busy || wait) return
    setBusy(true)
    setErr(null)
    try {
      await addFact(text.trim(), subject.trim())
      setText('')
      void qc.invalidateQueries({ queryKey: ['ask', 'facts'] })
      toast('Fact added', 'success')
    } catch (e2) {
      const s = status(e2)
      if (s === 429) setUntil(Date.now() + ((e2 as ApiError).retryAfter ?? 10) * 1000)
      else if (s !== 401) setErr((e2 as ApiError).detail || "Couldn't add that fact")
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: string) {
    setErr(null)
    try {
      await deleteFact(id)
    } catch (e2) {
      if (status(e2) === 404) setErr('That fact is already gone.')
      else if (status(e2) !== 401) setErr("Couldn't delete that fact")
    }
    void qc.invalidateQueries({ queryKey: ['ask', 'facts'] })
  }

  if (q.isPending) return <div className="ask-facts-body" aria-busy="true"><div className="skeleton" style={{ height: 120 }} /></div>
  if (!d) {
    return (
      <div className="ask-facts-body">
        <div className="stat-err" role="alert"><span>Didn't load</span><button type="button" className="btn btn-secondary" onClick={() => void q.refetch()}>Retry</button></div>
      </div>
    )
  }
  const full = d.mine >= d.max_per_user
  return (
    <div className="ask-facts-body">
      <p className="meta">Total {d.total} · Yours {d.mine} of {d.max_per_user}</p>
      {!d.facts.length && <p className="ask-facts-empty">Teach it something about the squad</p>}
      <form className="ask-fact-form" onSubmit={add}>
        <div>
          <label className="field-label" htmlFor="fact-subject">Subject</label>
          <input id="fact-subject" className="input" list="fact-subjects" maxLength={60} value={subject} autoComplete="off" onChange={(e) => setSubject(e.target.value)} />
          <datalist id="fact-subjects">{d.subjects.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <div>
          <label className="field-label" htmlFor="fact-text">Fact</label>
          <textarea id="fact-text" className="input" rows={2} maxLength={d.max_chars} value={text} onChange={(e) => { setErr(null); setText(e.target.value) }} />
        </div>
        <div className="ask-fact-actions">
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || busy || !!wait || full}>{wait ? `Wait ${wait}s.` : 'Add fact'}</button>
          {full && <span className="meta">You've hit your {d.max_per_user} fact limit.</span>}
        </div>
        {err && <p className="ask-ferr" role="alert">{err}</p>}
      </form>
      {d.facts.length > 6 && (
        <div>
          <label className="sr-only" htmlFor="fact-filter">Filter facts</label>
          <input id="fact-filter" className="input" type="search" placeholder="Filter facts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <ul className="ask-facts">
        {shown.map((f) => (
          <li key={f.id}>
            <div className="ask-fact-t">
              {f.subject && <b>{f.subject}</b>}
              <span>{f.text}</span>
              <span className="meta">{f.mine ? 'you' : f.author}</span>
            </div>
            {f.mine && <button type="button" className="icon-btn" aria-label={`Delete fact: ${f.text.slice(0, 40)}`} onClick={() => void remove(f.id)}><span aria-hidden="true">✕</span></button>}
          </li>
        ))}
      </ul>
    </div>
  )
}
