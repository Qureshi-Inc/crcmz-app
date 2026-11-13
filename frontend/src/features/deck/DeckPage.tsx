// Friend deck: Moiz's stream deck, live, for the squad. Laid out like the real thing:
// the keys (deck sounds, the squad's own sounds, then Hasaan's talk / roast / session /
// stop), and under them the deck's touch strip, drawn by the deck's own renderer.
// Strip: drag SOUNDBOARD to turn the volume (0-150 %), tap it to stop sounds; tap HASAAN
// for the next voice model; tap LAST REPLY to read it all. MIC is Moiz's.
// Allowlist + live state: Deck Manager `frienddeck.py` on opti3; /api/deck is a signed-in proxy.
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as RPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ApiError, getJSON, request } from '../../lib/http'
import '../../styles/deck.css'

type DeckKey = { key: string; label: string; group: 'sound' | 'ai'; state: string | null; hold: boolean }
type Live = { states: Record<string, string | null>; volume?: number | null; volume_max?: number; strip?: string | null }
type Layout = Live & { keys: DeckKey[] }
type Custom = { name: string; label: string; by?: string | null; custom_image: boolean }

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.detail || fallback : fallback)

function press(key: string, down: boolean) {
  return request('/api/deck/press', { body: { key, down }, timeoutMs: 20_000 })
}

function hash(s: string) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function DeckPage() {
  useTitle('Deck')
  const navigate = useNavigate()
  const layout = useQuery({ queryKey: ['deck-layout'], queryFn: ({ signal }) => getJSON<Layout>('/api/deck/layout', signal), staleTime: 60_000 })
  const customs = useQuery({ queryKey: ['deck-sounds'], queryFn: ({ signal }) => getJSON<{ sounds: Custom[]; max: number }>('/api/deck/sounds', signal), refetchInterval: 30_000 })
  const [live, setLive] = useState<Live | null>(null)
  const [online, setOnline] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editor, setEditor] = useState<Custom | 'new' | null>(null)
  const [iconVer, setIconVer] = useState(0)

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
  const states = now?.states ?? {}
  const keys = layout.data?.keys ?? []
  const sounds = keys.filter((k) => k.group === 'sound')
  const ai = keys.filter((k) => k.group === 'ai')
  const mine = customs.data?.sounds ?? []
  const full = mine.length >= (customs.data?.max ?? 40)

  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    else document.documentElement.requestFullscreen?.().catch(() => {})
  }

  return (
    <div className="deck-root">
      <header className="deck-top">
        <span className={`deck-dot${online ? ' on' : ''}`} aria-hidden />
        <span className="deck-title">Moiz's deck</span>
        <span className="deck-sub">{online ? 'live' : 'offline'}</span>
        <span className="deck-spacer" />
        <button type="button" className={`deck-icon-btn${editing ? ' on' : ''}`} onClick={() => setEditing((e) => !e)} aria-pressed={editing} aria-label="Edit sounds"><Icon name="edit" /></button>
        {typeof document.documentElement.requestFullscreen === 'function' && (
          <button type="button" className="deck-icon-btn" onClick={fullscreen} aria-label="Full screen"><Icon name="expand" /></button>
        )}
        <button type="button" className="deck-icon-btn" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))} aria-label="Close"><Icon name="close" /></button>
      </header>

      {layout.isError ? (
        <div className="deck-msg">
          {layout.error instanceof ApiError && layout.error.status === 401
            ? <a className="btn btn-primary" href="/auth/login?next=/app/deck">Sign in to use the deck</a>
            : <><p>The deck isn't answering right now.</p><button type="button" className="btn btn-secondary" onClick={() => layout.refetch()}>Try again</button></>}
        </div>
      ) : (
        <div className="deck-body">
          <div className="deck-sounds">
            {sounds.map((k) => <DeckButton key={k.key} k={k} state={null} small />)}
            {mine.map((c) => (
              <CustomButton key={c.name} c={c} ver={iconVer} editing={editing} onEdit={() => setEditor(c)} />
            ))}
            {!full && (
              <button type="button" className="deck-key small deck-add" onClick={() => setEditor('new')} aria-label="Add a sound">
                <span className="deck-add-tile"><Icon name="plus" /></span>
                <span className="deck-label">Add sound</span>
              </button>
            )}
          </div>
          {editing && <p className="deck-hint">Tap a sound you added to change its name, picture or sound.</p>}
          <div className="deck-row deck-row-4">{ai.map((k) => <DeckButton key={k.key} k={k} state={k.state ? states[k.state] : null} />)}</div>
          <DeckStrip sig={now?.strip ?? null} volume={now?.volume ?? null} max={now?.volume_max ?? 150} />
        </div>
      )}

      {editor && (
        <SoundEditor
          sound={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); setIconVer((v) => v + 1); customs.refetch() }}
        />
      )}
    </div>
  )
}

// ── the touch strip ───────────────────────────────────────────────────────────

function DeckStrip({ sig, volume, max }: { sig: string | null; volume: number | null; max: number }) {
  const [view, setView] = useState<'main' | 'reply'>('main')
  const [shown, setShown] = useState<string | null>(null)
  const [flash, setFlash] = useState<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; start: number; moved: boolean; timer?: number } | null>(null)
  const lastSent = useRef(0)
  const replyTimer = useRef<number | undefined>(undefined)

  // Load the new frame off-screen, then swap: no flicker, at most ~3 frames a second.
  const wanted = `/api/deck/strip.jpg?view=${view}&v=${sig ? hash(sig) : '0'}`
  useEffect(() => {
    let dead = false
    const t = window.setTimeout(() => {
      const img = new Image()
      img.onload = () => { if (!dead) setShown(wanted) }
      img.src = wanted
    }, shown ? 300 : 0)
    return () => { dead = true; window.clearTimeout(t) }
  }, [wanted]) // eslint-disable-line react-hooks/exhaustive-deps

  const tapFx = (i: number) => { setFlash(i); navigator.vibrate?.(12); window.setTimeout(() => setFlash((f) => (f === i ? null : f)), 450) }

  const tap = (panel: number) => {
    if (view === 'reply') { setView('main'); window.clearTimeout(replyTimer.current); return }
    if (panel === 2) { toast("The mic and headset are Moiz's", 'info'); return }
    tapFx(panel)
    if (panel === 3) {
      setView('reply')
      window.clearTimeout(replyTimer.current)
      replyTimer.current = window.setTimeout(() => setView('main'), 15_000)
      return
    }
    request('/api/deck/strip', { body: { panel: String(panel) } }).catch((e) => {
      if (!(e instanceof ApiError && e.status === 429)) toast(errText(e, "The deck didn't take that"), 'error')
    })
  }

  const sendVol = (pct: number) => {
    lastSent.current = Date.now()
    request('/api/deck/volume', { body: { pct } }).catch(() => toast("Couldn't set the volume", 'error'))
  }

  // SOUNDBOARD panel: drag sideways = turn the knob, a tap = stop sounds.
  const volDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (view === 'reply') return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, start: volume ?? 100, moved: false }
  }
  const volMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < 8) return
    d.moved = true
    const width = box.current?.clientWidth ?? 360
    const pct = Math.max(0, Math.min(max, Math.round(d.start + (dx / (width * 0.6)) * max)))
    setDrag(pct)
    window.clearTimeout(d.timer)
    if (Date.now() - lastSent.current > 250) sendVol(pct)
    else d.timer = window.setTimeout(() => sendVol(pct), 250)
  }
  const volUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || !d.moved) return tap(0)
    window.setTimeout(() => setDrag(null), 900)
  }

  return (
    <div className="deck-lcd" ref={box}>
      {shown ? <img src={shown} alt="Deck touch strip" draggable={false} /> : <div className="deck-lcd-blank" />}
      {view === 'reply' ? (
        <button type="button" className="deck-zone deck-zone-all" onClick={() => tap(0)} aria-label="Close the reply" />
      ) : (
        <>
          <div className="deck-zone" style={{ left: 0 }} onPointerDown={volDown} onPointerMove={volMove} onPointerUp={volUp}
            onPointerCancel={() => { dragRef.current = null; setDrag(null) }} role="slider" aria-label="Soundboard volume: drag to change, tap to stop sounds"
            aria-valuemin={0} aria-valuemax={max} aria-valuenow={drag ?? volume ?? 0} tabIndex={0}
            data-panel={0} data-flash={flash === 0 || undefined} />
          {[1, 2, 3].map((i) => (
            <button key={i} type="button" className="deck-zone" style={{ left: `${i * 25}%` }} onClick={() => tap(i)}
              data-panel={i} data-flash={flash === i || undefined} aria-label={['', 'Next voice model', 'Mic (Moiz only)', 'Show the whole reply'][i]} />
          ))}
          {drag !== null && <div className={`deck-vol-pop${drag > 100 ? ' boost' : ''}`}>{drag}%</div>}
        </>
      )}
    </div>
  )
}

// ── keys ──────────────────────────────────────────────────────────────────────

function DeckButton({ k, state, small }: { k: DeckKey; state: string | null | undefined; small?: boolean }) {
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
      toast(errText(err, "Couldn't reach the deck"), 'error')
    })
    if (!k.hold) window.setTimeout(() => { held.current = false; setDown(false) }, 160)
  }

  const src = `/api/deck/icon/${k.key}${state ? `?state=${encodeURIComponent(state)}` : ''}`
  return (
    <button
      type="button"
      className={`deck-key${small ? ' small' : ''}${down ? ' down' : ''}${k.hold ? ' hold' : ''}`}
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

function CustomButton({ c, ver, editing, onEdit }: { c: Custom; ver: number; editing: boolean; onEdit: () => void }) {
  const [down, setDown] = useState(false)
  const [broken, setBroken] = useState(false)
  // A fresh clip's made-for-you picture takes a few seconds: retry the image for a while.
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!broken || retry > 6) return
    const t = window.setTimeout(() => { setBroken(false); setRetry((r) => r + 1) }, 5000)
    return () => window.clearTimeout(t)
  }, [broken, retry])

  const play = () => {
    if (editing) return onEdit()
    setDown(true)
    navigator.vibrate?.(12)
    window.setTimeout(() => setDown(false), 160)
    request(`/api/deck/sounds/${encodeURIComponent(c.name)}/play`, { method: 'POST', body: {} }).catch((e) => {
      if (!(e instanceof ApiError && e.status === 429)) toast(errText(e, "Couldn't play it"), 'error')
    })
  }
  return (
    <button type="button" className={`deck-key small${down ? ' down' : ''}${editing ? ' editing' : ''}`} onClick={play}
      onContextMenu={(e) => { e.preventDefault(); onEdit() }} aria-label={editing ? `Edit ${c.label}` : c.label}>
      {broken
        ? <span className="deck-add-tile deck-initials">{c.label.slice(0, 2).toUpperCase()}</span>
        : <img src={`/api/deck/sounds/${encodeURIComponent(c.name)}/icon?v=${ver}-${retry}`} alt="" draggable={false} onError={() => setBroken(true)} />}
      {editing && <span className="deck-edit-badge"><Icon name="edit" /></span>}
      <span className="deck-label">{c.label}</span>
    </button>
  )
}

// ── add / edit a sound ────────────────────────────────────────────────────────

const isYouTube = (u: string) => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(u.trim())

function SoundEditor({ sound, onClose, onSaved }: { sound: Custom | null; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState(sound?.label ?? '')
  const [mode, setMode] = useState<'keep' | 'file' | 'link'>(sound ? 'keep' : 'link')
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [start, setStart] = useState('')
  const [length, setLength] = useState('8')
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [clearImage, setClearImage] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!image) { setPreview(null); return }
    const u = URL.createObjectURL(image)
    setPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [image])

  const current = sound && !clearImage ? `/api/deck/sounds/${encodeURIComponent(sound.name)}/icon` : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!sound && mode === 'file' && !file) return toast('Pick a sound file', 'error')
    if (!sound && mode === 'link' && !url.trim()) return toast('Paste a YouTube or sound link', 'error')
    const fd = new FormData()
    fd.append('label', label.trim())
    if (mode === 'file' && file) fd.append('file', file)
    if (mode === 'link' && url.trim()) {
      fd.append('url', url.trim())
      if (isYouTube(url)) { fd.append('start', start); fd.append('length', length) }
    }
    if (image) fd.append('image', image)
    if (clearImage && !image) fd.append('clear_image', 'true')
    setBusy(true)
    try {
      const res = await fetch(sound ? `/api/deck/sounds/${encodeURIComponent(sound.name)}` : '/api/deck/sounds',
        { method: 'POST', body: fd, credentials: 'same-origin' })
      const j = (await res.json().catch(() => ({}))) as { detail?: string }
      if (!res.ok) throw new Error(j.detail || 'That didn’t save')
      toast(sound ? 'Saved' : `Added ${label.trim() || 'your sound'}`, 'success')
      qc.invalidateQueries({ queryKey: ['audio-sounds'] })
      onSaved()
    } catch (err) {
      toast((err as Error).message || 'That didn’t save', 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!sound || !window.confirm(`Take “${sound.label}” off the deck? It stays on the Soundboard page.`)) return
    setBusy(true)
    try {
      await request(`/api/deck/sounds/${encodeURIComponent(sound.name)}`, { method: 'DELETE' })
      onSaved()
    } catch (err) {
      toast(errText(err, "Couldn't remove it"), 'error')
      setBusy(false)
    }
  }

  return (
    <div className="deck-modal-scrim" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <form className="deck-modal" onSubmit={submit}>
        <header className="deck-modal-head">
          <h2>{sound ? 'Edit sound' : 'Add a sound'}</h2>
          <button type="button" className="deck-icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" /></button>
        </header>

        <div className="deck-modal-row">
          <label className="deck-pic">
            {preview || current
              ? <img src={preview ?? current ?? ''} alt="" onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
              : <span className="deck-pic-empty"><Icon name="plus" /><small>Picture</small></span>}
            <input type="file" accept="image/*" onChange={(e) => { setImage(e.target.files?.[0] ?? null); setClearImage(false) }} hidden />
          </label>
          <div className="deck-modal-col">
            <label className="deck-field">
              <span>Name</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Bruh" />
            </label>
            <small className="deck-muted">Tap the square to pick a picture.{!image && ' No picture? One gets made for you.'}</small>
            {sound && (image || (sound.custom_image && !clearImage)) && (
              <button type="button" className="deck-link" onClick={() => { setImage(null); setClearImage(true) }}>Use the made-for-you picture</button>
            )}
          </div>
        </div>

        <div className="deck-seg" role="tablist">
          {sound && <button type="button" className={mode === 'keep' ? 'on' : ''} onClick={() => setMode('keep')}>Keep sound</button>}
          <button type="button" className={mode === 'link' ? 'on' : ''} onClick={() => setMode('link')}>YouTube / link</button>
          <button type="button" className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>Upload</button>
        </div>

        {mode === 'link' && (
          <>
            <label className="deck-field">
              <span>Link</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://youtu.be/… or a MyInstants page" />
            </label>
            {isYouTube(url) && (
              <div className="deck-modal-row">
                <label className="deck-field"><span>Start at</span><input value={start} onChange={(e) => setStart(e.target.value)} placeholder="0:00" inputMode="numeric" /></label>
                <label className="deck-field"><span>Length (sec)</span><input value={length} onChange={(e) => setLength(e.target.value)} inputMode="decimal" /></label>
              </div>
            )}
          </>
        )}
        {mode === 'file' && (
          <label className="deck-field">
            <span>Sound or video file</span>
            <input type="file" accept="audio/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}

        <footer className="deck-modal-foot">
          {sound && <button type="button" className="btn btn-secondary deck-danger" onClick={remove} disabled={busy}>Remove</button>}
          <span className="deck-spacer" />
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? (mode === 'link' && isYouTube(url) ? 'Grabbing it…' : 'Saving…') : sound ? 'Save' : 'Add'}</button>
        </footer>
      </form>
    </div>
  )
}
