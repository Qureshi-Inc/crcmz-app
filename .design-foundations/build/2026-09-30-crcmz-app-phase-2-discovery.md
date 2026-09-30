# Discovery + Design: Phase 2 - Flows + page specs

## Artifacts Found / Current State
- `JOURNEY.md` (root): §Inventory (185 rows), §Job, §Journey and §IA from Phase 1 (commit 3c0be2a). There is no §Flows and no §Page specs yet.
- The wireframe mock of Squad (`.design-foundations/build/squad.html`) is approved. Its review carries one Major and six Minor items into this phase.
- `server.py` has 136 `@app.` decorators, including 133 HTTP routes. `reels.py` mounts 13 `/api/reels*` routes via `include_router`, so a checker has to read both files.
- Slap was probed live on 2026-09-30. All 19 endpoints return 200. The shapes below were recorded from live responses. `/hot` returns `{tracks:[], period_hours}` and is currently **empty**. `/recent` returns `{items}`. `/ai/recommendations/{u}` returns `recommendations` as strings.

## Contract facts verified in code (these drive the state matrices)
| Fact | Where | Design consequence |
|---|---|---|
| The `_auth_gate` middleware sends an HTML GET without a session to a 302 `/auth/login?next=`. Every other request without a session gets 401 JSON | server.py 874–925 | Signed-out means a server redirect at document load. In the middle of a session it becomes a 401 on an API call, and the user re-authenticates in place with the draft kept |
| `_rate_limit` is the only source of 429, and it always sets `Retry-After` | server.py 78–100 | 429 is only possible on the routes that call `_rate_limit` (psn_send, custom_add, assistant, facts_add, watch_*). Every other page marks 429 as N/A with that reason |
| `psn_send` (8/60 s) is keyed on `request.client.host`, and uvicorn runs without `--forwarded-allow-ips` | server.py 245, 302; Dockerfile | Behind the tunnel the whole squad probably shares one bucket, so 429 copy must not blame the user. **Flag for the code plan** |
| `/v2/send` falls back to crcmz-mod when the user token fails and does not say which identity sent the message | server.py 222–240 | The composer cannot promise "sent as you". **Flag: return `as`** |
| `/api/hype` returns a fake `cold/0` on error. Scale: `_HYPE_MAX = 150` = 100 %. Thresholds are 0/15/40/80/120 | server.py 7163–7217 | The meter shows its scale with ticks. A hype error cannot be detected. **Flag: add an `error` field** |
| `/api/squad` returns 200 with `{squad:[], error:"auth unavailable"}` when PSN auth is down, and 500 on exceptions. The cache TTL is 55 s | server.py 7220; psn_data.py | A distinct "PSN unavailable" error. The same data can come back twice, so stale is judged by fetch success |
| During `drawn`, `/api/giveaway` removes `active_draw` for members but **still returns `draws[]` with `winner_name`** | server.py 4327; giveaway.py 308 | A spoiler leak. The spec forbids rendering `draws` for members. **Flag: strip server-side** |
| `/api/clips/{uid}/resend` has no session or admin check and posts a new idempotency key every time | server.py 7130 | Admin-only behind a confirm that names the clip (owner decision). A server gate is an assumed change |
| `/api/clips/media` accepts bearer tokens only. Errors: 404, 410 purged, 409, 503 | server.py 3427+ | CL-31 is designed against the assumed session-cookie access |
| `/api/video-jobs`, `/status` and `/api/pipeline-status` have no role check | server.py 6849, 7072 | Admin UI is gated client-side by `/api/admin/check`. **Recommend a server gate** (not one of the three assumed changes) |
| `message_uid` contains `#` | server.py 3434 docstring | The SPA must URL-encode it (`%23`) in the `/clips/{uid}` and `/api/clips/{uid}/resend` paths |
| `/clips` returns a 302 redirect when `Accept` is `text/html` | server.py 7108 | The SPA must send `Accept: application/json` |
| The rally bridge returns 502 on any bridge failure, including a timeout | server.py 5508 | WhatsApp rally is also treated as a send whose outcome is unknown after a failure |

## Gaps
1. **The Phase 1 inventory disagrees with an owner decision.** AD-07 (roast) is marked MOVE → Admin pending O-1, but the owner excluded roast from `/app`. Fix: change AD-07 to EXCLUDE and note the fix. The counts become 163 KEEP / 12 MOVE / 10 EXCLUDE. CB-02 path tiles stay, but any `/roast/*` path tile is not rendered.
2. There is no app-shell spec yet. The mini-bar, nav, account menu and live region are shared, so they go into a "PS-0 App shell" entry. The 12 destination specs reference it instead of repeating it.
3. Call persistence is an architecture constraint for the code plan: the Watch socket and the LiveKit room must be owned by the shell, not by the page.

## Gate Status
- DESIGN.md: absent. Expected, because it is locked in Phase 3. This phase describes structure and hierarchy only, with no colours or fonts.
- JOURNEY.md: present, with Phase 1 sections done.
- Prerequisites met: yes (the Phase 1 commit plus the approved mock).

## DW Verification
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-2.1 | §Page specs has a complete entry for each of the 12 destinations | COVERED | The checker script `.design-foundations/build/phase2-check.py` finds all 12 `### PS-n` headings. Each carries purpose, entry, rows, endpoint contract, mobile layout, desktop layout and state matrix |
| DW-2.2 | Every page spec carries the full state matrix and its endpoint contract | COVERED | The same checker confirms 9/9 state rows per spec and that every method+path cited resolves to a route in `server.py` or `reels.py` (Slap is checked against the live-probed list). It also confirms every KEEP/MOVE inventory ID is cited in §Page specs |
**All items COVERED:** YES (2/2)

## Design Decisions
- **One send-outcome model for every non-idempotent send** (PSN fire/quick/Squad Up, WA rally, clip re-send, soundboard add+send). The outcomes are Sent / Not sent (4xx or 429: the server refused) / **Unknown** (network failure, timeout, 500/502). It never auto-retries, and "Send again" is an explicit, labeled user action. Sources: Nielsen #1 and #9 (1994); interaction doctrine: high-risk actions lock the button and confirm.
- **A shared state vocabulary is defined once and each page states its specifics.** This avoids nine vague copies and still gives each page a concrete trigger/behavior row (journey: states per page spec).
- **Stale = the last good data kept plus an "Updated Ns ago" marker** when a poll fails or no success lands within 2× the cadence. Showing old data is better than wiping it (Nielsen #1). Polls pause when the document is hidden.
- **Mobile Squad chrome budget ≤ 96 px (12 % of 800):** a 56 px tab bar plus a 40 px handle row that holds the Chat trigger and, during a call, the call chip. The composer shows only when the sheet is open. Hype and stats go into one 64 px compact strip (mock-review Major). Source: Nielsen #8; Fitts (1954) for thumb-zone controls.
- **The hype meter shows its scale:** ticks at 15/40/80/120 of 150, and the count reads "N of 150". This carries over the data-integrity note to Phase 6.
- **Ask AI goal contract (ai-native, principle-derived, no settled canon):** a read-only statement, tools-used disclosure, an honest pending state, and a clear exit to deterministic surfaces. Chips are fixed controls; a button beats a sentence for a known action (ai-native E.3, citing usability).
- **Giveaway:** rendering never mutates. The countdown hitting zero only re-fetches. The reveal comes from the backend job or an explicit admin action behind a confirm.
- **Portal is the only link wizard.** Settings → PSN hands off to it.

## Recommendation
BUILD

## Appendix: Production validation (post-write)
- `python3 .design-foundations/build/phase2-check.py` → **PASS, exit 0**. Results:
  - 146 routes parsed (server.py + reels.py).
  - 12/12 destination specs, each with 9/9 state rows and 5/5 required parts (Purpose, Rows, Endpoint contract, Mobile 375, Desktop 1280).
  - Every cited `METHOD /path` resolves to a real route. Slap paths resolve to the list probed live.
  - 175/175 KEEP/MOVE inventory rows are cited, all of them on a `**Rows:**` line.
  - Flows F-0 to F-8 are present.
- Negative test on a mutated copy (a bogus endpoint, a renamed state row, SQ-05 dropped) → FAIL, with all three defects reported. The checker is not vacuous.
- Markdown table column integrity across JOURNEY.md: 0 mismatches.
- Phase 1 fixes, noted in JOURNEY.md:
  - AD-07 changed to EXCLUDE (owner decision O-1).
  - O-2 note added to CL-30.
  - Roast removed from the §IA Admin source column.
  - Status header counts are now 163 / 12 / 10.

---

# Revision 1: mobile first (brief amendment, 2026-09-30)

## Why
The owner amended the brief (§Device priority) and the plan's decision log: **mobile first, desktop barely used.** Desktop is the sidebar plus a reflow of the mobile layout. Bespoke desktop layouts are allowed only for three jobs: reel review/editor (PS-2 Studio), Giveaway admin (PS-5) and WhatsApp stats/import (PS-4). Hotkeys for soundboard tiles, multi-pane "second screen" dashboards and hover-dependent interactions are out. When mobile and desktop conflict, mobile wins.

## Scope
- In: the Mobile and Desktop sections of PS-0 to PS-12. Hover, mouse-only and keyboard-only paths in §Flows and §Page specs. The checker.
- Out: §Inventory, §Job, §Journey and §IA. The IA's nav model (tab bar + More below 1024, sidebar at 1024 and above) already matches "sidebar + reflow", so nothing in it contradicts mobile-first and it stays as is. No colours or fonts are added.

## Audit of the current Desktop sections
| PS | Current desktop spec | Verdict | Revision |
|---|---|---|---|
| PS-0 Shell | 240 px sidebar, fluid content, reading cap 760 | The default treatment | Mark as reflow. No change to content |
| PS-1 Squad | Right panel 360 → rail 56 / expand 480; hype + 3 tiles row; a 1440-only table split; Enter/Shift+Enter note | The right panel is locked in the brief. The 1440 table split and three panel widths are extra design | Reflow: the right panel (collapsible to a rail, CB-08/09) plus the mobile blocks in two columns when there is room. The Enter note moves to the mobile composer (it is a11y, not desktop) |
| PS-2 Clips | Overview in 3 columns; catalogue as table + right detail panel; Studio overlay | The catalogue's second pane is bespoke and not an allowed job. The Studio is allowed | Overview and catalogue reflow, and detail uses the same sheet as mobile (a centred dialog). **Studio: bespoke, re-specified from the shipped `_DASHBOARD_TMPL` editor** |
| PS-3 Slap | An 8-row, 12-column grid table | Bespoke | Reflow: an auto-fill card grid in the mobile group order |
| PS-4 WhatsApp | Sticky range + export, 6-up stats, awards 5×2, charts 2-col, member table | Allowed job, but thinly specified | **Bespoke, fully specified:** a sortable member table, chart grid, export and an import panel. Mobile fallback stated |
| PS-5 Giveaway | Two columns + admin panel in three sub-columns | Allowed for admin only | The member view reflows. **Admin tools are bespoke:** a lifecycle strip, an entries table and an edit form. Mobile fallback stated |
| PS-6 Watch | Stage 70 % + right column; history 3/4 cols; **mouse click plays, double-click fullscreen**; **everyone's-mic volume desktop-only** | The mouse accelerators and the desktop-only capability break the rules | Reflow: stage and controls, with a side column. Double-click is removed. The mic volume slider is gated on **feature detection** (whether media `volume` can be set), not on the device class. The legacy `(hover:none)` proxy hid it on Android as well as iOS |
| PS-7 Huddle | Filmstrip right; AI 360 px pushing column; centred controls | A reflow in substance, but over-specified | Reflow in two lines: the filmstrip moves beside the stage and the AI sheet becomes a side sheet |
| PS-8 Coach | 4/8 column split | Reflow, but too detailed | Reflow in two lines |
| PS-9 Ask AI | Reading width + an always-visible 320 px facts column | A second pane beyond the reading-width exception | Reflow: reading width ~760. Facts open as a side sheet (the same content as the mobile sheet) |
| PS-10 Settings | Vertical 200 px tab list + panel | A different nav component on desktop (bespoke) | Reflow: the same tab strip at reading width. [Copy] on the MCP block moves to the mobile spec (it was desktop-only) |
| PS-11 Admin | 4-card health row, two tables with an inline Reset, shortcuts top right | Bespoke (and reorders the content) | Reflow: the cards auto-fill, the lists sit side by side, and the order and the Reset dialog are the same as on mobile |
| PS-12 Portal | A 2-column stepper at reading width | Bespoke | Reflow: the same vertical stepper at reading width |

Hover, mouse and key findings:
- PS-6: "mouse click plays; double-click goes fullscreen" is removed. The seek-bar tooltip (WP-07) becomes a time readout while dragging or focused, not a hover tooltip.
- PS-2 Studio keys (Space, ←/→, Shift, I/O/A, Esc) are shipped accelerators, and all but one have a button. Shift+←/→ (1 s) had no button; the spec adds −1 s / +1 s buttons to the transport. The key legend is not a desktop-only instruction; it is available on both layouts behind a "Keys" disclosure.
- PS-6 Watch keys (WP-08) are kept as accelerators only, **scoped to the Watch page and ignored while typing**. Every one has a button already. The legacy "m (global)" key is not global in `/app`.
- No soundboard tile has a key binding (explicitly out). Enter-to-send and Esc-to-close stay as a11y.

## Shipped desktop editor, inventoried from `_DASHBOARD_TMPL` (server.py main, commit 2c7c2a6)
- A full-viewport fixed overlay (`.rrs`, `z-index:9999`, `100dvh`) on both layouts.
- Breakpoint **960 px** (`isDesk()`, `@media (min-width:960px)`). Below it, a single column. Above it, `.rrs-body` becomes a row.
- **Desktop (≥ 960):**
  - left: the main column, with stage, transport and timeline
  - right: the side panel `.rrs-side`, a 400 px glass card inset 12 px. It holds pill tool tabs at the top, a panel title, the tool panel filling the height, the **key legend** (`.rrs-keys`, desktop only) and an action row: ⚙ Render · ✅ Save & approve · 🚀 Force post
  - Trim opens by default (`tool: isDesk() ? 'trim' : null`), and tapping the active tab does not close the panel
  - The top bar's Render and Save buttons (`.rrs-mob`) are hidden
- **Mobile (< 960):**
  - The top bar holds ✕, the title (sender · duration / age · game · message), 🛑 Veto, ⚙ Render, 🚀 and ✅ Save.
  - The stage has the view buttons ✨ Live / 🎬 Render / 🖼 Frame stacked on its left, with 🔊 mute and ⬇ download on its right. Below it are the transport and the timeline.
  - The tool tabs are a bottom strip (`order:4`). The tool panel opens above it at max 31 dvh and closes when the active tab is tapped again. No tool is open at first, so the stage is as large as possible.
- **Both layouts:**
  - The pipeline strip (`.rrs-pipe`) runs under the top bar.
  - The transport is −0.1 · ▶ · +0.1 · time.
  - The timeline has four lanes: the trim window over a filmstrip with cyan handles, the 🔍 zoom lane, the 💬 subs lane and a seconds ruler, with the playhead.
  - The keys are Space, ←/→ 0.1 s (Shift 1 s), I start, O end, A whole clip and Esc close. They are ignored while an input has focus.
  - Crop aiming: in Frame view, drag the box (manual mode). In Zoom, tap the preview to aim.
  - Veto sits in the top bar.
- Design consequence: the Studio spec keeps this structure. The breakpoint is aligned to the shell's 1024 (Phase 3 owns final values; the shipped 960 is noted). The spec adds a −1 s / +1 s button pair and the crop X-slider + nudge from CL-17.

## Marker convention (checked)
- `**Mobile 375 (primary):**` leads the layout of every PS-0 to PS-12 and appears before any desktop marker.
- `**Desktop 1280 (reflow):**` is the sidebar + reflow treatment. Its block (the marker line up to the next blank line) is at most 3 lines.
- `**Desktop 1280 (bespoke):**` is allowed only in PS-4 and PS-5, and in PS-2 only as `**Desktop 1280 (bespoke) · Studio editor:**`. Each bespoke spec also carries `**Mobile fallback:**`, which says how the phone still does the job.
- In §Flows and §Page specs, any line that mentions hover, mouse, double-click, right-click or hotkey must be a negation (no / never / not / without). Otherwise the check fails.

## Gaps
- None blocking. The shipped editor lacked a button for the 1 s step. The spec adds one; the code plan implements it.
- The Watch mic-volume capability rule (feature detection) is a small behaviour change from legacy. It goes to the code plan.

## DW Verification (Revision 1)
| DW-ID | Done-When Item | Status | Evidence |
|-------|---------------|--------|----------|
| DW-2.1 | §Page specs has a complete entry for each of the 12 destinations | COVERED | `phase2-check.py` exit 0: 12/12 specs, with parts including `**Mobile 375 (primary):**` and a desktop marker. The new check `desktop markers` passes, and a mutated copy (PS-3 marked bespoke, a 5-line reflow block, a hover line, the desktop marker placed before mobile) fails with each defect named |
| DW-2.2 | Every page spec carries the full state matrix and its endpoint contract | COVERED | The same run shows 9/9 state rows and verified endpoints per spec (unchanged by this revision; anchored evidence must not regress) |
**All items COVERED:** YES (2/2)

## Design Decisions (Revision 1)
- **Mobile wins** (owner). Each reflow rule reuses the mobile component and order, so there is one design to build and test. This follows Jakob's law across devices and keeps the component count down (Hick–Hyman applies to the builder as well as the user).
- **Bespoke only where a phone is painful.** The Studio's timeline precision (Fitts 1954: small, precise targets need a large pointer surface), the WhatsApp tables (comparison across many columns: data-table pattern, usability ui-patterns) and Giveaway admin (multi-step state + list editing). Each has a stated mobile fallback, so the job is never desktop-only (WCAG 2.1 reflow 1.4.10, in spirit).
- **Capability, not device class.** Anything that differs by device is gated on feature detection (`getDisplayMedia`, settable `volume`), never on hover or width. This follows interaction doctrine: hover is pointer-only and cannot carry meaning.
- **Keys are accelerators, never the only path.** Studio and Watch keys keep a visible button for each. There are no soundboard hotkeys (owner).

## Recommendation
BUILD

## Revision 1: Production validation (post-write)
- `python3 .design-foundations/build/phase2-check.py` → **PASS, exit 0**.
  - Everything anchored from the first build still holds: 146 routes, 12/12 specs, 9/9 state rows each, endpoints verified, 175/175 KEEP/MOVE rows on a `**Rows:**` line, and F-0 to F-8.
  - The new device checks cover 13/13 specs, including PS-0. Every spec leads with `**Mobile 375 (primary):**`.
  - The bespoke specs are PS-2 (Studio only), PS-4 and PS-5, each with `**Mobile fallback:**`. Every other spec is reflow, in blocks of 3 lines or fewer.
  - There are 7 hover/mouse/hotkey mentions in §Flows and §Page specs, all of them negations (0 dependencies).
- Negative test on `/tmp/JOURNEY.mutated.md` (6 injected defects) → **FAIL, exit 1**, with all 6 named:
  1. PS-3 marked bespoke
  2. PS-2 bespoke without the Studio label
  3. PS-4 fallback removed
  4. PS-8 reflow block at 5 lines
  5. PS-12 desktop before mobile
  6. a "Hover a tile" line

  PS-3 also fails the missing-fallback rule.
- Markdown table column integrity across JOURNEY.md: 0 mismatches.
- §Inventory, §Job, §Journey and §IA are untouched. §Flows changed only in F-1's panel wording (mobile listed first; the desktop panel is collapsible, not "always-open").
