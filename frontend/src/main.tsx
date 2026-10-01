import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import { App } from './app/App'
import { applyLegacyDeepLink } from './app/nav'
import { startPwa } from './lib/pwa'

// /app?p=<legacy key> → the mapped route, before the router reads the URL (G-03).
applyLegacyDeepLink()

// Installable app: service worker, install prompt, push (lib/pwa.ts).
startPwa()

// Battery: pause the aurora drift while the page is hidden (DESIGN.md §Motion).
const syncHidden = () => document.documentElement.classList.toggle('is-hidden-doc', document.hidden)
document.addEventListener('visibilitychange', syncHidden)
syncHidden()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
