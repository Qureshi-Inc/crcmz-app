// Audio Soundboard: upload sounds, preview them, assign to stream deck slots.
// Stream deck soundboard.yaml is updated server-side on every deck save.
import { useCallback, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/toast'
import { ErrorStrip, SkeletonRows } from '../../components/states'
const ok = (t: string) => toast(t, 'success')
const err = (t: string) => toast(t, 'error')
import { ApiError, getJSON, request } from '../../lib/http'
import { nativeShell } from '../../lib/nativeShell'

type AudioSound = { name: string; size: number; type: 'custom' }
type SlotInfo = { type: 'builtin' | 'custom'; name: string } | null
type DeckConfig = { slots: Record<string, SlotInfo> }
type ListResp = { sounds: AudioSound[]; builtins: string[] }

const SLOT_COUNT = 9

function fmtSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(0)} KB`
}

// ── Sound card ────────────────────────────────────────────────────────────────
function SoundCard({ sound, playing, onPlay, onDelete }: {
  sound: AudioSound; playing: boolean; onPlay: () => void; onDelete: () => void
}) {
  return (
    <div className="audio-sound-card">
      <span className="audio-sound-name">{sound.name}</span>
      <span className="audio-sound-meta">{fmtSize(sound.size)}</span>
      <div className="audio-sound-actions">
        <button
          type="button" className={`btn btn-icon${playing ? ' btn-icon--active' : ''}`}
          title="Preview on headset" onClick={onPlay} disabled={playing}
        >
          <Icon name="play" />
        </button>
        <button
          type="button" className="btn btn-icon" title="Delete"
          onClick={onDelete}
          style={{ color: 'var(--text-dim)' }}
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  )
}

// ── Deck slot ─────────────────────────────────────────────────────────────────
function DeckSlot({ index, info, pending, onClick }: {
  index: number; info: SlotInfo; pending: boolean; onClick: () => void
}) {
  const label = info ? info.name : '—'
  const tag = info ? (info.type === 'builtin' ? 'built-in' : 'custom') : 'empty'
  return (
    <button
      type="button"
      className={`deck-slot${!info ? ' deck-slot--empty' : ''}${pending ? ' deck-slot--pending' : ''}`}
      onClick={onClick}
    >
      <span className="deck-slot-index">{index + 1}</span>
      <span className="deck-slot-name">{label}</span>
      <span className="deck-slot-tag">{tag}</span>
    </button>
  )
}

// ── Upload zone ───────────────────────────────────────────────────────────────
function UploadZone({ onUploaded }: { onUploaded: () => void }) {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function uploadFile(file: File) {
    const clean = file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '')
    const name = clean.replace(/\.[^.]+$/, '').slice(0, 40) || 'sound'
    const fd = new FormData()
    fd.append('file', file, `${name}.wav`)
    setBusy(true)
    try {
      const res = await fetch('/api/audio-sounds/upload', {
        method: 'POST', credentials: 'same-origin', body: fd,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({ detail: 'Upload failed' }))
        err((j as { detail?: string }).detail || 'Upload failed')
        return
      }
      const j = await res.json() as { name: string }
      ok(`Uploaded "${j.name}"`)
      onUploaded()
    } catch {
      err('Upload failed — network error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`upload-zone${dragging ? ' upload-zone--drag' : ''}${busy ? ' upload-zone--busy' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f) }}
      onClick={() => !busy && inputRef.current?.click()}
      role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      aria-label="Upload audio file"
    >
      <Icon name="download" />
      <span className="upload-zone-label">{busy ? 'Uploading…' : 'Drop audio here or click to upload'}</span>
      <span className="upload-zone-hint">WAV · MP3 · M4A · max 20 MB</span>
      <input
        ref={inputRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = '' }}
      />
    </div>
  )
}

// ── Sound picker dialog ────────────────────────────────────────────────────────
function SoundPicker({ slot, builtins, customs, current, onSelect, onClose }: {
  slot: number; builtins: string[]; customs: AudioSound[]; current: SlotInfo
  onSelect: (info: SlotInfo) => void; onClose: () => void
}) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog" aria-describedby={undefined}>
          <div className="dialog-title-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
            <Dialog.Title className="dialog-title" style={{ margin: 0 }}>Slot {slot + 1}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="btn btn-icon"><Icon name="close" /></button>
            </Dialog.Close>
          </div>
          {current && (
            <button type="button" className="btn btn-secondary" style={{ marginBottom: 'var(--space-3)' }} onClick={() => onSelect(null)}>
              Clear slot
            </button>
          )}
          {builtins.length > 0 && (
            <section>
              <p className="picker-section-label">Built-in</p>
              <div className="picker-grid">
                {builtins.map((n) => (
                  <button key={n} type="button"
                    className={`picker-item${current?.name === n && current?.type === 'builtin' ? ' picker-item--active' : ''}`}
                    onClick={() => onSelect({ type: 'builtin', name: n })}
                  >{n}</button>
                ))}
              </div>
            </section>
          )}
          {customs.length > 0 && (
            <section style={{ marginTop: 'var(--space-4)' }}>
              <p className="picker-section-label">Your uploads</p>
              <div className="picker-grid">
                {customs.map((s) => (
                  <button key={s.name} type="button"
                    className={`picker-item${current?.name === s.name && current?.type === 'custom' ? ' picker-item--active' : ''}`}
                    onClick={() => onSelect({ type: 'custom', name: s.name })}
                  >{s.name}</button>
                ))}
              </div>
            </section>
          )}
          {builtins.length === 0 && customs.length === 0 && (
            <p style={{ color: 'var(--text-dim)' }}>No sounds available — upload one first.</p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export function AudioSoundsPage() {
  useTitle('Sounds')
  const qc = useQueryClient()
  const [playing, setPlaying] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null)
  const [savingDeck, setSavingDeck] = useState(false)
  const [pendingSlots, setPendingSlots] = useState<Record<string, SlotInfo>>({})

  const list = useQuery({
    queryKey: ['audio-sounds'],
    queryFn: ({ signal }) => getJSON<ListResp>('/api/audio-sounds', signal),
  })
  const deck = useQuery({
    queryKey: ['audio-sounds-deck'],
    queryFn: ({ signal }) => getJSON<DeckConfig>('/api/audio-sounds/deck', signal),
  })

  const effectiveSlots: Record<string, SlotInfo> = { ...(deck.data?.slots ?? {}), ...pendingSlots }
  const hasPending = Object.keys(pendingSlots).length > 0
  const sounds = list.data?.sounds ?? []
  const builtins = list.data?.builtins ?? []

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['audio-sounds'] })
    qc.invalidateQueries({ queryKey: ['audio-sounds-deck'] })
  }, [qc])

  async function handlePlay(name: string) {
    if (playing === name) return
    setPlaying(name)
    try {
      await request(`/api/audio-sounds/${encodeURIComponent(name)}/play`, { method: 'POST' })
      ok(`Playing "${name}" on headset`)
    } catch (e) {
      err(e instanceof ApiError ? e.detail : 'Playback failed')
    } finally { setPlaying(null) }
  }

  async function handleDelete(name: string) {
    try {
      await request(`/api/audio-sounds/${encodeURIComponent(name)}`, { method: 'DELETE' })
      ok(`Deleted "${name}"`)
      invalidate()
    } catch (e) {
      err(e instanceof ApiError ? e.detail : 'Delete failed')
    }
  }

  async function saveDeck() {
    setSavingDeck(true)
    try {
      await request('/api/audio-sounds/deck', { method: 'POST', body: { slots: pendingSlots } })
      ok('Deck saved — soundboard.yaml updated')
      setPendingSlots({})
      invalidate()
    } catch (e) {
      err(e instanceof ApiError ? e.detail : 'Save failed')
    } finally { setSavingDeck(false) }
  }

  return (
    <div className="page">
      <h1 className="page-h1" tabIndex={-1}>
        <Icon name="megaphone" className="nav-icon" />
        {' '}Sounds
      </h1>

      {/* Deck Layout */}
      <section className="glass audio-section" aria-labelledby="deck-h">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <h2 className="section-h2" id="deck-h" style={{ margin: 0 }}>Stream Deck Layout</h2>
          {hasPending && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveDeck()} disabled={savingDeck}>
              {savingDeck ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
        <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--text-dim)' }}>
          Click a slot to change its sound. Slot 10 always goes home.
        </p>
        {(list.isLoading || deck.isLoading) && <SkeletonRows n={2} />}
        {!list.isLoading && !deck.isLoading && (
          <div className="deck-grid">
            {Array.from({ length: SLOT_COUNT }, (_, i) => (
              <DeckSlot
                key={i} index={i} info={effectiveSlots[String(i)] ?? null}
                pending={String(i) in pendingSlots}
                onClick={() => setSelectedSlot(i)}
              />
            ))}
            <div className="deck-slot deck-slot--home">
              <span className="deck-slot-index">10</span>
              <span className="deck-slot-name">Home</span>
              <span className="deck-slot-tag">fixed</span>
            </div>
          </div>
        )}
      </section>

      {/* Upload (web only) */}
      {!nativeShell() && (
        <section className="glass audio-section" aria-labelledby="upload-h">
          <h2 className="section-h2" id="upload-h" style={{ marginBottom: 'var(--space-3)' }}>Upload a Sound</h2>
          <UploadZone onUploaded={invalidate} />
        </section>
      )}

      {/* Custom sounds */}
      <section className="glass audio-section" aria-labelledby="sounds-h">
        <h2 className="section-h2" id="sounds-h" style={{ marginBottom: 'var(--space-3)' }}>Your Sounds</h2>
        {list.isLoading && <SkeletonRows n={3} />}
        {list.error && <ErrorStrip text="Couldn't load sounds" onRetry={() => void list.refetch()} />}
        {!list.isLoading && sounds.length === 0 && (
          <p style={{ color: 'var(--text-dim)', margin: 0 }}>No uploads yet. Drop an audio file above to get started.</p>
        )}
        {sounds.length > 0 && (
          <div className="audio-sounds-grid">
            {sounds.map((s) => (
              <SoundCard
                key={s.name} sound={s} playing={playing === s.name}
                onPlay={() => void handlePlay(s.name)}
                onDelete={() => void handleDelete(s.name)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Sound picker */}
      {selectedSlot !== null && (
        <SoundPicker
          slot={selectedSlot} builtins={builtins} customs={sounds}
          current={effectiveSlots[String(selectedSlot)] ?? null}
          onSelect={(info) => { setPendingSlots((p) => ({ ...p, [String(selectedSlot)]: info })); setSelectedSlot(null) }}
          onClose={() => setSelectedSlot(null)}
        />
      )}
    </div>
  )
}
