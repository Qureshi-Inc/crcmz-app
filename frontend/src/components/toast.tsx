// G-06 · one global toast stack. Polite for status, assertive for errors. Shows for
// at least 2 s (4 s for errors) and can always be dismissed with a visible button.
import { useEffect, useSyncExternalStore } from 'react'
import { Icon } from './Icon'

export type Tone = 'success' | 'error' | 'warning' | 'info'
type Toast = { id: number; text: string; tone: Tone }

let toasts: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function toast(text: string, tone: Tone = 'info') {
  const id = ++seq
  // Newest last; cap the stack so a burst never covers the screen.
  toasts = [...toasts.filter((t) => t.text !== text), { id, text, tone }].slice(-3)
  emit()
  window.setTimeout(() => dismiss(id), tone === 'error' || tone === 'warning' ? 5000 : 2800)
}
export function dismiss(id: number) {
  const next = toasts.filter((t) => t.id !== id)
  if (next.length !== toasts.length) { toasts = next; emit() }
}

function useToasts() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => toasts)
}

// Screen-reader-only announcements that should not also pop a toast ("Sent").
let announcement = { text: '', n: 0 }
const aListeners = new Set<() => void>()
export function announce(text: string) {
  announcement = { text, n: announcement.n + 1 }
  aListeners.forEach((l) => l())
}

export function Toaster() {
  const list = useToasts()
  const a = useSyncExternalStore((cb) => { aListeners.add(cb); return () => { aListeners.delete(cb) } }, () => announcement)
  useEffect(() => {
    if (!a.text) return
    const t = window.setTimeout(() => { announcement = { text: '', n: a.n }; aListeners.forEach((l) => l()) }, 3000)
    return () => window.clearTimeout(t)
  }, [a])
  const polite = list.filter((t) => t.tone !== 'error')
  const assertive = list.filter((t) => t.tone === 'error')
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">{a.text}</div>
      <div className="toasts">
        <div role="status" aria-live="polite" style={{ display: 'contents' }}>
          {polite.map((t) => <ToastRow key={t.id} t={t} />)}
        </div>
        <div role="alert" aria-live="assertive" style={{ display: 'contents' }}>
          {assertive.map((t) => <ToastRow key={t.id} t={t} />)}
        </div>
      </div>
    </>
  )
}

function ToastRow({ t }: { t: Toast }) {
  return (
    <div className="toast" data-tone={t.tone}>
      <span className="toast-text">{t.text}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
        <Icon name="close" />
      </button>
    </div>
  )
}
