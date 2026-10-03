// One-time nudge on a phone browser. Android gets the browser's own install sheet; an
// iPhone gets pointed at the real app on TestFlight (Get the app).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './Icon'
import { promptInstall, useInstall } from '../lib/pwa'

const KEY = 'crcmz_install_dismissed'

export function InstallStrip() {
  const state = useInstall()
  const [gone, setGone] = useState(() => { try { return !!localStorage.getItem(KEY) } catch { return true } })
  if (gone || (state !== 'prompt' && state !== 'ios')) return null
  const dismiss = () => { try { localStorage.setItem(KEY, '1') } catch { /* private mode */ } setGone(true) }
  return (
    <div className="banner install-strip" role="region" aria-label="Install the app" style={{ marginBottom: 'var(--space-5)' }}>
      <img src="/app/pwa/icon-192.png" alt="" width={36} height={36} className="install-icon" />
      <span className="install-text">
        <strong>Get the CRCMZ app</strong>
        {state === 'ios'
          ? <span className="dim">The iPhone app is on TestFlight: calls that ring, picture in picture, music with the screen locked.</span>
          : <span className="dim">Full screen, lock-screen controls and notifications.</span>}
      </span>
      {state === 'prompt'
        ? <button type="button" className="btn btn-primary" onClick={() => { void promptInstall().then((ok) => ok && dismiss()) }}>Install</button>
        : <Link className="btn btn-secondary" to="/get-app" onClick={dismiss}>Get it</Link>}
      <button type="button" className="icon-btn" aria-label="Not now" onClick={dismiss}><Icon name="close" /></button>
    </div>
  )
}
