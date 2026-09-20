# Feature inventory and parity

Built from `server.py` at `d2804ef`, not from the execution plan's list. Status words mean
exactly this:

| Word | Meaning |
|---|---|
| **inventoried** | Found in the backend and written down. No new code. |
| **implemented** | Code exists in `frontend/src`. |
| **integrated** | Wired to the real endpoint, not a fixture. |
| **verified** | A check exercises it and passes — named in `VALIDATION.md`. |
| **migrated** | Verified *and* its legacy route could be retired. Nothing is here yet: nothing has been retired. |

Nothing below is marked `migrated`, because the legacy dashboard is still the default and
the observation window in `RELEASE.md` has not run.

## Home / Squad

| Capability | Status | Notes |
|---|---|---|
| Presence, current game, platform | verified | `/api/squad`. Refreshes at 30s, the legacy cadence. |
| Trophy level, platinum, gold | verified | Per row; plat/gold hidden below `sm` to keep rows one height. |
| Avatars | verified | Monogram is the default and the image layers over it, so a 404 leaves a readable initial instead of a broken-image icon. |
| Hype meter | verified | `/api/hype`, 60s. Its own query — a failure does not take presence with it. |
| Aggregate tiles (platinums, top level, squad favourite) | verified | Computed from the member list, as in the legacy build. |
| "PSN is not answering" state | verified | `{squad: [], error: …}` gets its own message, distinct from a failed request. |
| Data freshness | verified | "Updated 2m ago", and "Stale · last updated …" when a refresh failed. |
| Rank/trophy leaderboard section | **inventoried only** | The legacy Squad tab had a separate ranks block. Home shows the numbers per row instead; a dedicated leaderboard is not built. |
| "Rally" / play-together prompt | **inventoried only** | `/api/watch/rally` exists and the legacy tab rendered a "together" banner. Not migrated — it is entangled with the Watch session. |

## Chat Board / Soundboard

| Capability | Status | Notes |
|---|---|---|
| Shared board: list, fire | verified | `/api/soundboard`, `/v2/squad`. |
| Personal board: list, fire as the user | verified | `/api/soundboard/personal`, `/v2/send`. |
| Explicit board selection | verified | A real tab list. The legacy UI hid the personal board behind a horizontal swipe with no keyboard equivalent. |
| Create a button | integrated | `POST /api/soundboard{,/personal}` with `send: false`, so creating and firing are separate intentions — the legacy version posted to the group immediately with no way to decline. Shows the flavoured text that was actually saved. |
| Delete a button | integrated | Confirmation names the button. Keyed on `msg`, which is what the handler matches. |
| Quick message composer | verified | One request per burst of clicks *and* per burst of Enters. |
| Pending / success / rate-limit / uncertain delivery | verified | A transport failure on a POST says "may or may not have sent", because these post to a real PSN group and are not idempotent. |
| Reorder the personal board | **inventoried only** | `POST /api/soundboard/personal/order` is unused by the new UI. The legacy affordance was long-press-drag with no alternative; the replacement needs Move up/Move down buttons, which are specified but not built. |
| Collapse / fullscreen / organise mode | **not carried over** | Deliberate: the board is a drawer, so "collapse" has no meaning and "fullscreen" is what the drawer already is. |

## Clips / Montages

| Capability | Status | Notes |
|---|---|---|
| Catalogue with sender, time, duration, resolution, size | verified | `/clips`. |
| Status, WhatsApp delivery, montage eligibility, last error | verified | |
| Filters: month, sender, status | verified | In the URL, so a filtered view is shareable and survives refresh. |
| Montage summary | integrated | Clips this month, latest clip, last montage, next build. |
| Re-send to WhatsApp | integrated | Behind a confirmation; "may have been queued" on a transport failure. |
| Service diagnostics | verified | **Moved to `/app/admin`.** The legacy Clips tab opened with a table of service versions and ping times. |
| **Playback and thumbnails** | ⛔ **blocked — no endpoint** | There is no route that serves clip bytes or an image. `storage_key_original` / `storage_key_normalized` point into S3; nothing generates a presigned URL. The screen says so once, plainly, instead of rendering players against URLs that do not exist. Adding `GET /api/clips/{uid}/media` returning a short-lived presigned URL is the fix, and it is a backend change. |

## Music / Slapshare

Data comes from `https://slap.qureshi.io/api/v1/dashboard`, not this backend.

| Capability | Status | Notes |
|---|---|---|
| Overview (shares, contributors, artists) | integrated | |
| Contributor leaderboard | integrated | |
| Recent shares with platform | integrated | |
| Independent widget failure | verified | Each is its own query. The legacy tab put all thirteen in one `Promise.all`, so one bad response killed the tab — and left it stuck, because the load guard was set before the request and never cleared (fixed for the legacy UI in Phase 1). |
| Hot / genres / timeline / artists / achievements / hipster / streaks / personality / hall-of-fame / heatmap / head-to-head / scrobbles | **inventoried only** | Ten further panels the legacy tab rendered. Not reimplemented: their response shapes were never verified against the live service during this work, and writing a renderer against a guessed shape is how you ship a screen that silently shows nothing. |

## WhatsApp

| Capability | Status | Notes |
|---|---|---|
| Range selector (all time, year, month, last month, today, custom) | verified | In the URL. `aria-pressed` on the chips, which the legacy CSS-class-only version lacked. |
| Custom range validation | verified | Not requested until both dates exist and are the right way round — the backend silently widens an incomplete range to everything, which looks like the filter being ignored. |
| Totals | verified | |
| Awards | integrated | Fifteen award keys flattened out of the keyed response dict. |
| Member activity table | verified | A real `<table>` with headers and a caption; the scroll container is focusable so a keyboard user can reach the right-hand columns on a phone. |
| Top emoji | integrated | |
| Excel export | integrated | A plain download link, per range. |
| Authorised history import | integrated | Only rendered when `can-import` says so. Size is checked before upload, because a "with media" export is rejected by Cloudflare at the edge with an HTML page the app never sees. |
| Stale range responses | verified | Every query is keyed by range, so a superseded response cannot be written into the current view. |
| Activity timeline, hour×day heatmap, word counts, response times | **inventoried only** | Endpoints exist and are documented in `ROUTES.md`; the charts are not rebuilt. |

## Giveaways

| Capability | Status | Notes |
|---|---|---|
| Member view: prize, status, reveal date, own eligibility | integrated | |
| Cycle rotation progress | integrated | |
| Winner reveal | integrated | The backend withholds the draw from non-admins until reveal; the UI never tries to show it. |
| History | integrated | |
| Create / publish / lock / draw / reveal / close / redraw | integrated | Only the transitions the current status permits are offered. |
| Entry add/remove | integrated | Sends `member_id` **and** `display_name` — the handler subscripts both, so omitting either is a 500. |
| Destructive actions confirmed | verified | The confirm button says what happens ("Draw the winner"), never "OK". |
| **Rendering never mutates** | verified | A dedicated check loads the screen with a giveaway whose reveal time has passed — the exact condition under which the legacy loader POSTed `draw-and-reveal` from inside its own data fetch — navigates away and back, and asserts zero writes. |
| **Scheduled auto-reveal** | ⛔ **deliberately not carried over** | See below. |

### The auto-reveal blocker

`loadGiveaway()` in the legacy dashboard did this:

```js
if (g && d.is_admin && ['open','locked','drawn'].includes(g.status)
    && g.reveal_at && gwParseLocalDate(g.reveal_at) <= Date.now()) {
  await fetch('/api/giveaway/' + g.id + '/draw-and-reveal', {method:'POST'});
  _gwLoaded = false; loadGiveaway(); return;
}
```

So a scheduled reveal happened when, and only when, an admin opened the tab after the
time had passed. That is a mutation triggered by rendering, and the new screen does not
reproduce it.

The consequence, stated plainly: **a scheduled reveal now waits for an admin to press
Reveal.** Restoring the timing needs an idempotent backend job — a periodic task that
draws and reveals at most once per giveaway, guarded on the row's status so a retry or a
second worker cannot double-draw. That is a backend change with a fake-clock test, and it
must land **before** the legacy giveaway screen is retired, or scheduled reveals stop
silently. Tracked in `STATUS.md`.

## Ask AI

| Capability | Status | Notes |
|---|---|---|
| Stored conversation | verified | Rendered from `/api/assistant/history`; the server owns it. |
| Pending job survives refresh, navigation, a locked phone | verified | `ask` returns 202 and the answer is written server-side, so coming back just reads it. Polling runs only while the endpoint reports `pending`, and stops otherwise — the legacy version left an interval running for the life of the page. |
| "Still working on your last one" (409) | integrated | Reported as a state, not an error. |
| Tool badges, elapsed time | integrated | |
| Clear chat | integrated | Confirmed; says facts are kept. |
| Suggestion chips | integrated | |
| Draft preserved on failure | verified | The box is cleared only once the server has accepted the question. |
| Squad facts: list, add, delete own | integrated | Subject datalist, so "Zubi" and "zubair221b" do not split what the model knows about one person. |
| Model unavailable | integrated | Says so instead of failing on submit. |
| **Image attachment** | **inventoried only** | `AssistantRequest` takes `image_b64` and `image_type` and the API client supports it; there is no picker in the UI. |
| Streaming / progress percentage | **correctly absent** | The backend has neither. |

## Watch Party — ⛔ not migrated

| Capability | Status |
|---|---|
| Room identity, signed ES256 tickets, participant nicknames, playback sync, URL extraction, the media proxy, chat, cameras, microphone, the cross-page mini-player | **inventoried only** — `/app/watch` hands off to the classic interface |

Not attempted. Verifying it needs a camera, a microphone, a second participant and a
mobile device to background; none were available. Building the session owner without being
able to test join, leave, reconnect, duplicate capture and OS suspension would put the
highest-risk code in this migration into production unverified, which is worse than an
honest handoff.

## Huddle — ⛔ not migrated

| Capability | Status |
|---|---|
| Join preview, device selection, mic/camera, screen share, grid/spotlight, blur, transcription, AI notes, Leave | **inventoried only** — `/app/huddle` hands off to the classic interface |

Same reason.

## Account and sign-in

| Capability | Status | Notes |
|---|---|---|
| Zitadel login and callback | verified | Unchanged; `/app` redirects to `/auth/login?next=…` and returns to the right screen. |
| Session expiry handling | integrated | A banner, once, and the previous user's cached reads are cleared. |
| PSN link status, claim an unclaimed record | integrated | Claim sends `key`, which is what the handler reads. |
| Mattermost connect / unlink | integrated | Connect is a real link — it starts an off-site redirect. |
| MCP access status and revoke | integrated | |
| Passkeys: list, delete | integrated | |
| **Passkey registration** | **inventoried only** | A WebAuthn ceremony with base64url challenge material on both legs. A subtle error produces a credential that silently cannot sign in, and there was no way to test it on real hardware. The screen links to the classic interface for it. |
| Change own password | integrated | Sends `currentPassword` / `newPassword`. |
| Logout | verified | `/auth/logout`, unchanged. |

## Administration

| Capability | Status | Notes |
|---|---|---|
| Service health table | integrated | Moved here off the Clips screen. |
| Montage / clip operational metrics | integrated | |
| Account list with state | integrated | |
| Admin password reset | integrated | Plain-text field on purpose — an admin has to read back what they are handing over. |
| Server-side authority | verified | Every endpoint re-checks the Zitadel role. The route guard is for discoverability; bypassing it yields 403s and an empty screen. |
| `reset-and-seed` | **deliberately not surfaced** | Destructive test tooling. It was not in the legacy UI either. |

## Roles

| Role | How it is determined | What changes |
|---|---|---|
| Anonymous | no session cookie | Sees sign-in prompts with a working return path. Screens that need an identity say so rather than erroring. |
| Member | valid session | Everything except the admin route and the role-gated WhatsApp import. |
| Admin | `_is_iam_admin` against a Zitadel role | Admin route, giveaway transitions, user management, import. |
| Machine | `CRCMZ_MACHINE_TOKEN`, or a private peer on the legacy path | The Stream Deck endpoints. No UI. |
