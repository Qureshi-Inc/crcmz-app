// Friend deck: Moiz's stream deck, live, for the squad. Three sounds plus the Hasaan keys
// (talk, roast, session, stop). Keys mirror the real deck's icons, so Hasaan's
// ready / listening / thinking / speaking shows here as it happens, with what he heard
// and what he's saying. Hold-to-talk keys send "down" on press and "up" on release.
// The allowlist lives on opti3 (Deck Manager `frienddeck.py`); /api/deck is a signed-in proxy.
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError, getJSON, request } from '../../lib/http'
import '../../styles/deck.css'

type DeckKey = { key: string; label: string; group: 'sound' | 'ai'; state: string | null; hold: boolean }
type Buddy = { state?: string | null; error?: string | null; profile?: string | null; session_on?: boolean | null; question?: string | null; reply?: string | null }
type Live = { states: Record<string, string | null>; buddy: Buddy; volume?: number | null; volume_max?: number }
type Layout = Live & { keys: DeckKey[] }

const STATE_TEXT: Record<string, string> = {
  ready: 'Ready, hold Hasaan to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking',
  connecting: 'Connecting…', offline: 'Hasaan is offline', error: 'Hasaan hit an error', off: 'Session is off',
}

function press(key: string, down: boolean) {
  return request('/api/deck/press', { body: { key, down }, timeoutMs: 20_000 })
}

export function DeckPage() {
  useTitle('Deck')
  const navigate = useNavigate()
  const layout = useQuery({ queryKey: ['deck-layout'], queryFn: ({ signal }) => getJSON<Layout>('/api/deck/layout', signal), staleTime: 60_000 })
  const [live, setLive] = useState<Live | null>(null)
  const [online, setOnline] = useState(true)

  // Live state: one SSE stream; EventSource reconnects by itself.
  useEffect(() => {
    const es = new EventSource('/api/deck/events')
    es.onmessage = (e) => { try { setLive(JSON.parse(e.data) as Live); setOnline(true) } catch { /* ping */ } }
    es.addEventListener('offline', () => setOnline(false))
    es.onerror = () => setOnline(false)
    return () => es.close()
  }, [])

  // Keep the phone awake while the deck is open.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    const grab = () => { if (document.visibilityState === 'visible') nav.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {}) }
    grab()
    document.addEventListener('visibilitychange', grab)
    return () => { document.removeEventListener('visibilitychange', grab); lock?.release().catch(() => {}) }
  }, [])

  const now: Live | null = live ?? layout.data ?? null
  const buddy = now?.buddy ?? {}
  const states = now?.states ?? {}
  const hState = !online ? 'offline' : buddy.session_on === false ? 'off' : (buddy.state || 'ready')
  const keys = layout.data?.keys ?? []
  const sounds = keys.filter((k) => k.group === 'sound')
  const ai = keys.filter((k) => k.group === 'ai')

  const fullscreen = () => {
    const el = document.documentElement
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else el.requestFullscreen?.().catch(() => {})
  }

  return (
    <div className="deck-root" data-hstate={hState}>
      <header className="deck-top">
        <span className={`deck-dot${online ? ' on' : ''}`} aria-hidden />
        <span className="deck-title">Moiz's deck</span>
        <span className="deck-sub">{online ? 'live' : 'offline'}</span>
        <span className="deck-spacer" />
        {typeof document.documentElement.requestFullscreen === 'function' && (
          <button type="button" className="deck-icon-btn" onClick={fullscreen} aria-label="Full screen"><Icon name="expand" /></button>
        )}
        <button type="button" className="deck-icon-btn" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} aria-label="Close"><Icon name="close" /></button>
      </header>

      <section className="deck-strip" aria-live="polite">
        <div className="deck-strip-head">
          <span className="deck-pill">{STATE_TEXT[hState] ?? hState}</span>
          {buddy.profile && <span className="deck-profile">{buddy.profile}</span>}
        </div>
        {buddy.error && hState === 'error' && <p className="deck-err">{buddy.error}</p>}
        {buddy.question ? <p className="deck-q">“{buddy.question}”</p> : <p className="deck-q deck-muted">Say something to Hasaan…</p>}
        {buddy.reply && <p className="deck-a">{buddy.reply.trim()}</p>}
      </section>

      <ModelStrip activeLabel={buddy.profile ?? null} />
      <VolumeStrip live={now?.volume ?? null} max={now?.volume_max ?? 150} />

      {layout.isError ? (
        <div className="deck-msg">
          {layout.error instanceof ApiError && layout.error.status === 401
            ? <a className="btn btn-primary" href="/auth/login?next=/app/deck">Sign in to use the deck</a>
            : <><p>The deck isn't answering right now.</p><button type="button" className="btn btn-secondary" onClick={() => layout.refetch()}>Try again</button></>}
        </div>
      ) : (
        <div className="deck-keys">
          <div className="deck-row deck-row-3">{sounds.map((k) => <DeckButton key={k.key} k={k} state={k.state ? states[k.state] : null} />)}</div>
          <div className="deck-row deck-row-4">{ai.map((k) => <DeckButton key={k.key} k={k} state={k.state ? states[k.state] : null} />)}</div>
        </div>
      )}
    </div>
  )
}

/** Soundboard volume (the deck's knob 0), 0-150 %. Over 100 the Pi boosts clips. */
function VolumeStrip({ live, max }: { live: number | null; max: number }) {
  const [draft, setDraft] = useState<number | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const lastSent = useRef(0)
  const value = draft ?? live ?? 100

  const send = (pct: number) => {
    lastSent.current = Date.now()
    request('/api/deck/volume', { body: { pct } }).catch(() => toast("Couldn't set the volume", 'error'))
  }
  const change = (pct: number) => {
    setDraft(pct)
    window.clearTimeout(timer.current)
    // while dragging: at most ~4 updates a second; the last one always goes out
    if (Date.now() - lastSent.current > 250) send(pct)
    else timer.current = window.setTimeout(() => send(pct), 250)
  }
  // once the live value catches up (or someone turns the real knob), follow it again
  useEffect(() => { if (draft !== null && live === draft) setDraft(null) }, [live, draft])
  useEffect(() => {
    if (draft === null) return
    const t = window.setTimeout(() => setDraft(null), 4000)
    return () => window.clearTimeout(t)
  }, [draft])

  const boost = value > 100
  return (
    <section className={`deck-vol${boost ? ' boost' : ''}`} aria-label="Soundboard volume">
      <span className="deck-models-label">Sounds</span>
      <input type="range" min={0} max={max} step={5} value={value}
        style={{ ['--fill' as string]: `${(value / max) * 100}%`, ['--mark' as string]: `${(100 / max) * 100}%` }}
        onChange={(e) => change(Number(e.target.value))} aria-valuetext={`${value}%`} />
      <span className="deck-vol-val">{value}%{boost && <em> boost</em>}</span>
    </section>
  )
}

type Model = { id: string; label: string; kind?: string | null }

/** The deck's touch-strip "tap: next model" panel, as a picker: every voice model, live. */
function ModelStrip({ activeLabel }: { activeLabel: string | null }) {
  const models = useQuery({ queryKey: ['deck-models'], queryFn: ({ signal }) => getJSON<{ active: string | null; models: Model[] }>('/api/deck/models', signal), staleTime: 60_000, refetchInterval: 60_000 })
  const [pending, setPending] = useState<string | null>(null)
  const list = models.data?.models ?? []
  // The live stream says which model is on (by label), so a switch from the real deck shows here too.
  const active = list.find((m) => m.label === activeLabel)?.id ?? models.data?.active ?? null
  useEffect(() => { if (pending && pending === active) setPending(null) }, [pending, active])
  if (!list.length) return null

  const pick = (m: Model) => {
    if (m.id === active || pending) return
    setPending(m.id)
    navigator.vibrate?.(12)
    request('/api/deck/model', { body: { id: m.id }, timeoutMs: 30_000 })
      .then(() => toast(`Hasaan is now ${m.label.replace(/^Local · /, '')}`, 'success'))
      .catch((err) => { setPending(null); toast(err instanceof ApiError ? err.detail || "Couldn't switch" : "Couldn't reach the deck", 'error') })
      .finally(() => window.setTimeout(() => setPending((p) => (p === m.id ? null : p)), 8000))
  }

  return (
    <section className="deck-models" aria-label="Voice model">
      <span className="deck-models-label">Voice</span>
      <div className="deck-models-list">
        {list.map((m) => (
          <button key={m.id} type="button" onClick={() => pick(m)}
            className={`deck-model${m.id === active ? ' on' : ''}${m.id === pending ? ' pending' : ''}`}
            data-kind={m.kind || undefined} aria-pressed={m.id === active}>
            {m.label.replace(/^Local · /, '')}
          </button>
        ))}
      </div>
    </section>
  )
}

function DeckButton({ k, state }: { k: DeckKey; state: string | null | undefined }) {
  const [down, setDown] = useState(false)
  const held = useRef(false)

  const release = useCallback(() => {
    if (!held.current) return
    held.current = false
    setDown(false)
    if (k.hold) press(k.key, false).catch(() => {})
  }, [k.key, k.hold])

  // A hold must never outlive the page: leaving the tab lets go of the key.
  useEffect(() => {
    const off = () => { if (document.visibilityState === 'hidden') release() }
    document.addEventListener('visibilitychange', off)
    window.addEventListener('pagehide', release)
    return () => { document.removeEventListener('visibilitychange', off); window.removeEventListener('pagehide', release); release() }
  }, [release])

  const onDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    held.current = true
    setDown(true)
    navigator.vibrate?.(12)
    press(k.key, true).catch((err) => {
      if (err instanceof ApiError && err.status === 429) return
      toast(err instanceof ApiError ? err.detail || "The deck didn't take that" : "Couldn't reach the deck", 'error')
    })
    if (!k.hold) window.setTimeout(() => { held.current = false; setDown(false) }, 160)
  }

  const src = `/api/deck/icon/${k.key}${state ? `?state=${encodeURIComponent(state)}` : ''}`
  return (
    <button
      type="button"
      className={`deck-key${down ? ' down' : ''}${k.hold ? ' hold' : ''}`}
      data-state={state || undefined}
      onPointerDown={onDown}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
      aria-label={k.hold ? `${k.label} (hold)` : k.label}
    >
      <img src={src} alt="" draggable={false} />
      <span className="deck-label">{k.label}</span>
    </button>
  )
}
