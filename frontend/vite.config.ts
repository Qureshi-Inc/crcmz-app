import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The backend serves this build under /app, so every emitted asset URL has to be
// /app/assets/... — hence `base`. See _serve_app_asset in server.py for the other
// half: fingerprinted files get immutable caching, index.html never does.
export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    // Named so a stale asset can never be mistaken for a current one, and so the
    // backend can hand out immutable Cache-Control on the whole directory.
    assetsDir: 'assets',
    sourcemap: true,
    // Fail the build rather than silently shipping a bundle nobody budgeted for.
    chunkSizeWarningLimit: 600,
  },
  server: {
    // `npm run dev` is for working on components in isolation. Anything the app
    // actually fetches is proxied to the real backend so the dev server never needs
    // its own copy of the API contract.
    proxy: Object.fromEntries(
      ['/api', '/v2', '/auth', '/oauth', '/clips', '/send', '/messages', '/status',
        '/health', '/portal', '/roast', '/mcp', '/watch', '/favicon.png',
        '/crcmz-logo.png', '/footer-avatar.png']
        .map(p => [p, { target: process.env.CRCMZ_BACKEND || 'http://127.0.0.1:3000', changeOrigin: false }]),
    ),
  },
})
