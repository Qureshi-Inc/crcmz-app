# What was actually checked

Every command and number here was run. Where something was **not** checked, it says so
rather than being left out.

Tested commit: `ed7d709` on `feat/ui-ux-migration`. Baseline: `d2804ef`, which is also the
image running in production (`joyhn9ndmj137fd3ff7v30bx:d2804eff…`), so "baseline" and
"what users have now" are the same code.

## How to run any of it

```bash
tests/run-all.sh                          # Python suites, in the app image
tests/run-all.sh test_auth_gate           # one suite
tests/browser/run.sh dashboard.spec.mjs   # legacy dashboard, real browser
tests/browser/run.sh app.spec.mjs         # the React interface
tests/browser/run.sh a11y.spec.mjs        # axe-core, every screen
node tests/browser/contrast.mjs           # colour contrast, computed from tokens.css
```

`tests/run-all.sh` runs inside the app image with a tmpfs at `/data`. That is not
convenience: every module hardcodes its store under `/data`, `/data` on this host is
root-owned Coolify state, and nine suites die at boot with `unable to open database file`
when run directly. A host run is not a valid result.

`tests/browser/run.sh` boots a throwaway container on a kernel-assigned port with a tmpfs
`/data`, so no real squad data, private chat contents or tokens are involved, and every
API call in the specs is intercepted. **No test in this repository sends a message to a
real PSN or WhatsApp group, or mutates a real giveaway.**

## Baseline, before any of this work

| Suite | Result |
|---|---|
| test_assistant | 46 passed, 2 failed |
| test_chat_history | 17 passed |
| test_clawbot_target | 24 passed |
| test_facts | 23 passed |
| test_flavor_ai | 10 passed |
| test_game_history | 27 passed |
| test_identity | 29 passed |
| test_mcp_coverage | 5 passed, 1 failed |
| test_mcp_oauth | 29 passed, 1 failed |
| test_mcp | 21 passed, 2 failed |
| test_personal_board | 13 passed |
| test_psn_ai | 17 passed |
| test_read_only | 7 passed |
| test_soundboard | 12 passed |
| test_summary_attribution | 8 passed |
| test_wa_ai | 20 passed, 4 failed |
| test_watch | 27 passed |
| test_whatsapp | 18 passed |

### Pre-existing failures — not caused by this branch, and not "fixed" by editing a test

| Suite | Failure | Why |
|---|---|---|
| `test_mcp` | `assert mcp.configured() is False` with no `MCP_TOKEN`; and "disabled MCP answers 503" | `configured()` was changed to `return True` when per-user OAuth landed — the endpoint is always active now. The test still expects the old shared-token-only behaviour. Stale test, intentional behaviour change. |
| `test_mcp_coverage` | `/data/mm_tokens.db` has no entry in `STORES` | `mm_tokens.py` added a store without the `@tool()` + coverage entry the project rule requires. A real gap, from the Mattermost work, unrelated to the UI. |
| `test_mcp_oauth` | `clawbot_build has no 'message' param` | From the clawbot changes around `f0d2ed0`/`479ffa8`. |
| `test_assistant` | `persona_is_vulgar_by_default`, `a_data_question_without_a_tool_is_refused` | Assert on prompt wording and on model behaviour that has since changed. |
| `test_wa_ai` | 4 failures around mention triggering, bridge payload shape, reply trimming | Assert on payloads that have since changed shape. |

Left alone on purpose. Regenerating an assertion to make a suite green would destroy the
information that the behaviour changed.

## After this branch

Identical: the same five suites fail with the same assertions, and everything else passes.
`test_auth_gate` is new (16 passed). `test_personal_board` needed one change — it drove the
LAN bypass through a `TestClient` whose peer is the literal string `"testclient"`, and the
bypass now requires a real private address, so the test supplies `10.0.0.7`. That makes the
test model the scenario its own comment describes.

| Suite | Result |
|---|---|
| test_auth_gate | **16 passed** (new) |
| test_personal_board | 13 passed |
| everything else | unchanged from baseline, including the five known failures |

## Phase 1 — the legacy defects

The proof is a before/after of the same spec against the same fixtures.

```
tests/browser/dashboard.spec.mjs  against d2804ef  →   4 passed, 14 failed
tests/browser/dashboard.spec.mjs  against ed7d709  →  18 passed,  0 failed
```

What the baseline reported, verbatim:

| Check | Baseline failure |
|---|---|
| `?p=slap` opens that panel | `page threw: Cannot access '_slapLoaded' before initialization` |
| `?p=wa` opens that panel | `page threw: Cannot access '_waLoaded' before initialization` |
| `?p=giveaway` opens that panel | `page threw: Cannot access '_gwLoaded' before initialization` |
| unknown `?p=` normalises the URL | `URL was not normalised: …/?p=not-a-real-tab` |
| a legacy `#hash` link resolves | `hash was not translated into ?p=` |
| Back/Forward move between tabs | timeout — no popstate handling |
| repeat clicks do not stack history | timeout |
| the composer disables its own button | timeout — `#quickSend` did not exist; `.qsend` matched Ask AI's button |
| hammering the button sends one message | `expected 1 request, got 0` |
| **hammering Enter sends one message** | **`expected 1 request, got 5`** |
| a failed send keeps the draft | timeout |
| failed Music load offers Retry | `no Retry button in the failed Music panel` |
| failed WhatsApp load offers Retry | `no Retry button in the failed WhatsApp panel` |
| a stale range cannot overwrite a newer one | `the superseded all_time response overwrote the current range: 100.0k 💬 MESSAGES …` |

The Enter result is the one worth reading twice: holding Enter in the quick-send box posted
**five** messages to the squad's real PSN group.

Two things went wrong in writing these and are worth recording, because both produced a
*passing* test that proved nothing:

1. The stale-range check sampled the DOM once after a fixed 3s delay and landed in the gap
   before the superseded response wrote. It now polls for the stale value and asserts it
   never appears, and refuses to pass if the slow response was never delivered at all.
2. The harness leaked browser contexts from failing tests. Their polling timers shifted the
   timing of later tests enough to turn a real failure into a pass. `check()` now closes
   every context in a `finally`.

## Phase 1 — auth and config

`tests/test_auth_gate.py`, 16 checks, all passing:

* a real tailnet peer (`100.123.228.75`), LAN peer (`192.168.5.54`) and loopback still skip
  the gate — the Stream Deck plugin and the container healthcheck keep working
* a public-internet peer sending any `Host` it likes is refused
* a request carrying `X-Forwarded-For` does not inherit the proxy's private address
* an unidentifiable peer (a hostname, or no peer at all) is refused
* the public host always demands a session regardless of peer
* `CRCMZ_MACHINE_TOKEN` authenticates over the public host, by `Authorization: Bearer` or
  `X-CRCMZ-Machine-Token`
* a wrong, empty or truncated machine token is refused; an unset one authorises nobody
* a missing `SESSION_SECRET` answers **503** on the public host and `/health` still answers
* a cookie signed with the old published `dev-insecure` fallback is **not** a session
* the public path allowlist is unchanged
* the account display name is escaped, and a board label containing `</script>` cannot
  close the script block — while still parsing back to the same value

Two findings came out of writing those tests, not out of reading the code:

* `ipaddress.is_private` is **False** for `100.64.0.0/10`. Using it would have locked the
  Stream Deck plugin out of the app.
* `ipaddress.is_private` is **True** for `203.0.113.0/24` and the other documentation
  ranges — it means "not globally routable", not "on my LAN". Hence an explicit network
  list.

## Phase 2/3 — the React interface

`tests/browser/app.spec.mjs`, **43 checks, all passing.**

| Area | Checks |
|---|---|
| Direct entry | all 9 screens render their own `h1` with no page error |
| Refresh | lands on the same screen |
| Not found | a useful view with real destinations, not a blank page |
| Document title | follows the route |
| Back / Forward | move between screens in both directions |
| Legacy links | `?p=slap` → `/app/music`; `#giveaway` → `/app/community/giveaways`; `?p=../../evil` is ignored and stays on Home; the redirect `replace`s so Back is not trapped |
| Filters | a clip filter reaches the server, is in the URL, survives refresh |
| WhatsApp range | reaches every endpoint; a half-filled or backwards custom range is never requested and says why |
| Slow response | a skeleton placeholder, which disappears when data lands |
| Failed response | Retry issues a real new request |
| 403 | explains it is the account, offers no Retry |
| 429 | surfaces `Retry-After: 42` as "try again in 42s" |
| Malformed response | no page error, degrades to an empty state |
| Empty result | explains itself, offers a next action |
| Partial failure | a dead hype widget leaves presence on screen |
| Signed out | a sign-in prompt, not an error, and no false "session expired" |
| Login return | `next=/app/ai` — it comes back to where you were |
| Drawer | opens from the keyboard, traps focus, Escape closes, focus returns to the trigger |
| Both boards | reachable as tabs, no swipe required |
| Duplicate submit | 4 forced clicks → 1 request; 5 Enters → 1 request |
| Failed write | draft kept, and reported as "might have sent" rather than a plain failure |
| **Giveaway safety** | loading the screen with an overdue reveal, then navigating away and back, produces **zero** writes |
| Destructive confirm | the draw does not fire before the dialog is answered, the button says "Draw the winner", and cancelling does not draw |
| Responsive | no horizontal overflow at 360, 390, 768, 1024, 1440 |
| Mobile nav | exactly one main nav visible at 390px; Home/Watch/Clips/More all reachable as labelled controls |
| Reflow | no sideways scroll at a 720px-equivalent 200% zoom, and the Chat Board control is still reachable and ≥40px tall |

### Route and API compatibility

Checked against the built image:

```
/                        200  text/html          (legacy dashboard, unchanged)
/app                     200  text/html
/app/clips               200  text/html
/app/community/whatsapp  200  text/html
/app/nonsense            200  text/html          (client router owns it)
/clips                   200  application/json   ← still the API, not shadowed
/status                  200  application/json
/health                  200  application/json
/api/squad               200  application/json

/app/assets/does-not-exist.js   404   ← not index.html with a 200
/app/some.js (Accept: */*)      404

/app/assets/index-<hash>.js  →  cache-control: public, max-age=31536000, immutable
/app                         →  cache-control: no-store, must-revalidate
                                vary: Cookie
```

## Accessibility

`tests/browser/a11y.spec.mjs` — axe-core 4.13, `wcag2a wcag2aa wcag21a wcag21aa wcag22aa`,
across 10 screens × 2 viewports plus the Chat Board drawer, the More sheet and a
confirmation dialog.

**24 views scanned, 0 violations.**

Two real defects were found and fixed by this scan, neither visible by reading the code:

1. **Contrast on every primary button.** axe reported `#f4f1fb on #cf2aa8, 4.13:1`. Two
   separate bugs behind one symptom:
   * `text-[var(--text-sm)]` compiles to `color: var(--text-sm)`, not a font-size —
     Tailwind cannot distinguish a length from a colour inside `var()`. The value is
     invalid at computed-value time, so `color` fell back to `inherit` and silently
     overrode the intended white. **Every font size in the app was also missing.** Fixed by
     using the named utilities Tailwind generates from the `@theme` tokens.
   * The accent itself measured **3.66:1** against white, not the 4.6:1 a hand-written
     comment claimed. Darkened until it passes.
2. **`scrollable-region-focusable`** on the member table at 390px — the horizontally
   scrolling container was not keyboard-reachable, so a keyboard user could not see the
   right-hand columns. Fixed with `tabIndex={0}` and a label.

`node tests/browser/contrast.mjs` computes all 26 pairs from `tokens.css` and fails if any
is short. Current result: all pass, lowest ratio with a requirement 3.59:1 (the accent bar
against a raised surface, which needs 3:1 as a non-text indicator). Text pairs range from
5.00:1 to 18.04:1.

### Checked by hand, in addition

* Tab order through Home, the sidebar, the drawer and the dialogs follows reading order.
* Focus is visible on every interactive element — one outline rule, keyboard only.
* Focus moves to `#app-main` on navigation and the landmark is labelled with the screen
  name, so a screen-reader user is told the page changed. Without this, client routing is
  silent.
* Colour is never the only signal: the presence dot is always beside "Online" or a
  last-seen time, and statuses are words.
* Live regions are `polite`, never `assertive` — a background refresh must not interrupt.
* `prefers-reduced-motion` is honoured globally.

### Not established

* **axe does not prove conformance.** It cannot judge whether a label is *correct*, whether
  focus order is sensible, or whether an announcement is useful.
* **No screen-reader testing.** No VoiceOver, NVDA or TalkBack run happened. The ARIA is
  built on Radix primitives and reviewed by hand, which is not the same as hearing it.
* **No real-device testing.** No iOS or Android hardware. Everything below is
  Chromium-at-a-viewport, not a phone.

## Performance

Median of 5 cold loads each, same machine, loopback, identical canned API responses,
fresh browser context per run (so nothing is served from a warm cache).

| | legacy `/?p=squad` | new `/app` |
|---|---|---|
| FCP | 192 ms | **100 ms** |
| LCP (loopback) | 192 ms | **128 ms** |
| DOMContentLoaded | 70 ms | **48 ms** |
| CLS | **0.0000** | 0.0012 |
| Long tasks | 0 | 0 |
| Requests | 7 | 8 |
| Document | 281.9 KB | 0.6 KB |
| Scripts | 0 KB | 384.4 KB |
| Styles | 0 KB | 33.0 KB |
| Images | 375.9 KB | 209.0 KB |
| **Total (uncompressed)** | **658.9 KB** | **628.3 KB** |

The main bundle is 384 KB uncompressed, **122 KB gzipped**. Each feature screen is a
separate chunk of 2–14 KB, so Home does not pay for the WhatsApp analytics code. Source
maps are emitted but excluded from these numbers — no browser fetches them unless devtools
is open.

CLS was **0.1183** when first measured, above the 0.1 threshold. Attributing the shift to
specific elements found two causes: the page subtitle was rendered conditionally, so it
appeared when data landed and pushed every section below it down 22px; and the skeleton
rows were 68px against a real row of ~72px, with the wrong row count. Reserving the
subtitle line and matching the placeholder to the real geometry brought it to 0.0012.

### Not established

* **These are not Core Web Vitals.** They are lab numbers over loopback on one machine.
  Field LCP depends on the network and the device; **INP cannot be measured without real
  people interacting** and no value for it is claimed. Nothing here says anything about a
  75th percentile of actual use.
* No throttled-CPU or slow-network run.
* No measurement against real production data volumes — the WhatsApp aggregates over the
  real ~10k-row database will be slower than these fixtures, which is why those queries
  have a 45 s timeout and `CACHE.analytics` keeps them out of refetch-on-focus.

## Browser coverage

| Engine | Status |
|---|---|
| Chromium 151 | everything above |
| Firefox | **not run** — no Playwright Firefox build on this host |
| WebKit / Safari | **not run** — same |
| iOS Safari, Android Chrome | **not run** — no devices |

So: `dvh`, `env(safe-area-inset-*)`, the bottom-sheet drawer and the software-keyboard
behaviour are written to the spec and reasoned about, but **have not been seen on a phone.**
Do not read the mobile screenshots as evidence of mobile behaviour — they are Chromium at
390×844 with a touch flag, which is not the same thing.

## Visual evidence

`docs/ux/screenshots/before-legacy/` and `docs/ux/screenshots/after-app/`, six screens ×
two viewports each, captured by `tests/browser/shots.mjs` with identical fixtures,
viewports, locale (`en-GB`), timezone (`UTC`) and `prefers-reduced-motion`, and with
animations frozen before the shot. So a difference between a pair is a difference in the
code.

The fixture data is invented squad members. No real private chat contents, PSN IDs or
tokens are in any committed image.

One artefact to know about: emoji render as empty boxes because the host Chromium has no
emoji font installed. It affects both sides equally, so the comparison holds, but the
emoji in the real app do render.

## Deployment

| Check | Result |
|---|---|
| Image builds with the frontend stage | yes — `docker build -t crcmz-app:test .` |
| `tsc` failure fails the image build | yes — the `build` script chains `tsc -b --noEmit` before `vite build` |
| Container starts and reports healthy | yes, `/health` |
| Assets load, document loads, route contract holds | yes, table above |
| Previous image can be restored | yes — `crcmz-app:baseline` was built from `d2804ef` and run repeatedly during this work |

### Not established

* **Not deployed.** Nothing was released. The gates in `RELEASE.md` §Before you ship have
  not all been met, and no observation window has run.
* Zitadel login was not exercised end to end. The auth *return path* is verified
  (`next=/app/ai`), and `/auth/login` is untouched, but no real OIDC round trip happened —
  the test instances run with no `ZITADEL_CLIENT_ID` and reach the app over the LAN bypass.
* Passkey sign-in was not exercised.
* The Mattermost OAuth round trip was not exercised.
* Cloudflare and Traefik behaviour in front of `/app/assets/*` was not observed. The
  headers are correct at the origin; whether the edge honours them is unverified.
