// Soundboard: shared audio clips — upload, preview on the squad Pi, delete.
import { useRef, useState } from 'react'
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
type ListResp = { sounds: AudioSound[]; builtins: string[] }

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
          title="Play on squad Pi" onClick={onPlay} disabled={playing}
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

// ── Main page ──────────────────────────────────────────────────────────────────
export function AudioSoundsPage() {
  useTitle('Soundboard')
  const qc = useQueryClient()
  const [playing, setPlaying] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['audio-sounds'],
    queryFn: ({ signal }) => getJSON<ListResp>('/api/audio-sounds', signal),
  })

  const allSounds = [
    ...(list.data?.builtins ?? []).map((name) => ({ name, size: 0, type: 'builtin' as const })),
    ...(list.data?.sounds ?? []),
  ]

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['audio-sounds'] })
  }

  async function handlePlay(name: string) {
    if (playing === name) return
    setPlaying(name)
    try {
      await request(`/api/audio-sounds/${encodeURIComponent(name)}/play`, { method: 'POST' })
      ok(`Playing "${name}"`)
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

  return (
    <div className="page">
      <h1 className="page-h1" tabIndex={-1}>
        <Icon name="megaphone" className="nav-icon" />
        {' '}Soundboard
      </h1>

      {/* Upload (web only) */}
      {!nativeShell() && (
        <section className="glass audio-section" aria-labelledby="upload-h">
          <h2 className="section-h2" id="upload-h" style={{ marginBottom: 'var(--space-3)' }}>Upload a Sound</h2>
          <UploadZone onUploaded={invalidate} />
        </section>
      )}

      {/* Sound list */}
      <section className="glass audio-section" aria-labelledby="sounds-h">
        <h2 className="section-h2" id="sounds-h" style={{ marginBottom: 'var(--space-3)' }}>Sounds</h2>
        {list.isLoading && <SkeletonRows n={3} />}
        {list.error && <ErrorStrip text="Couldn't load sounds" onRetry={() => void list.refetch()} />}
        {!list.isLoading && allSounds.length === 0 && (
          <p style={{ color: 'var(--text-dim)', margin: 0 }}>No sounds yet. Drop an audio file above to get started.</p>
        )}
        {allSounds.length > 0 && (
          <div className="audio-sounds-grid">
            {allSounds.map((s) => (
              <SoundCard
                key={s.name}
                sound={{ name: s.name, size: s.size, type: 'custom' }}
                playing={playing === s.name}
                onPlay={() => void handlePlay(s.name)}
                onDelete={() => void handleDelete(s.name)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
