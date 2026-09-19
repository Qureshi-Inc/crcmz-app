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

### 0. Add every new .py file to the Dockerfile

`Dockerfile` has **one `COPY` line listing every source file by name** — there is
no `COPY . .`. A new module that is not on that line does not exist in the image,
and the failure is silent until something imports it in production:

```dockerfile
COPY server.py psn_auth.py ... crcmz_identity.py soundboard.py mcp_server.py favicon.png ... ./
```

Easiest step to forget, most expensive to debug. Do it first — `crcmz_identity.py`
sat committed for two commits while missing from that line.

### 1. Persist it the way the rest of the app does

Raw `sqlite3`, no ORM. One module per feature (`clips.py`, `giveaway.py`,
`facts.py` are the models). DB path `/data/<feature>.db`; call your `init()` from
the startup block in `server.py` alongside `_clips.init()` / `_wa.init()`.

**Do not leave the store inline in `server.py`.** `server.py` imports `assistant`,
so `assistant` cannot import `server` back — a store defined in `server.py` is
unreachable from every tool. The soundboard had to be extracted into
`soundboard.py` for exactly this reason. If `server.py` needs the old names, alias
them (`_load_custom_buttons = _sb.load_custom`) and let the module own the paths —
then fix any test that patched `server._SOMETHING`, or it will silently start
writing to the real `/data`.

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

**MCP needs no further work.** `mcp_server.py` serves `assistant.tool_specs()`
directly, so the `@tool(...)` above is simultaneously the bot tool and the MCP
tool. There is no list to add to and nothing to keep in sync — `test_mcp.py`
asserts the two counts are equal so a second registry cannot creep in.

Two conventions the registry relies on:

* **Read-only names.** `test_assistant.py` and `test_facts.py` reject any tool
  whose name contains `send`, `post`, `delete`, `write`, `create`, `set_`,
  `update`, etc. MCP clients get whatever is registered, so a write tool here is
  a write tool exposed to anything holding the bearer token.
* **Never assert an exact tool count** in a test. Those assertions were pinned at
  `== 17` and silently failed for two features' worth of work. Compare against
  `len(assistant.tool_names())` or check that specific names are present.

### 3. Join it to people through the identity graph

Never match humans by display name. Use `crcmz_identity`:

```python
import crcmz_identity

person = crcmz_identity.resolve(whoever)          # any identifier -> person
person = crcmz_identity.identify_jid(sender_jid)  # WhatsApp JID -> person
person = crcmz_identity.attribute_message(        # a whatsapp_messages row
    row["sender_name"], from_me=row["from_me"], sender_jid=row["sender_jid"])
```

The graph comes from Zitadel user metadata tags (`mm_username`, `psn_id`,
`wa_jid`, `wa_phone`, `wa_names`), which is the only place the four identities
are tied together. Join keys:

| Store | Column | Joins via |
|---|---|---|
| `whatsapp_messages` | `sender_name` | `tags.wa_names` |
| `clips` | `sender_online_id` | `tags.psn_id` |
| soundboard personal | `boards[<key>]` | `zitadel_id` |
| `giveaway_entries` | `member_id` | `zitadel_id` |
| `facts` | `author_sub` | `zitadel_id` |

**WhatsApp joins on the name, not the JID** — the obvious-looking
`sender_jid == tags.wa_jid` does not work and wasted a redesign: 89% of rows come
from a `.txt` export that has no JID at all, and every live row's `sender_jid` is
WhatsApp's `@lid` privacy id, which is not derivable from a phone number. Hence
the `wa_names` tag (comma-separated, because people post under several names).
`attribute_message` handles the rest: `from_me` rows are the bot (they arrive with
the *group's* JID in the sender column), and an unknown sender returns `None`
rather than a guess. Feed distinct sender names to `unmapped_wa_names()` to see
which `wa_names` tags are still missing.

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
`/mcp` is the worked example: it is in `_OPEN_PATHS` (bearer token, no cookie), so
`mcp_server.authorised()` runs on every request, compares with
`hmac.compare_digest`, and refuses everything when `MCP_TOKEN` is unset. Fail
closed — the alternative default was an open read of 10k private messages.

### 5. Test it

Add tests under `tests/` next to `test_assistant.py`, `test_whatsapp.py`. At
minimum: the tool is registered, it clamps its arguments, and it returns no
credential fields.

**`tests/test_mcp_coverage.py` will fail the moment you add a store**, which is
how this convention is enforced rather than merely documented. It scrapes every
`/data/...` literal out of the source and requires an entry in its `STORES` map
naming the tool that exposes it. Either name the tool, or map the store to `None`
with the reason it should stay private — a decision, not an omission. It also
checks that MCP and the assistant registry hold exactly the same tool names.

**This repo does not use pytest.** Tests are standalone scripts with plain
asserts and a local `check(name, fn)` harness that prints ✓/✗ and exits non-zero
on failure — copy the top of `tests/test_identity.py` or `tests/test_facts.py`.
Stub external HTTP with a local `HTTPServer` rather than mocking the client, so
the real `httpx` path is exercised.

**Anything that imports `server` must run in the image** — `itsdangerous`,
`fastapi` and friends are not installed on the host, so `python3 tests/x.py`
fails with `ModuleNotFoundError` for reasons that have nothing to do with the
test. Pure-module tests do run on the host.

```bash
docker build -t psn-messenger:test .
docker run --rm -e SESSION_SECRET=test-secret \
  -v "$PWD/tests:/app/tests" psn-messenger:test python tests/test_identity.py
```

Ten tests in `test_assistant.py` and `test_wa_ai.py` fail at `main` for unrelated
reasons (persona text, wa_ai trigger matching). Get a baseline before blaming your
change — `git archive HEAD | tar -x -C /tmp/base-tree` and build there, because
`git stash push` aborts if you name an untracked file.

## Checklist before you call it done

- [ ] **Every new `.py` added to the `COPY` line in `Dockerfile`**
- [ ] Store lives in its own module, not inline in `server.py`
- [ ] Store initialised from `server.py` startup
- [ ] Person rows keyed by Zitadel id, not a name
- [ ] `@tool(...)` registered in `assistant.py`, description written for a model
- [ ] Tool name contains no write verb (`send`/`post`/`delete`/`set_`/…)
- [ ] Numeric args clamped
- [ ] Any person lookup goes through `crcmz_identity`
- [ ] Projections use an allowlist; no `npsso`/`access_token`/`refresh_token` can escape
- [ ] New endpoints carry their own auth check
- [ ] Tests added as a plain-assert script (no pytest), run in the image, exits 0
- [ ] No test asserts an exact tool count

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
- **A store defined inside `server.py`** — invisible to every tool, because
  `assistant` cannot import `server` back. Cost: the soundboard extraction.
- **A new module missing from the `Dockerfile` COPY line** — imports fine locally,
  `ModuleNotFoundError` in production.
- **Tests pinned to an exact tool count** — `== 17` failed silently across two
  features. Compare to `len(assistant.tool_names())` instead.
