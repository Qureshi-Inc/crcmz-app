# CRCMZ UI/UX migration — status

Read this first. It is the resume point.

**Branch:** `feat/ui-ux-migration` · **Head:** `ed7d709` · **Baseline:** `d2804ef`

`d2804ef` is also the image tag running in production
(`joyhn9ndmj137fd3ff7v30bx:d2804eff…`), so "baseline" and "what users have now" are the
same code.

| Doc | What is in it |
|---|---|
| `INVENTORY.md` | every capability, its parity status, and what is not built |
| `ROUTES.md` | the full route contract, auth classes, and the machine-access migration |
| `DESIGN.md` | tokens, measured contrast, patterns, and the decisions taken without asking |
| `VALIDATION.md` | what was actually run, with numbers, and what was **not** checked |
| `RELEASE.md` | build, config, deploy, rollback, and the gates |

## Phase board

Updated when a gate is actually met, not when work starts.

| Phase | State | Evidence |
|---|---|---|
| 0 — Baseline | ✅ done | `INVENTORY.md`, `ROUTES.md`, `VALIDATION.md` §Baseline, `tests/run-all.sh` |
| 1 — Correct known defects | ✅ done | `VALIDATION.md` §Phase 1 — 14 of 18 checks fail on `d2804ef`, 18/18 pass now |
| 2 — Foundation | ✅ done | `/app` builds, routes, refreshes; route contract verified; `VALIDATION.md` §Route and API compatibility |
| 3 — Design reference | ✅ done | shell, Home, Chat Board drawer, AI composer, all on real endpoints; `DESIGN.md` |
| 4 — Standard features | 🟡 partial | Clips, Music, WhatsApp, Giveaways, AI, Settings, Admin are integrated. Gaps listed per feature in `INVENTORY.md`. Nothing retired. |
| 5 — Media (Watch, Huddle) | ⛔ blocked | see blocker 1 |
| 6 — Quality and packaging | 🟡 partial | a11y ✅ 0 violations, contrast ✅, responsive ✅, perf measured ✅, image builds ✅, rollback exercised ✅. Missing: real devices, screen reader, Firefox/WebKit. |
| 7 — Controlled rollout | ⛔ not started | nothing deployed; `/app` is opt-in by construction |
| 8 — Retirement | ⛔ not started | gated on 5 and 7 |

## Where things stand

The legacy dashboard at `/` is the default and is unchanged apart from the Phase 1 defect
fixes. The React interface is additive, at `/app`, and reachable only by going there.
Nothing has been retired and no existing route changed behaviour.

Shipping this branch gives users the Phase 1 fixes and the security changes without moving
anyone's interface. That is a separate, later decision — `RELEASE.md` §Switching the
default.

## Next action

Pick up Phase 5, or close out the Phase 4 gaps.

**Phase 5 is the one that matters** — it is the only thing genuinely blocking a default
switch, and it needs hardware this session did not have. Start by reading
`frontend/src/media/` (empty, deliberately: the session owner belongs above the route
content so a route renders *controls for* a session rather than creating one by appearing)
and §8 of the execution plan.

**Phase 4 gaps, roughly by value:**

1. A clip media endpoint (`GET /api/clips/{uid}/media` → short-lived presigned URL), then
   thumbnails and playback. Currently the new Clips screen cannot do the main thing.
2. Giveaway auto-reveal as an idempotent backend job, with a fake-clock test. Must land
   before the legacy giveaway screen is retired.
3. The ten un-migrated Slapshare panels. Verify each response shape against the live
   service first; do not write a renderer against a guessed shape.
4. Personal-board reordering with Move up / Move down buttons.
5. Image attachment on Ask AI — the API client already supports it, there is no picker.
6. Passkey registration.
7. The four remaining WhatsApp charts.

## Blockers and unresolved risks

1. **Phase 5 needs hardware.** Verifying Watch and Huddle means join/leave/reconnect,
   duplicate capture, device removal, autoplay policy and mobile OS suspension — a camera,
   a microphone, a second participant and a phone. None were available. Shipping that code
   unverified would put the highest-risk part of this migration into production untested,
   so `/app/watch` and `/app/huddle` hand off to the classic interface with an honest
   explanation instead.

2. **Giveaway auto-reveal is gone from the new screen, on purpose.** The legacy loader
   POSTed `draw-and-reveal` from inside its own data fetch when an admin opened the tab
   after the scheduled time. Rendering must not mutate, so that is not reproduced — which
   means **a scheduled reveal now waits for an admin to press Reveal.** Restoring the
   timing needs an idempotent backend job. Detail in `INVENTORY.md`.

3. **Clips are not playable, because no endpoint serves them.** Not a design choice — there
   is no route that returns clip bytes or a thumbnail. The screen says so rather than
   rendering broken players.

4. **The Host-header auth bypass is narrowed, not removed.** The Stream Deck plugin
   authenticates purely by calling a Tailscale IP. `CRCMZ_MACHINE_TOKEN` is the forward
   path, but the plugin needs a rebuild and a re-install on the user's hardware before the
   old branch can go. Caller inventory in `ROUTES.md` §Machine access.

5. **Five Python suites failed before this work started** and still do, with the same
   assertions. Listed with a cause each in `VALIDATION.md` §Pre-existing failures. None are
   caused by this branch and none were "fixed" by editing a test. One of them
   (`test_mcp_coverage`) is a real project-rule violation from the Mattermost work:
   `/data/mm_tokens.db` has no `@tool()`.

6. **No real-device, screen-reader, Firefox or WebKit testing.** axe reports zero
   violations across 24 views and the keyboard paths are checked, but that is Chromium at a
   viewport. `dvh`, safe-area insets, the bottom sheet and software-keyboard behaviour have
   **not been seen on a phone.** Do not read the mobile screenshots as mobile evidence.

7. **Performance numbers are lab numbers.** Loopback, one machine, canned responses. INP
   cannot be measured without real people and no value is claimed for it. Nothing in
   `VALIDATION.md` establishes a field 75th percentile.

8. **`/data` backup coverage is unverified.** No schema change and nothing new is written,
   so the risk is low — but confirm the Coolify volume is backed up before deploying
   anyway.

## Things to know before editing

* **`/data` is not writable on this host.** Run Python tests with `tests/run-all.sh`, which
  runs them in the app image with a tmpfs `/data`. Running them directly gives nine bogus
  failures.
* **Use `text-sm`, never `text-[var(--text-sm)]`.** Tailwind cannot tell a length from a
  colour inside `var()`; the arbitrary form compiles to `color: var(--text-sm)`, which
  removes the font size *and* silently resets the text colour to `inherit`. This was live
  across the whole app until the axe scan caught it.
* **`to()` returns router-relative paths.** `<BrowserRouter basename="/app">` prepends the
  base, so returning `/app/clips` yields `href="/app/app/clips"`. Use `appUrl()` for a full
  URL outside the router.
* **Never call a giveaway mutation from a render or an effect.** `lib/api/giveaway.ts` has
  the whole story at the top.
* **Run `node tests/browser/contrast.mjs` after touching a colour.** It reads `tokens.css`
  and fails. A comment claiming a ratio is not evidence — two of the original ones were
  wrong.
