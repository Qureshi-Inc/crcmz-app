# Route contract

Baseline commit `d2804ef`. Every route below was read out of `server.py` (115 `@app.*`
decorators) and the behaviour column is what a request actually returns, not what the
handler looks like it should return.

## Authorisation classes

| Class | How it is enforced |
|---|---|
| **public** | Listed in `_OPEN_PATHS` — reachable with no credential at all. |
| **session** | Signed `psn_session` cookie required, when `Host == PORTAL_PUBLIC_HOST`. |
| **machine** | `CRCMZ_MACHINE_TOKEN` as `Authorization: Bearer` or `X-CRCMZ-Machine-Token`. New. |
| **local** | Reachable without a session from a private network — the historical bypass, now narrowed. See §Machine access. |
| **own-auth** | In `_OPEN_PATHS` but the handler checks its own credential (`/mcp`, `/api/whatsapp/ingest`). |

## API and system routes — unchanged

Nothing in this table changed. They are listed because the `/app` fallback had to be
written so as not to shadow any of them, and because that is the property the route
contract check in `VALIDATION.md` verifies.

| Route | Methods | Class | Notes |
|---|---|---|---|
| `/health`, `/v2/health` | GET | public | Container healthcheck uses the first. |
| `/.well-known/webauthn` | GET | public | Passkey RP config. |
| `/.well-known/oauth-authorization-server` | GET | public | MCP OAuth metadata. |
| `/favicon.png`, `/crcmz-logo.png`, `/footer-avatar.png` | GET | session/local | Served from disk with a 1-day cache. |
| `/auth/login` | GET, POST | public | GET renders the sign-in page; POST is the password path. |
| `/auth/callback` | GET | public | Zitadel OIDC redirect target. |
| `/auth/logout` | GET | public | Clears the cookie. |
| `/auth/passkey/begin`, `/auth/passkey/complete` | POST | public | WebAuthn sign-in ceremony. |
| `/auth/passkey/register/begin`, `/…/complete` | POST | session | WebAuthn registration. |
| `/auth/settings/passkeys` | GET | session | List. |
| `/auth/settings/passkeys/{id}` | DELETE | session | |
| `/auth/settings/password` | POST | session | Body: `currentPassword`, `newPassword`. |
| `/auth/settings/psn` | GET | session | Linked record, or the unclaimed list. |
| `/auth/settings/psn/claim` | POST | session | Body: `key` (the record stem, **not** the online id). |
| `/auth/settings/mattermost` | GET | session | |
| `/auth/settings/mattermost/connect` | GET | session | Starts an off-site OAuth redirect. |
| `/settings/mattermost/callback` | GET | public | Arrives from Mattermost; signed state carries the identity. |
| `/auth/settings/mattermost/unlink` | POST | session | |
| `/auth/settings/mcp` | GET | session | |
| `/auth/settings/mcp/revoke` | POST | session | |
| `/oauth/register`, `/oauth/login`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | GET/POST | public | Per-user MCP OAuth + PKCE. |
| `/mcp` | GET, POST | own-auth | Bearer token or per-user OAuth; checked in `mcp_server.py`. |
| `/api/admin/check` | GET | session | Also the frontend's session probe. |
| `/api/admin/users` | GET | session + admin | 403 for a non-admin. |
| `/api/admin/users/{id}/reset-password` | POST | session + admin | Body: `newPassword`, min 8. |
| `/api/squad` | GET | session/local | `{squad: [...]}`, plus `error` when PSN is down. |
| `/api/hype` | GET | session/local | `{count, pct, label, level}`. |
| `/api/soundboard` | GET, POST | session/local | POST also fires the message unless `send: false`. |
| `/api/soundboard/delete` | POST | session/local | Body: `text` — matched against `msg`, not the label. |
| `/api/soundboard/personal` | GET, POST | session | 401 with no session. |
| `/api/soundboard/personal/delete` | POST | session | Body: `text`. |
| `/api/soundboard/personal/order` | POST | session | Body: `labels`. |
| `/api/whatsapp/{stats,activity,heatmap,words,emojis,response-times,members,awards}` | GET | session/local | All take `range`, `start`, `end`. |
| `/api/whatsapp/can-import` | GET | session/local | Role-gated answer. |
| `/api/whatsapp/export` | GET | session/local | Returns an .xlsx; used as a plain download link. |
| `/api/whatsapp/import` | POST | session + role | multipart; 50 MB app cap, 100 MB edge cap. |
| `/api/whatsapp/ingest` | POST | own-auth | `WA_INGEST_SECRET`. The Baileys bridge. |
| `/api/assistant/tools` | GET | session | |
| `/api/assistant/ask` | POST | session | **202** with `reply_id`; the answer lands in the thread. 409 if one is pending. |
| `/api/assistant/history` | GET | session | `{messages, pending}`. |
| `/api/assistant/clear` | POST | session | |
| `/api/assistant/facts` | GET, POST | session | Shared across the squad. |
| `/api/assistant/facts/delete` | POST | session | |
| `/api/giveaway` | GET, POST | session (POST: admin) | |
| `/api/giveaway/history` | GET | session | |
| `/api/giveaway/{gid}` | PUT | admin | |
| `/api/giveaway/{gid}/{publish,lock,draw,reveal,draw-and-reveal,close,redraw}` | POST | admin | Refusals come back **200 with `{"error": …}`**. |
| `/api/giveaway/{gid}/entries` | POST | admin | Body needs `member_id` **and** `display_name`. |
| `/api/giveaway/{gid}/entries/{member_id}` | DELETE | admin | |
| `/api/giveaway/admin/reset-and-seed` | POST | admin | Destructive; not surfaced in either UI. |
| `/clips` | GET | session/local | **JSON catalogue.** Filters: month, sender, group_id, status, montage_eligible, limit, offset. |
| `/clips/{message_uid:path}` | GET | session/local | JSON detail. |
| `/api/clips/{message_uid:path}/resend` | POST | session/local | Re-forwards to WhatsApp. |
| `/api/pipeline-status` | GET | session/local | Service health + montage summary. |
| `/api/video-jobs` | GET | session/local | |
| `/api/scan-group` | POST | session/local | Backfill; registers clips only, never forwards. |
| `/status` | GET | session/local | JSON. |
| `/send`, `/messages` | POST/GET | local | Legacy PSN paths the Stream Deck plugin uses. |
| `/v2/send`, `/v2/squad` | POST | session/local | Not idempotent. Rate-limited. |
| `/v2/messages`, `/v2/messages/raw` | GET | session/local | |
| `/roast/{start,stop,once}` | POST | local | Stream Deck. |
| `/roast/status` | GET | local | |
| `/api/watch/jwks.json` | GET | public | Public key material only. |
| `/api/watch/config` | GET | session | |
| `/api/watch/join` | POST | session | Mints a signed ES256 Watch Ticket. |
| `/api/watch/proxy`, `/api/watch/extract` | GET/POST | session | |
| `/api/watch/nickname`, `/api/watch/rally` | POST | session | |
| `/api/huddle/token` | POST | session | LiveKit token. |
| `/api/huddle/ai`, `/api/huddle/transcribe` | POST | session | |
| `/watch` | GET | session | Redirects to `/?p=watch`. |
| `/portal`, `/portal/link` | GET/POST | session/local | HTML. |
| `/portal/users` | GET | session/local | JSON. |
| `/`, `/dashboard` | GET | session | The legacy dashboard. **Still the default.** |

## New routes

| Route | Methods | Class | Behaviour |
|---|---|---|---|
| `/app/assets/{path}` | GET | public | A built file, `Cache-Control: public, max-age=31536000, immutable`. A missing file is **404**, never the index document. Public because it is client code with no user data, and cookie-gating it would defeat the content-hashed filenames. Path traversal is blocked with a containment check before any filesystem access. |
| `/app` | GET | session | The SPA document. `Cache-Control: no-store`, `Vary: Cookie`. |
| `/app/{path}` | GET | session | Same document, for any path the client router owns. A request that is **not** a navigation (no `text/html` in Accept) **and** has a file extension gets a 404 instead — a missing `.js` must not arrive as HTML with a 200. |

The fallback is deliberately two explicit handlers rather than a `StaticFiles(html=True)`
mount at `/`. A blanket mount answers index.html for every unknown path, which turns a
typo'd API call into an unexplainable JSON parse error and hides real 404s.

## Screen mapping

| Legacy `?p=` | New route | Migrated? |
|---|---|---|
| `?p=squad` | `/app` | yes |
| `?p=pipeline` | `/app/clips` | yes, minus playback (no endpoint — see below) |
| `?p=slap` | `/app/music` | partial — overview, leaderboard, recent shares |
| `?p=wa` | `/app/community/whatsapp` | yes, minus four secondary charts |
| `?p=giveaway` | `/app/community/giveaways` | yes |
| `?p=ai` | `/app/ai` | yes |
| `?p=watch` | `/app/watch` | **no** — handoff to the classic interface |
| `?p=huddle` | `/app/huddle` | **no** — handoff to the classic interface |
| account modal | `/app/settings` | yes, minus passkey registration |
| admin controls | `/app/admin` | yes |

`INVENTORY.md` has the per-capability detail.

### Compatibility

* `/app?p=slap` and `/app#giveaway` resolve to the new path client-side and `replace` the
  history entry, so Back does not bounce forward again. A fragment never reaches the
  server, which is why this has to happen in the browser.
* The mapping is an **allowlist** (`pathForLegacy`). An unrecognised `?p=` — including
  `?p=../../evil` — is ignored and leaves the user on Home. Verified.
* `/`, `/dashboard`, `/watch` and every `?p=` value still work exactly as before. Nothing
  redirects to `/app`.
* An unknown `/app/...` path renders a not-found view that lists real destinations.

### Media handoff

`/app/watch` and `/app/huddle` are not the feature. They explain that it lives in the
classic interface and link to it with a plain `<a>`, because switching documents is a full
navigation that will end anything currently connected — so it is a deliberate click, and
the screen says that will happen.

## Machine access

The auth gate used to treat "your Host header is not `PORTAL_PUBLIC_HOST`" as
authentication. That value is chosen by the caller, so it was not a check at all.

It now requires all three:

1. `Host` is not the public host, **and**
2. the peer address is in `_LOCAL_NETWORKS` (loopback, RFC1918, link-local, and
   `100.64.0.0/10` for Tailscale), **and**
3. no proxy header is present (`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`,
   `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`) — behind Traefik the peer *is* the proxy
   and its address is private, so the address test alone would pass for a public caller.

`_LOCAL_NETWORKS` lists the ranges explicitly rather than using
`ipaddress.is_private`, which is the wrong predicate in both directions: it is **False**
for Tailscale's CGNAT range (so it would have locked the Stream Deck plugin out) and
**True** for the documentation ranges like `203.0.113.0/24`. Both were caught by
`tests/test_auth_gate.py` before this shipped.

**The forward path** is `CRCMZ_MACHINE_TOKEN`, which authenticates from anywhere over any
Host. Callers still on the old path, all of which must be migrated before branch 1–3 can
be deleted:

| Caller | How it authenticates today | Endpoints |
|---|---|---|
| Stream Deck plugin (`psn-slapper.sdPlugin`) | Nothing — it calls `http://100.123.228.75:3021` and `http://192.168.5.54:3021` | `/send`, `/v2/send`, `/v2/squad`, `/roast/{start,stop,once}` |
| Container healthcheck | loopback | `/health` |
| Baileys bridge | `WA_INGEST_SECRET`, already explicit | `/api/whatsapp/ingest` |
| MCP clients | Bearer token or OAuth, already explicit | `/mcp` |

Only the Stream Deck plugin actually blocks removal, and it needs a rebuild and a
re-install on the user's hardware.
