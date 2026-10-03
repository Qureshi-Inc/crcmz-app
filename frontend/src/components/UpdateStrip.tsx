// "A new version is ready": the phone apps (and a tab left open) keep one page loaded for
// hours, so they never see a deploy. Checks when the page comes back and every 10 min;
// it never reloads by itself (that would cut off a movie or a call).
import { useEffect, useState } from 'react'

const BUNDLE = /\/app\/assets\/index-[\w-]+\.js/

function loaded(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/app/assets/index-"]')
  return s?.src.match(BUNDLE)?.[0] ?? null
}

export function UpdateStrip() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const mine = loaded()
    if (!mine) return   // a dev server: nothing to compare
    let last = 0
    const check = async () => {
      if (document.hidden || Date.now() - last < 60_000) return
      last = Date.now()
      try {
        const html = await (await fetch('/app/', { cache: 'no-store', credentials: 'same-origin' })).text()
        const live = html.match(BUNDLE)?.[0]
        if (live && live !== mine) setReady(true)
      } catch { /* offline: try again later */ }
    }
    const iv = window.setInterval(check, 10 * 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', check) }
  }, [])
  if (!ready) return null
  return (
    <div className="banner" role="status" style={{ marginBottom: 'var(--space-5)' }}>
      <span style={{ fontWeight: 700 }}>A new version of CRCMZ is ready</span>
      <button type="button" className="btn btn-secondary" onClick={() => location.reload()}>Refresh</button>
    </div>
  )
}
