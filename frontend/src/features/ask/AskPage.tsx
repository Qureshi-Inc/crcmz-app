// PS-9 · Ask AI: ask something that already knows the squad's history (J8). The
// composer, chips and nav are fixed anchors; the answers are the only
// non-deterministic part. It reads, it never acts.
//
// The thread is assistant-ui over an external store: history from the server, plus
// a live overlay for the answer being written, fed by /api/assistant/stream. The
// server's stored row stays the truth; the overlay goes once history has caught up.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type PropsWithChildren } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import * as Dialog from '@radix-ui/react-dialog'
import {
  ActionBarPrimitive, AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive,
  useAui, useAuiState, useExternalStoreRuntime,
  type AppendMessage, type AttachmentAdapter, type ThreadMessageLike,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { useNow } from '../../components/states'
import { toast } from '../../components/toast'
import { ApiError } from '../../lib/http'
import { useDesktop } from '../../lib/media'
import { useSwipeDown } from '../../lib/gestures'
import {
  addFact, ask, clearThread, deleteFact, loadDraft, MAX_IMG_BYTES, MAX_Q, saveDraft, stopAnswer, streamAnswer, SUGGESTIONS,
  useFacts, useHistory, useTools, type History, type Msg, type StreamEvent,
} from '../../lib/ask'
import { HelpLink } from '../../components/HelpLink'

const SEEN_KEY = 'crcmz.ask.seen'
const TOO_LONG = 'Too long — keep it under 1 000 characters.'
const status = (e: unknown) => (e instanceof ApiError ? e.status : 0)

/** Seconds left until `until` (ms), ticking each second; 0 once it passes. */
function useCountdown(until: number) {
  useNow(1000) // re-render each second; read the real clock so the first value is exact
  return Math.max(0, Math.ceil((until - Date.now()) / 1000))
}

// ── The answer being written ────────────────────────────────────────────────
type Step = { name: string; done: boolean; ok: boolean }
type Live = {
  /** null while the question is still on its way to the server. */
  replyId: number | null
  question: string; image: string | null; startedAt: number
  text: string; steps: Step[]
  finished: { status: 'done' | 'error'; content: string; elapsed_ms: number | null } | null
}

function apply(l: Live, e: StreamEvent): Live {
  switch (e.type) {
    case 'text': return { ...l, text: l.text + e.delta }
    case 'reset': return { ...l, text: '' }
    case 'tool': return { ...l, steps: [...l.steps, { name: e.name, done: false, ok: false }] }
    case 'tool_done': {
      const i = l.steps.findIndex((s) => s.name === e.name && !s.done)
      return i < 0 ? l : { ...l, steps: l.steps.map((s, j) => (j === i ? { ...s, done: true, ok: e.ok } : s)) }
    }
    case 'done': return { ...l, finished: { status: e.status, content: e.content, elapsed_ms: e.elapsed_ms ?? null } }
  }
}

type Row =
  | { role: 'user'; key: string; text: string; image: string | null }
  | { role: 'assistant'; key: string; state: 'running' | 'done' | 'error'; text: string; steps: Step[]; elapsed_ms: number | null; question: string; startedAt: number }

function liveRow(l: Live, key: string, question: string, startedAt: number): Row {
  const f = l.finished
  return { role: 'assistant', key, state: f ? (f.status === 'error' ? 'error' : 'done') : 'running',
    text: f?.content ?? l.text, steps: l.steps, elapsed_ms: f?.elapsed_ms ?? null, question, startedAt }
}

function rowsOf(msgs: Msg[], live: Live | null): Row[] {
  const out: Row[] = []
  let q = ''
  for (const m of msgs) {
    const key = `m${m.id}`
    if (m.role === 'user') { q = m.content; out.push({ role: 'user', key, text: m.content, image: null }); continue }
    if (live && live.replyId === m.id && m.status === 'pending') { out.push(liveRow(live, key, q, m.created_at * 1000)); continue }
    out.push({ role: 'assistant', key, state: m.status === 'pending' ? 'running' : m.status, text: m.content,
      steps: m.tools.map((name) => ({ name, done: true, ok: true })), elapsed_ms: m.elapsed_ms, question: q, startedAt: m.created_at * 1000 })
  }
  // Sent, but history hasn't been fetched since: show it from what we know.
  if (live && !msgs.some((m) => m.id === live.replyId)) {
    out.push({ role: 'user', key: 'live-q', text: live.question, image: live.image })
    out.push(liveRow(live, live.replyId == null ? 'live-a' : `m${live.replyId}`, live.question, live.startedAt))
  }
  return out
}

type Meta = { state: 'running' | 'done' | 'error'; elapsed_ms: number | null; question: string; startedAt: number; tools: string[] }

function convert(r: Row): ThreadMessageLike {
  if (r.role === 'user') {
    return { role: 'user', id: r.key, content: r.image ? [{ type: 'image', image: r.image }, { type: 'text', text: r.text }] : [{ type: 'text', text: r.text }] }
  }
  const meta: Meta = { state: r.state, elapsed_ms: r.elapsed_ms, question: r.question, startedAt: r.startedAt, tools: r.steps.map((s) => s.name) }
  return {
    role: 'assistant', id: r.key,
    content: [
      ...r.steps.map((s, i) => ({ type: 'tool-call' as const, toolCallId: `${r.key}-${i}`, toolName: s.name, args: {},
        ...(s.done ? { result: s.ok ? 'ok' : 'failed' } : {}) })),
      ...(r.text && r.state !== 'error' ? [{ type: 'text' as const, text: r.text }] : []),
    ],
    status: r.state === 'running' ? { type: 'running' } : r.state === 'error'
      ? { type: 'incomplete', reason: 'error', error: r.text } : { type: 'complete', reason: 'stop' },
    metadata: { custom: { ...meta, error: r.state === 'error' ? r.text : '' } },
  }
}

/** One image, sent inline as base64 like before; the 4 MB cap is checked on pick. */
function imageAdapter(onReject: (why: string) => void): AttachmentAdapter {
  return {
    accept: 'image/*',
    async add({ file }) {
      const why = !file.type.startsWith('image/') ? "That isn't an image." : file.size > MAX_IMG_BYTES ? 'Image is too large — keep it under 4 MB.' : ''
      if (why) { onReject(why); throw new Error(why) }
      return { id: `${file.name}-${file.size}-${file.lastModified}`, type: 'image', name: file.name, contentType: file.type, file, status: { type: 'requires-action', reason: 'composer-send' } }
    },
    async send(a) {
      const image = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(a.file)
      })
      return { ...a, status: { type: 'complete' }, content: [{ type: 'image', image }] }
    },
    async remove() { /* nothing to release */ },
  }
}

export function AskPage() {
  useTitle('Ask AI')
  const tools = useTools()
  const hist = useHistory()
  const facts = useFacts()
  const qc = useQueryClient()
  const [live, setLive] = useState<Live | null>(null)
  const [gone, setGone] = useState<number | null>(null)
  const [offline, setOffline] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [until, setUntil] = useState(0)
  const wait = useCountdown(until)
  const [confirmClear, setConfirmClear] = useState(false)
  const [factsOpen, setFactsOpen] = useState(false)

  const msgs = useMemo(() => hist.data?.messages ?? [], [hist.data])
  const loading = tools.isPending || hist.isPending
  const signedOut = status(tools.error) === 401 || status(hist.error) === 401
  const down = offline || tools.data?.available === false
  const running = !!hist.data?.pending || (!!live && !live.finished)
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: ['ask', 'history'] }), [qc])

  // Follow the answer being written: ours, or one already underway when the page opened.
  const pendingId = useMemo(() => [...msgs].reverse().find((m) => m.role === 'assistant' && m.status === 'pending')?.id ?? null, [msgs])
  const streamId = live ? live.replyId : pendingId
  useEffect(() => {
    if (streamId == null || gone === streamId) return
    return streamAnswer(streamId, {
      onOpen: () => setLive((l) => ({
        question: '', image: null, startedAt: Date.now(), ...(l?.replyId === streamId ? l : {}),
        replyId: streamId, text: '', steps: [], finished: null,
      })),
      onEvent: (e) => {
        setLive((l) => (l && l.replyId === streamId ? apply(l, e) : l))
        if (e.type === 'done') refresh()
      },
      onGone: () => setGone(streamId), // history polling carries on from here
    })
  }, [streamId, gone, refresh])
  // History has the finished answer: it takes over from the overlay.
  useEffect(() => {
    if (live?.replyId == null) return
    const m = msgs.find((x) => x.id === live.replyId)
    if (m && m.status !== 'pending') setLive(null)
  }, [msgs, live])

  const rows = useMemo(() => rowsOf(msgs, live), [msgs, live])
  const runtimeRef = useRef<{ thread: { composer: { setText: (t: string) => void } } } | null>(null)
  const restore = (q: string) => runtimeRef.current?.thread.composer.setText(q)

  async function onNew(m: AppendMessage) {
    const q = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n').trim()
    const part = (m.attachments ?? []).flatMap((a) => a.content).find((p) => p.type === 'image')
    const image = part?.type === 'image' ? part.image : null
    if (!q) { if (image) setErr('Add a question to go with the image.'); return }
    if (q.length > MAX_Q) { setErr(TOO_LONG); restore(q); return }
    setErr(null)
    follow.current = true
    setLive({ replyId: null, question: q, image, startedAt: Date.now(), text: '', steps: [], finished: null })
    try {
      const [head = '', b64 = ''] = (image ?? '').split(',')
      const r = await ask(q, image ? { b64, type: /data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg', dataUrl: image, name: '' } : null)
      setLive((l) => (l && l.replyId == null ? { ...l, replyId: r.reply_id } : l))
      refresh()
    } catch (e) {
      setLive(null)
      const s = status(e)
      if (s === 429) setUntil(Date.now() + ((e as ApiError).retryAfter ?? 10) * 1000)
      else if (s === 503) setOffline(true)
      else if (s === 409) { setErr('Still answering your last one.'); refresh() }
      else if (s === 400) setErr(/too long/i.test((e as ApiError).detail) ? TOO_LONG : (e as ApiError).detail || "Couldn't send that")
      else if (s !== 401) setErr("Couldn't send that. Try again.")
      restore(q)
    }
  }

  const attachments = useMemo(() => imageAdapter(setErr), [])
  const runtime = useExternalStoreRuntime<Row>({
    messages: rows,
    convertMessage: convert,
    isRunning: running,
    isDisabled: loading || signedOut || down,
    isSendDisabled: !!wait,
    onNew,
    onCancel: async () => {
      try { await stopAnswer() } catch { toast("Couldn't stop it", 'error') }
    },
    adapters: { attachments },
    unstable_capabilities: { copy: true },
  })
  runtimeRef.current = runtime

  // Keep the newest text in view while it is written, unless you've scrolled up to read.
  // The page scrolls, and the sticky composer covers the end of the thread, so
  // "in view" means scrolled to the bottom, not the last line being on screen.
  const follow = useRef(true)
  const thread = useRef<HTMLElement>(null)
  useEffect(() => {
    const root = document.scrollingElement ?? document.documentElement
    const onScroll = () => { follow.current = window.innerHeight + window.scrollY >= root.scrollHeight - 160 }
    const ro = new ResizeObserver(() => { if (follow.current) window.scrollTo({ top: root.scrollHeight }) })
    if (thread.current) ro.observe(thread.current)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { ro.disconnect(); window.removeEventListener('scroll', onScroll) }
  }, [])

  async function clear() {
    setConfirmClear(false)
    try {
      await clearThread()
      setLive(null)
      qc.setQueryData<History>(['ask', 'history'], { messages: [], pending: false, count: 0 })
      toast('Conversation cleared', 'success')
    } catch {
      toast("Couldn't clear the conversation", 'error')
    }
  }

  const factCount = facts.data?.total
  const disabledWhy = loading && !signedOut ? 'Loading…' : signedOut ? 'Sign in to ask.' : down ? 'The AI is offline.' : null
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="page page-reading ask-page">
        <div className="ask-head">
          <div className="ask-head-t">
            <h1 className="page-h1" tabIndex={-1}>Ask AI<HelpLink id="ask" /></h1>
            {tools.data?.available && <p className="meta ask-model">{tools.data.model} · {tools.data.tools.length} tools</p>}
          </div>
          <div className="ask-head-b">
            <button type="button" className="btn btn-secondary" aria-haspopup="dialog" onClick={() => setFactsOpen(true)}>
              <span aria-hidden="true">🧠</span>Squad facts{factCount != null && ` (${factCount})`}
            </button>
            <button type="button" className="btn btn-ghost" disabled={!rows.length || running} onClick={() => setConfirmClear(true)}>
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

        <section ref={thread} className="ask-thread" aria-label="Conversation">
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
            <div className="ask-log" role="log" aria-live="polite" aria-relevant="additions">
              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            </div>
          )}
        </section>

        <Composer empty={!rows.length && !loading} running={running} wait={wait} err={err} clearErr={() => setErr(null)}
          disabledWhy={disabledWhy} />

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
    </AssistantRuntimeProvider>
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

// ── Messages ────────────────────────────────────────────────────────────────
const REMARK = [remarkGfm]
const MD_COMPONENTS = {
  a: ({ node: _n, ...p }: ComponentProps<'a'> & { node?: unknown }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
}
const MarkdownText = () => <MarkdownTextPrimitive className="ask-md" remarkPlugins={REMARK} components={MD_COMPONENTS} smooth />
const PlainText = ({ text }: { text: string }) => <p>{text}</p>
const UserImage = ({ image }: { image: string }) => <img className="ask-msg-img" src={image} alt="Attached image" />

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ask-msg" data-role="user">
      <MessagePrimitive.Parts components={{ Text: PlainText, Image: UserImage }} />
    </MessagePrimitive.Root>
  )
}

const label = (tool: string) => tool.replace(/_/g, ' ')
function ToolStep({ toolName, result }: { toolName: string; result?: unknown }) {
  const state = result === undefined ? 'running' : result === 'failed' ? 'failed' : 'done'
  return (
    <li className="ask-step" data-state={state}>
      {state === 'running' ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">{state === 'failed' ? '!' : '✓'}</span>}
      {state === 'running' ? `Looking up ${label(toolName)}…` : state === 'failed' ? `${label(toolName)} didn't answer` : `Looked up ${label(toolName)}`}
    </li>
  )
}
const ToolSteps = ({ children }: PropsWithChildren) => <ul className="ask-steps">{children}</ul>

function Thinking({ since }: { since: number }) {
  const now = useNow(1000)
  const s = Math.max(0, Math.round((now - since) / 1000))
  return (
    <p className="ask-thinking" role="status">
      <span className="ask-dots" aria-hidden="true"><i /><i /><i /></span>
      {s >= 3 ? `thinking… ${s}s` : 'thinking…'}
    </p>
  )
}

const CopyGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
)

function AssistantMessage() {
  const aui = useAui()
  const meta = useAuiState((s) => s.message.metadata?.custom) as (Meta & { error: string }) | undefined
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === 'text' && !!p.text))
  const runningStep = useAuiState((s) => s.message.content.some((p) => p.type === 'tool-call' && p.result === undefined))
  const state = meta?.state ?? 'done'
  if (state === 'error') {
    return (
      <MessagePrimitive.Root className="ask-msg" data-role="assistant" data-status="error">
        <p className="ask-err">Couldn't get an answer</p>
        {meta?.error && <p className="meta">{meta.error}</p>}
        <button type="button" className="btn btn-ghost ask-again" onClick={() => {
          if (meta?.question) aui.thread().composer().setText(meta.question)
          document.getElementById('ask-q')?.focus()
        }}><Icon name="refresh" />Ask again</button>
      </MessagePrimitive.Root>
    )
  }
  const running = state === 'running'
  return (
    <MessagePrimitive.Root className="ask-msg" data-role="assistant" data-status={running ? 'pending' : undefined} aria-busy={running || undefined}>
      <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolStep }, ToolGroup: ToolSteps }} />
      {running && !hasText && !runningStep && <Thinking since={meta?.startedAt ?? Date.now()} />}
      {!running && (
        <div className="ask-meta">
          <span className="meta">{meta?.tools.length ? `${meta.tools.length} lookup${meta.tools.length > 1 ? 's' : ''}` : 'no lookups'}{meta?.elapsed_ms ? ` · ${(meta.elapsed_ms / 1000).toFixed(1)}s` : ''}</span>
          <ActionBarPrimitive.Root className="ask-actions">
            <ActionBarPrimitive.Copy className="icon-btn ask-copy" aria-label="Copy answer">
              <MessagePrimitive.If copied><span aria-hidden="true">✓</span></MessagePrimitive.If>
              <MessagePrimitive.If copied={false}><CopyGlyph /></MessagePrimitive.If>
            </ActionBarPrimitive.Copy>
          </ActionBarPrimitive.Root>
        </div>
      )}
    </MessagePrimitive.Root>
  )
}

// ── Composer ────────────────────────────────────────────────────────────────
function StagedImage() {
  const a = useAuiState((s) => s.attachment)
  const file = 'file' in a ? a.file : undefined
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  return (
    <AttachmentPrimitive.Root className="ask-img">
      {url && <img src={url} alt="" />}
      <span className="meta"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove className="icon-btn" aria-label="Remove image"><Icon name="close" /></AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}

function Composer({ empty, running, wait, err, clearErr, disabledWhy }: {
  empty: boolean; running: boolean; wait: number; err: string | null; clearErr: () => void; disabledWhy: string | null
}) {
  const aui = useAui()
  const text = useAuiState((s) => s.composer.text)
  const staged = useAuiState((s) => s.composer.attachments.length)
  // The draft outlives navigation and a sign-in round trip.
  useEffect(() => {
    const d = loadDraft()
    if (d && !aui.composer().getState().text) aui.composer().setText(d)
  }, [aui])
  useEffect(() => { saveDraft(text); if (text) clearErr() }, [text, clearErr])
  const len = text.length
  const tooLong = len > MAX_Q
  const reason = disabledWhy ?? (wait ? `Try again in ${wait}s.` : null)
  const submit = (e: FormEvent) => { if (tooLong) { e.preventDefault(); e.stopPropagation() } }
  return (
    <div className="ask-dock">
      <Suggestions open={empty} disabled={!!disabledWhy || running || !!wait} />
      <ComposerPrimitive.Root className="glass ask-composer" onSubmitCapture={submit}>
        <label className="field-label" htmlFor="ask-q">Ask something</label>
        <ComposerPrimitive.Attachments components={{ Attachment: StagedImage }} />
        <div className="ask-row">
          <ComposerPrimitive.AddAttachment className="icon-btn ask-attach" aria-label="Attach an image" multiple={false} disabled={!!disabledWhy || staged > 0}>
            <span aria-hidden="true">📎</span>
          </ComposerPrimitive.AddAttachment>
          <ComposerPrimitive.Input id="ask-q" className="input ask-input" rows={1} maxRows={4} placeholder="What's the squad up to?"
            aria-describedby="ask-why" submitMode="enter" />
          {running ? (
            <ComposerPrimitive.Cancel className="btn btn-secondary ask-send" aria-label="Stop the answer">
              <span className="ask-stop" aria-hidden="true" /><span className="ask-send-t">Stop</span>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send className="btn btn-primary ask-send" disabled={tooLong || !!wait}>
              <Icon name="send" /><span className="ask-send-t">Send</span>
            </ComposerPrimitive.Send>
          )}
        </div>
        <div className="ask-foot" id="ask-why">
          {(err || reason) && <span className={err ? 'ask-ferr' : 'meta'} role={err ? 'alert' : 'status'}>{err ?? reason}</span>}
          {len >= 900 && <span className="ask-count num" data-over={tooLong || undefined}>{len}/1000</span>}
        </div>
      </ComposerPrimitive.Root>
    </div>
  )
}

function Suggestions({ open, disabled }: { open: boolean; disabled: boolean }) {
  const chips = (
    <div className="ask-chips" role="group" aria-label="Suggestions">
      {SUGGESTIONS.map(([label, q]) => (
        <ThreadPrimitive.Suggestion key={label} className="chip" prompt={q} send disabled={disabled}>{label}</ThreadPrimitive.Suggestion>
      ))}
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
