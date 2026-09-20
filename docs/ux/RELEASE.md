# Release, operations and rollback

**Nothing here has been deployed.** This is the procedure and the gates, not a record of a
release. Current state: `feat/ui-ux-migration` at `ed7d709`; production is running
`d2804ef`.

## What is safe about this change

The new interface is **additive**. `/` is still the legacy dashboard and still the default.
No existing route changes behaviour. A user who never types `/app` sees the Phase 1 defect
fixes and nothing else.

That means the release decision splits in two, and they can be taken separately:

1. **Ship the branch.** Users get the Phase 1 fixes (deep links, no duplicate sends,
   recoverable panels, working Back) plus the security changes. `/app` exists but nobody is
   sent there.
2. **Switch the default.** A separate, later decision, gated on the media work landing.
   See §Switching the default.

Step 1 is the ordinary case and the rest of this document assumes it.

## Build

```bash
docker build -t crcmz-app:<tag> .
```

Two stages. The first runs `npm ci` against the committed `frontend/package-lock.json` and
`npm run build`, which chains `tsc -b --noEmit` before `vite build` — a type error fails the
image build rather than shipping. The second is the Python runtime; only `frontend/dist` is
copied forward, so node and `node_modules` never reach it.

`frontend/dist` is gitignored on purpose: the image builds it. Do not commit a build.

## Configuration

### New

| Var | Required | Purpose |
|---|---|---|
| `CRCMZ_MACHINE_TOKEN` | no | Lets a machine caller authenticate explicitly, over any Host, from anywhere. The migration path off the private-network rule. Unset means nobody is a machine — it does not weaken anything. |

### Changed behaviour of an existing var

`SESSION_SECRET` **must** be set to serve the public host. Previously an unset value
silently fell back to signing cookies with the literal string `dev-insecure`, which is
published in this repository. Now:

* set → unchanged, everything works as before
* unset → a random per-process key, a loud warning, and **503 on the public host** with
  `/health` still answering

Production already sets it in Coolify, so this is a no-op there. If it is somehow unset,
the app will refuse rather than run on a forgeable key — check the logs for
`SESSION_SECRET is not configured` before assuming an outage is something else.

**Do not rotate `SESSION_SECRET` as part of this deploy.** Rotating it invalidates every
signed cookie and signs everyone out. Keep the existing value; rotate deliberately, on its
own, if you ever want to.

No other env var changes. No schema changes. No new data store, so `tests/test_mcp_coverage.py`
is unaffected by this work.

## Deploy (Coolify)

Unchanged from `README.md`:

* Build: Docker, `Dockerfile` in the repo root
* Port: 3000
* Health check: `GET /health`
* Volume: `/data`
* Branch: `main`

Because `Dockerfile` and `frontend/` changed, this needs a **redeploy**, not a restart.

The build now installs npm dependencies, so the first build on a cold cache is a few
minutes longer than before. If the builder has no network access to the npm registry, the
build fails in the frontend stage — that is the one new external dependency of the build.

### Before you ship

| Gate | Status |
|---|---|
| `tests/run-all.sh` — no new failures vs baseline | ✅ same five pre-existing failures, nothing new |
| `tests/browser/run.sh dashboard.spec.mjs` | ✅ 18/18 |
| `tests/browser/run.sh app.spec.mjs` | ✅ 43/43 |
| `tests/browser/run.sh a11y.spec.mjs` | ✅ 24 views, 0 violations |
| `node tests/browser/contrast.mjs` | ✅ all pairs pass |
| Route contract unchanged | ✅ `VALIDATION.md` §Route and API compatibility |
| Image builds, container healthy | ✅ |
| Previous image available to roll back to | ✅ built and exercised repeatedly |
| Persistent-data backup verified | ⛔ **not verified by this work.** `/data` holds every SQLite store and live PSN tokens. Confirm the Coolify volume is in whatever backup you rely on *before* deploying. This change makes no schema change and writes nothing new, so the risk is low — but "low" is not "checked". |
| Zitadel login exercised end to end | ⛔ not done — see `VALIDATION.md` §Deployment |

The two ⛔ rows are why this says the gates are not all met. The first is a five-minute
check someone with Coolify access can do; the second happens naturally on the first real
sign-in after deploy and is the first thing to watch.

## After deploying

Watch these, in this order:

1. **`/health`** goes healthy. If not, `docker logs` — the likely causes are a missing
   `SESSION_SECRET` (now fatal for the public host, by design) or the frontend stage having
   produced no `dist`.
2. **Sign in.** This is the one path no test covered. A real Zitadel round trip, landing
   back on `/`.
3. **The legacy dashboard still works.** `/`, then click through Squad, Clips, Slap,
   WhatsApp, Giveaway, Watch, Huddle, Ask AI. Then `/?p=slap` directly — that is the deep
   link that used to throw.
4. **Watch Party and Huddle still connect.** Untouched by this branch, but they are the
   highest-consequence features and worth a look.
5. **The Stream Deck plugin still works.** Press a button. It authenticates by calling a
   Tailscale IP, and the rule behind that was narrowed. `tests/test_auth_gate.py` covers the
   exact addresses it uses, but a real press is the real test.
6. **`/app`** loads, and `/app/clips` on a refresh.
7. **Errors.** Frontend exceptions in the console, 401s and 5xx in the logs, and any growth
   in request volume.

A 24-hour window covering representative use before considering the legacy interface
retired. Given the size of this squad, traffic may simply be too thin to be meaningful — if
so, say that rather than treating a quiet day as validation.

## Rollback

```bash
# In Coolify: redeploy the previous image tag (d2804eff…), or
docker run -d --name crcmz-app -p 3000:3000 -v <volume>:/data <previous-image>
```

Then verify a minimal core workflow: `/health`, sign in, `/` renders, one soundboard button
sends.

No data migration means nothing to undo. `/data` is untouched by this change.

### Read this before rolling back

Rolling the whole image back **reintroduces the auth and session fixes' absence**:

* session cookies signed with the published `dev-insecure` constant when `SESSION_SECRET`
  is unset
* the `Host` header alone accepted as authentication
* the account display name interpolated into HTML unescaped

If a rollback is needed for a *cosmetic or frontend* reason, prefer reverting `ed7d709`
(the frontend commit) and keeping `be017bc` (the fixes), which is a clean split — `be017bc`
touches only `server.py`, `tests/` and `docs/`, and `ed7d709` adds `frontend/` plus the
`/app` handlers.

```bash
git revert --no-commit ed7d709 && git commit -m "revert: back out /app pending a fix"
```

Keep the logs from whatever went wrong. Fix it in a new candidate rather than
re-deploying the same image.

Do not, as part of recovery: delete user data, change DNS, rotate `SESSION_SECRET`, or
touch a working integration.

## Switching the default

Not done, and it should not be done yet.

The mechanism, when the time comes: `/` reads a cohort or a flag and serves the new document
to the people in it. Two constraints that are easy to get wrong —

* **The flag must never grant API permission.** It chooses a document. Every endpoint keeps
  checking the session and the Zitadel role itself.
* **Never switch someone mid-session.** Moving between the two interfaces is a full
  navigation and will end an active Watch or Huddle session. Switch on a fresh load, or
  offer it as a link the user clicks while idle.

The blockers, from `STATUS.md`:

1. **Watch and Huddle are not migrated.** Making `/app` the default would hide the squad's
   two live features behind a handoff link. This is the real blocker.
2. **Giveaway auto-reveal** needs an idempotent backend job first, or scheduled reveals stop.
3. **Clip playback** needs a media endpoint, or the new Clips screen is strictly less useful
   than the old one for actually watching a clip.
4. **No real-device or screen-reader testing.** Mobile is where this squad uses the app.

Until 1 and 2 are done, the honest position is: ship it as an opt-in second interface, point
people at `/app`, and collect the thing no test can produce — someone using it.

## Retirement

Not started, and gated on everything above. When it happens: remove the dashboard template
and its CSS/JS from `server.py`, keep `/`, `/dashboard`, `/watch` and the `?p=` compatibility
redirects working, and only then consider deleting the Host-header branch in `_auth_gate` —
after the Stream Deck plugin ships a `CRCMZ_MACHINE_TOKEN`.
