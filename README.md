# CRCMZ App — psn-messenger

Squad platform for Professional Goopers. One FastAPI service that does everything:
PSN messaging, WhatsApp analytics, clip pipeline, soundboard, giveaway, watch party,
AI assistant, MCP server, and the portal at **app.crcmz.me**.

---

## What it does

| Area | What it is |
|---|---|
| Portal | Squad dashboard — online now, ranks, WhatsApp stats, clips, soundboard |
| PSN | Sends messages to PSN group threads; monitors for AI triggers (`ai <question>`) |
| WhatsApp | Receives messages from Baileys bridge, stores analytics, AI bot (`ai <question>`) |
| Clips | Receives PSN clip webhooks, stores them, auto-forwards video to WhatsApp/Discord |
| Soundboard | Personal + shared button boards; Stream Deck plugin talks to this |
| Giveaway | Entry tracking and draw logic |
| Watch Party | Room management + JWT tickets; routed at `/wp`, backed by WatchParty fork |
| AI assistant | Tool-calling loop over the squad data; answers questions from WA/PSN/portal |
| MCP server | `POST /mcp` — exposes all assistant tools; per-user OAuth with write access |
| Identity graph | Zitadel metadata tags tie PSN/WA/Mattermost identities together |

---

## Architecture

```
app.crcmz.me (Cloudflare) → Coolify reverse proxy → this container (port 3000)
                                                    ↑
                               Baileys bridge  ─────┤ /api/whatsapp/ingest
                               PSN AI poller   ─────┤ internal
                               Stream Deck     ─────┤ /sd/*
```

**Auth:** Zitadel at `auth.crcmz.me`. Sessions are signed cookies (itsdangerous).
The session middleware only enforces auth when `Host == PORTAL_PUBLIC_HOST` — LAN/Tailnet
requests bypass it, so any new private endpoint needs its own check.

**Data:** Everything lives in `/data/` (mounted volume). SQLite for structured data,
JSON for small config. See the table below.

---

## Data stores

| Path | What it holds | MCP tool |
|---|---|---|
| `/data/whatsapp.db` | ~10k group messages, reactions, analytics | `whatsapp_*`, `person_profile` |
| `/data/clips.db` | PSN clip records | `recent_clips`, `person_profile` |
| `/data/game_history.db` | PS5 game sessions per user | `games_played`, `game_sessions`, `platform_overview` |
| `/data/assistant_facts.db` | Squad facts the bot has been told | `squad_facts`, `person_profile` |
| `/data/soundboard.json` | Shared soundboard buttons | `soundboard_buttons` |
| `/data/soundboard_personal.json` | Per-user soundboard boards (keyed by Zitadel ID) | `soundboard_buttons` |
| `/data/users/` | Portal PSN user records (contains live tokens) | `squad_members`, `squad_roster` |
| `/data/mcp_user_tokens.db` | OAuth codes/tokens for MCP write access | — never exposed |
| `/data/assistant_chat.db` | Bot's own conversation history | — not exposed |
| `/data/psn_tokens.json` | Live PSN access/refresh tokens | — never exposed |
| `/data/video_jobs.db` | Clip forwarding work queue | — internal |

**Rule:** every new data store needs an `@tool()` in `assistant.py` and an entry in
`tests/test_mcp_coverage.py`. Run `python3 tests/test_mcp_coverage.py` to enforce this.

---

## MCP server

Endpoint: `POST /mcp` (Streamable HTTP, JSON-RPC 2.0)

**Read-only access** — `Authorization: Bearer <MCP_TOKEN>`. Token is set in Coolify env.
All `@tool()` functions in `assistant.py` are exposed automatically. No second list to maintain.

**Write access (per-user OAuth)** — OAuth 2.0 + PKCE against `app.crcmz.me`.

```
claude mcp add --transport http crcmz https://app.crcmz.me/mcp
```

Claude Code will open the browser, user signs in with their CRCMZ account, clicks Allow.
Write tools then appear: `send_psn_group_message`, `send_whatsapp_group_message`,
`send_whatsapp_dm`, `send_mattermost_dm`.

OAuth endpoints: `/.well-known/oauth-authorization-server`, `/oauth/register`,
`/oauth/authorize`, `/oauth/token`, `/oauth/revoke`.

MCP connection status and revoke: **Settings → 🤖 MCP** in the portal.

---

## Identity graph

Zitadel user metadata tags are the single source of truth for cross-platform identity.

| Tag | Meaning |
|---|---|
| `psn_id` | PlayStation Online ID |
| `wa_jid` | WhatsApp JID (e.g. `4479...@s.whatsapp.net` or `...@lid`) |
| `wa_phone` | WhatsApp phone number |
| `wa_names` | Known display names in WhatsApp messages |
| `mm_username` | Mattermost username |

`psn_id` falls back to the portal's PSN link when the tag is unset.
`wa_jid` falls back to the most recent `sender_jid` in `whatsapp_messages` by `wa_names`.

Always resolve people through `crcmz_identity.resolve(who)` — never match by display name.

---

## WhatsApp DM relay

When `send_whatsapp_dm` is called via MCP, the bot DMs the recipient on WhatsApp.
If the recipient replies, the bot relays it back to the sender's WhatsApp as
`[Name replied] text`. Threads expire after 24 h of inactivity. Replies are never
stored in `whatsapp.db`.

Requires: Baileys bridge (`whatsapp-worker`) redeployed with DM forwarding enabled.

---

## Environment variables

### Required

| Var | Purpose |
|---|---|
| `NPSSO_TOKEN` | PSN session token (~60 day TTL). Refresh via Sony SSO cookie endpoint |
| `GROUP_ID` | PSN group thread ID for the main mod group |
| `SQUAD_GROUP_ID` | PSN group thread ID for the squad (write tools post here) |
| `SESSION_SECRET` | Signs session cookies — must be long random string |
| `ZITADEL_CLIENT_ID` | OIDC client ID registered in Zitadel |
| `ZITADEL_SERVICE_TOKEN` | Zitadel service account PAT for user management API |
| `WA_INGEST_SECRET` | Shared secret between this app and the Baileys bridge |
| `WA_GOOPERS_JID` | WhatsApp group JID for the squad group |
| `WA_BRIDGE_URL` | Internal URL of the Baileys bridge (e.g. `http://10.0.1.1:3100`) |
| `MCP_TOKEN` | Shared bearer token for read-only MCP access |

### Optional / feature flags

| Var | Default | Purpose |
|---|---|---|
| `PORTAL_PUBLIC_HOST` | `app.crcmz.me` | Host header used to enforce session auth |
| `ZITADEL_ISSUER` | `https://auth.crcmz.me` | Zitadel OIDC issuer |
| `OLLAMA_BASE_URL` | — | Local LLM base URL (OpenAI-compatible) |
| `OLLAMA_MODEL` | `llama3.2` | Model name for the AI assistant |
| `OLLAMA_API_KEY` | — | API key if the LLM endpoint requires one |
| `WA_AI_ENABLED` | `1` | Set to `0` to disable WhatsApp AI responses |
| `PSN_AI_ENABLED` | `1` | Set to `0` to disable PSN AI polling |
| `PSN_AI_POLL_SECONDS` | `20` | How often to poll PSN for new messages |
| `DISCORD_BOT_TOKEN` | — | Discord bot token for clip forwarding |
| `DISCORD_CLIPS_CHANNEL_ID` | — | Discord channel to post clips to |
| `LIVEKIT_URL` | `wss://huddle.crcmz.me` | LiveKit server for Huddle |
| `LIVEKIT_API_KEY` / `_SECRET` | — | LiveKit credentials |
| `WHISPER_BASE_URL` | — | Whisper-compatible STT endpoint |
| `WHISPER_API_KEY` | — | STT API key (Groq / OpenAI) |
| `MM_OAUTH_CLIENT_ID` / `_SECRET` | — | Mattermost OAuth app credentials |
| `ARC_ALERT_ENABLED` | `0` | Set to `1` to enable Arc Raiders session alerts |
| `BROWSER_EXTRACT_URL` | `http://crcmz-browser-extract:8091` | Internal URL for video URL extraction |

---

## PSN token refresh

NPSSO tokens expire roughly every 60 days. To refresh:

1. Log into playstation.com in a browser
2. Visit `https://ca.account.sony.com/api/v1/ssocookie`
3. Copy the `npsso` value
4. Update `NPSSO_TOKEN` in Coolify and redeploy

---

## Deployment (Coolify)

- Build: Docker (uses `Dockerfile` in repo root)
- Port: `3000`
- Health check: `GET /health`
- Volume: mount persistent storage at `/data`
- Branch: `main`

After any config change to env vars: **Restart** (not redeploy) is enough unless
`Dockerfile` or `requirements.txt` changed.

---

## Running tests

```bash
# No app deps needed — runs on host
python3 tests/test_mcp_coverage.py

# Needs app image built
python3 tests/test_mcp_oauth.py
```

`test_mcp_coverage.py` enforces the rule: every `/data/` store referenced in source
must be declared with its tool (or `None` with a reason). Build fails if a new store
is added without updating it.

---

## Stream Deck plugin

Located in `psn-slapper.sdPlugin/`. Buttons call the portal API directly.
Installed via Elgato Stream Deck software — copy the plugin folder to the plugins
directory or use the `.streamDeckPlugin` bundle.
