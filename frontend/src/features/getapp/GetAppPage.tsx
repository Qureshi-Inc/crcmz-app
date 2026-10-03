// Get the app: the Android app from the latest GitHub release, the iPhone app through
// TestFlight (an invite email with a code, redeemed in Apple's TestFlight app). The
// phone you're on goes first.
import { useTitle } from '../../app/title'
import { Icon } from '../../components/Icon'

export const ANDROID_URL = 'https://github.com/Qureshi-Inc/crcmz-app/releases/latest'
export const TESTFLIGHT_URL = 'https://apps.apple.com/app/testflight/id899247664'

type Platform = 'android' | 'ios' | 'other'
function platform(): Platform {
  const ua = navigator.userAgent
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  return 'other'
}

function Android({ mine }: { mine: boolean }) {
  return (
    <section className="glass help-card getapp-card" data-mine={mine} aria-labelledby="getapp-android">
      <h2 className="section-h2 help-h" id="getapp-android"><Icon name="download" />Android</h2>
      <ol>
        <li>Download the <b>.apk</b> from the latest release.</li>
        <li>Open it. If asked, let your browser install unknown apps.</li>
        <li>Open CRCMZ, allow notifications and sign in.</li>
      </ol>
      <p className="meta">Huddle and Watch Party rings show up like a phone call.</p>
      <a className="btn btn-primary" href={ANDROID_URL} target="_blank" rel="noreferrer"><Icon name="download" />Download for Android</a>
    </section>
  )
}

function Iphone({ mine }: { mine: boolean }) {
  return (
    <section className="glass help-card getapp-card" data-mine={mine} aria-labelledby="getapp-ios">
      <h2 className="section-h2 help-h" id="getapp-ios"><Icon name="phone" />iPhone</h2>
      <ol>
        <li>Find the TestFlight invite email from Apple ("… has invited you to test CRCMZ").</li>
        <li>Install Apple's <b>TestFlight</b> app.</li>
        <li>Tap <b>View in TestFlight</b> in the email, or open TestFlight, tap <b>Redeem</b> and type the code from the email.</li>
        <li>Install CRCMZ, allow notifications and sign in.</li>
      </ol>
      <p className="meta">No invite email? Ask Moiz to add you.</p>
      <a className="btn btn-primary" href={TESTFLIGHT_URL} target="_blank" rel="noreferrer"><Icon name="download" />Get TestFlight</a>
    </section>
  )
}

export function GetAppPage() {
  useTitle('Get the app')
  const p = platform()
  return (
    <div className="page page-reading help">
      <h1 className="page-h1" tabIndex={-1}>Get the app</h1>
      <p className="help-intro">CRCMZ on your phone: notifications, calls that ring, music that keeps playing with the screen off.</p>
      {p === 'ios' ? <><Iphone mine /><Android mine={false} /></> : <><Android mine={p === 'android'} /><Iphone mine={false} /></>}
    </div>
  )
}
