import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/global.css'

/**
 * StrictMode is on deliberately. It double-invokes effects in development, which is the
 * cheapest way to catch a subscription, timer or socket that is created without being
 * cleaned up — the failure mode that produces duplicate participants and two
 * microphones in a call. Leaving it off to make effects "work" would hide exactly the
 * bug class the media work has to avoid.
 */
const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
