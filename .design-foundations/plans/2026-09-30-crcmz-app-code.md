# CRCMZ App `/app`: code plan

**Date:** 2026-09-30 · **Sources:** `DESIGN.md` (locked), `JOURNEY.md` (IA, F-0…F-8, PS-0…PS-12, §Voice, §Microcopy, §Data specs), the rendered references in `.design-foundations/build/`.

## Rules for every slice

- `/`, `/dashboard`, `/portal`, `/api/*`, `/v2/*`, the Stream Deck routes and `/mcp` keep their contracts. A slice that needs a backend change names it (B-n) and ships it as its own reviewed change, never folded into frontend work.
- `/app` never does less than the classic app. A destination that isn't rebuilt yet renders the "Lives in the classic app for now" handoff with a plain link to the classic URL.
- Mobile first at 375 × 800; desktop is the sidebar plus reflow. Nothing depends on hover or hotkeys.
- Every non-idempotent send uses the F-0 model in `frontend/src/lib/send.ts`: one request, no auto-retry, Sent / Not sent / Slow down / Unknown.
- User and model text is rendered as text, never as HTML.
- Verify each slice with `npm ci && npm run build`, `docker build .` and `frontend/tests/smoke.mjs` against the real backend (reads only; every write is mocked). Save screenshots to `docs/app/slice-N/`.

## Slice 1: shipped

- **Tokens and global styles.** `frontend/src/styles/tokens.css` holds the DESIGN.md blocks verbatim. `global.css` has the aurora (portrait inset, reduced-motion stop, pause while hidden), the scanline grid, glass, the type scale and the components. Fonts load from Google Fonts, as in the mocks.
- **Shell (PS-0).**
  - Mobile: a 72 → 48 px condensing top bar (IntersectionObserver sentinel, no CLS), the Squad · Watch · Clips · More tab bar, and the More sheet (Radix dialog with a scrim, focus trap and swipe-down).
  - Desktop: the 240 px sidebar at ≥ 1024 px.
  - Landmarks: `Tab bar`, `More`, `Primary`, `Sidebar`.
  - Account menu: Settings, Link PSN, Sign out.
  - Session: `/api/admin/check` is the boot probe; a 401 sends the user to `/auth/login?next=<path>`. A later 401 shows the "Sign in to keep up" banner.
  - Legacy `/app?p=` links resolve through an allowlist. Admin appears only for admins and fails closed.
- **Squad (PS-1) at `/app`.**
  - Presence (30 s) with its loading, 10 s slow-load, empty, error and stale states.
  - Hype meter per DS-HY (60 s), with the scale and ticks visible.
  - Stat tiles per DS-ST, the Playing-together card with Rally ▶, a Squad Up CTA, and Ranks.
- **Chat Board.**
  - Mobile: a bottom sheet behind the handle row. Desktop: a 360 px panel that collapses to a 60 px rail.
  - Shared / Mine tabs. Mine without a session shows "Sign in to build it".
  - Tiles have the resting glow; firing adds the fire glow and the scanline sweep.
  - The quick-message composer uses `/v2/send`; tiles, Rally and Squad Up use `/v2/squad`.
  - Add tile: `{text, send}`, where `send:false` never fires; `custom_add` has its own countdown.
  - Edit → remove, with a confirm that names the tile. The request body is `{text: msg}`.
  - Organize with visible Move earlier / Move later. Shared order is saved per device in `cb_order`; Mine is saved with `/api/soundboard/personal/order`.
  - F-0 applies throughout. The `psn_send` countdown is shared by every tile, Rally, Squad Up and Send, and only one PSN send can be in flight per tap burst.
- **Other destinations.** Every other destination has a route and a classic handoff: `/?p=pipeline|slap|wa|giveaway|watch|huddle|coach|ai` and `/portal`. `/app/clips?upload` hands off to `/?p=upload`. Settings and Admin hand off to `/` with the menu path, and Admin shows "Admins only" to everyone else. An unknown path renders a not-found view.
- **Hygiene.** The committed `frontend/node_modules` (playwright-core) and `tsconfig.tsbuildinfo` are untracked and ignored. Slice screenshots are kept out of the Docker context.

**Deferred inside Squad:**
- Drag-to-reorder. The Move buttons are the WCAG 2.5.7 path; drag is only an accelerator.
- The call chip in the handle row and the call mini-bar. There are no calls in `/app` until Watch/Huddle ship.
- The Chat unread badge. No endpoint provides a count.

## Next slices (suggested order)

| # | Slice | Backend dependency | Notes |
|---|---|---|---|
| 2 | **Clips** (PS-2, F-3) | **B-1** session-cookie access to `GET /api/clips/media?uid=`; **B-3** admin gate on clip re-send | Reels, player (410-purged state), upload sheet (`?upload`), montage summary (DS-CL-MO). Studio editor is desktop-bespoke with a mobile fallback. Re-send uses F-0 with a 190 s timeout. |
| 3 | **Ask AI** (PS-9, F-7) | none | Server-stored thread: after a transport failure, re-read `/api/assistant/history` once instead of showing Unknown. Reading width. |
| 4 | **Giveaway** (PS-5, F-6) | **B-2** idempotent auto-reveal job; **B-5** strip `draws[]` for non-admins | Lifecycle strip, countdown, reveal moment (confetti ≤ 1.2 s, off under reduced motion). The admin section is desktop-bespoke. |
| 5 | **WhatsApp** (PS-4) | none | DS-WA-* charts with table alternatives; export/import desktop-bespoke. |
| 6 | **Slap** (PS-3) | none (external, CORS `*`) | DS-SL-* charts; per-user colours are decoration only. |
| 7 | **Settings, Admin, Portal** (PS-10/11/12, F-8) | **B-8** admin gate on `/status`, `/api/video-jobs`; **B-9** passkeys error signal | Settings tabs as routes. Portal link wizard at `/app/portal` replaces the handoff; the legacy `/portal` stays. |
| 8 | **AI Coach** (PS-8) | none | Mine/Squad tabs, notify preferences. |
| 9 | **Watch, Huddle** (PS-6/7, F-4/F-5) | none new | Last, because they need real devices. The shell owns the Watch socket, peers and LiveKit room so a route change never drops a call. Brings the call mini-bar and the handle-row call chip. |

Also recommended, in any slice: **B-4** (key the `psn_send` limiter on the session `sub`, not the tunnel IP), **B-6** (`/v2/send` reports `as: user|server`) and **B-7** (`/api/hype` flags errors instead of returning `cold/0`).

## Known gaps

- `npm run lint` calls `eslint`, but no ESLint config or dependency exists (the script came from the abandoned attempt). TypeScript 7 has no JS API for typescript-eslint yet, so lint stays out until that settles. `tsc` strict mode is the gate.
- On the owner's headless box, emoji in soundboard labels render as boxes because no emoji font is installed. Phones render them normally.
