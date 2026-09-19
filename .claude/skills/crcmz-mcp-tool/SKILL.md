---
name: crcmz-mcp-tool
description: Use when adding, changing, or removing any feature, table, or data store in the psn-messenger app (server.py and friends) - covers exposing it as an assistant tool and over MCP, joining it to the identity graph, and keeping secrets out. Invoke before writing the feature, not after.
---

# Adding a feature to CRCMZ without orphaning it

Every user-visible data store in this app must be reachable three ways, or the
bot cannot talk about it and the MCP clients cannot see it:

1. **The store itself** — a SQLite table under `/data/*.db`, or JSON in `/data/`.
2. **An assistant tool** — so the WhatsApp/app bot can answer questions about it.
3. **The MCP surface** — so openclaw, Claude, and anything else get the same data.

A feature that ships with only #1 is invisible. That is the failure this skill
exists to prevent.

## The rule

> New data store → new assistant tool → automatically exposed over MCP → joined
> to people through `crcmz_identity`, never through display names.

## Steps

### 1. Persist it the way the rest of the app does

Raw `sqlite3`, no ORM. One module per feature (`clips.py`, `giveaway.py`,
`facts.py` are the models). DB path `/data/<feature>.db`; call your `init()` from
the startup block in `server.py` alongside `_clips.init()` / `_wa.init()`.

**If the row belongs to a person, store the Zitadel id** (`sub`), not a display
name and not a WhatsApp JID. Existing stores that get this right:
`facts.author_sub`, `chat_history.messages.user_sub`, `giveaway_entries.member_id`,
`soundboard_personal.json` → `boards[<zitadel_id>]`.

Storing a display name is the mistake `whatsapp_messages` made — it has
`sender_name` and no user id, which is why the identity graph had to be bolted on
afterwards via Zitadel tags.

### 2. Register an assistant tool

In `assistant.py`, use the existing decorator — registration is all it takes:

```python
@tool("my_feature_stats",
      "One or two sentences the model reads to decide whether to call this. "
      "Say what the numbers mean and name any gotcha.",
      _range_param({"limit": {"type": "integer", "description": "1-50, default 20."}}))
def _my_feature_stats(range: str = "all_time", limit: int = 20) -> dict:  # noqa: A002
    return my_feature.stats(range, limit=max(1, min(int(limit or 20), 50)))
```

`_TOOLS` feeds `tool_specs()` and `call_tool()`, so the decorator is the only
wiring needed. Clamp every numeric argument — the model will pass 10000.

Write the description for a model, not a human: it is the entire basis for tool
selection. Mention what a `0` means if a `0` is ambiguous (see the
`whatsapp_stats` description and its `<Media omitted>` caveat).

### 3. Join it to people through the identity graph

Never match humans by display name. Use `crcmz_identity`:

```python
import crcmz_identity

person = crcmz_identity.resolve(whoever)        # any identifier -> person
person = crcmz_identity.identify_jid(sender_jid) # WhatsApp JID -> person
```

The graph comes from Zitadel user metadata tags (`mm_username`, `psn_id`,
`wa_jid`, `wa_phone`), which is the only place the four identities are tied
together. Join keys:

| Store | Column | Joins via |
|---|---|---|
| `whatsapp_messages` | `sender_jid` | `tags.wa_jid` |
| `clips` | `sender_online_id` | `tags.psn_id` |
| soundboard personal | `boards[<key>]` | `zitadel_id` |
| `giveaway_entries` | `member_id` | `zitadel_id` |
| `facts` | `author_sub` | `zitadel_id` |

**If you add a person-shaped tag, add it in the Zitadel console and to
`TAG_KEYS`** in `crcmz_identity.py`. Unknown tags still surface under
`Person["tags"]`, they just get no dedicated field.

### 4. Keep credentials out — allowlist, never denylist

`/data/users/*.json` holds live `npsso`, `access_token`, and `refresh_token`
values next to the harmless fields. Build every projection from an explicit list
of fields to include (see `portal.list_users()` and `portal.list_unclaimed()`),
and reuse those helpers rather than reading the raw file. A denylist leaks
whatever field is added next.

Also remember the middleware only enforces sessions when the `Host` header
matches `PORTAL_PUBLIC_HOST` — a request via LAN/tailnet IP bypasses auth. Any
new endpoint holding private data needs its own check, not just the global gate.

### 5. Test it

Add tests under `tests/` next to `test_assistant.py`, `test_whatsapp.py`. At
minimum: the tool is registered, it clamps its arguments, and it returns no
credential fields.

**This repo does not use pytest.** Tests are standalone scripts with plain
asserts and a local `check(name, fn)` harness that prints ✓/✗ and exits non-zero
on failure — copy the top of `tests/test_identity.py` or `tests/test_facts.py`.
Stub external HTTP with a local `HTTPServer` rather than mocking the client, so
the real `httpx` path is exercised. Run one file directly:

```bash
python3 tests/test_identity.py
```

## Checklist before you call it done

- [ ] Store initialised from `server.py` startup
- [ ] Person rows keyed by Zitadel id, not a name
- [ ] `@tool(...)` registered in `assistant.py`, description written for a model
- [ ] Numeric args clamped
- [ ] Any person lookup goes through `crcmz_identity`
- [ ] Projections use an allowlist; no `npsso`/`access_token`/`refresh_token` can escape
- [ ] New endpoints carry their own auth check
- [ ] Tests added as a plain-assert script (no pytest), and it exits 0

## Anti-patterns seen in this repo

- **Storing display names as identity** — `whatsapp_messages.sender_name`. Cost:
  a whole identity graph had to be retrofitted.
- **Ephemeral state written to `./data/`** instead of `/data/` — `wa_ai.py` writes
  `sent_ids.json` and `member_jids.json` next to the source, so they vanish on
  every redeploy. Use `/data/` for anything that should survive.
- **`urllib` against `auth.crcmz.me`** — Cloudflare answers its User-Agent with a
  1010 "banned browser signature". Use `httpx`, like the rest of the app.
- **Read paths with no in-handler auth** — `/portal/users` returns
  `zitadel_user_id` for every caller. Do not copy that pattern.
