# CRCMZ UI/UX migration — status

**Branch:** `feat/ui-ux-migration` · **Baseline commit:** `d2804ef` (= the image tag
running in production, `joyhn9ndmj137fd3ff7v30bx:d2804eff…`, so the baseline and the
deployed artifact are the same code).

Read this file first. It is the resume point. `INVENTORY.md`, `ROUTES.md`, `DESIGN.md`,
`VALIDATION.md` and `RELEASE.md` hold the detail.

## Phase board

This table is the source of truth and is updated as each gate is actually met — not when
work starts. `⛔` means no code exists yet.

| Phase | State | Evidence |
|---|---|---|
| 0 — Baseline | ✅ done | `INVENTORY.md`, `ROUTES.md`, `VALIDATION.md` §Baseline, `tests/run-all.sh` |
| 1 — Correct known defects | ⏳ in progress | — |
| 2 — Foundation | ⛔ not started | — |
| 3 — Design reference | ⛔ not started | — |
| 4 — Standard features | ⛔ not started | — |
| 5 — Media | ⛔ not started | blocked, see below |
| 6 — Quality and packaging | ⛔ not started | — |
| 7 — Controlled rollout | ⛔ not started | — |
| 8 — Retirement | ⛔ not started | gated on 5 + 7 |

## Current position

The legacy dashboard at `/` is the default and the only interface. Phase 0 established a
reproducible baseline: the route contract, the feature inventory, a containerised test
harness, and confirmation of every defect the execution plan predicted.

## Next action

Finish Phase 1: the five confirmed legacy defects and the three confirmed
auth/config risks, each with a regression test.

## Unresolved risks and blockers

1. **Phase 5 (Watch/Huddle) is blocked on hardware.** Verifying the acceptance criteria
   (join/leave/reconnect, duplicate capture, mobile suspension) needs a real camera,
   microphone and a second participant. This session has neither. Building the session
   owner without being able to test it would ship the highest-risk code unverified, so
   Watch and Huddle in `/app` deliberately hand off to the existing legacy
   implementation. See `ROUTES.md` §Media handoff.
2. **`/data` is not writable on this host** (root-owned Coolify state). All Python tests
   therefore run inside the app image via `tests/run-all.sh`. Do not run the suites
   directly on the host — nine of them fail at boot with `unable to open database file`
   and that failure is an artefact of the host, not of the code.
3. **Five test suites failed before any of this work started.** They are listed in
   `VALIDATION.md` §Pre-existing failures with the reason for each. None are caused by
   this branch and none were "fixed" by editing the test.
4. **The Host-header auth bypass is narrowed, not removed.** The Stream Deck plugin
   (`psn-slapper.sdPlugin`) authenticates purely by hitting a bare Tailscale/LAN IP. A
   machine-token path now exists alongside it, but the plugin has to be rebuilt and
   re-installed on the user's Stream Deck hardware before the Host path can be deleted.
   See `ROUTES.md` §Machine access.
5. **Giveaway auto-reveal still depends on an admin opening the page.** Documented in
   `INVENTORY.md`; deliberately left in place. It must become an idempotent backend job
   *before* the legacy giveaway screen is retired, or scheduled reveals silently stop.
6. **No field performance data.** Core Web Vitals in `VALIDATION.md` are lab numbers from
   this machine. They do not establish field INP or 75th-percentile anything.
