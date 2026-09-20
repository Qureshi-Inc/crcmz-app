#!/usr/bin/env python3
"""The read registry must stay read-only.

`_TOOLS` (@tool) is served to anyone holding the shared MCP_TOKEN. `_WRITE_TOOLS`
(@write_tool) is served only to a caller with a personal OAuth token, rate-limited
and audited. The line between them is the whole security model of /mcp.

It got crossed once: `clawbot_build` sat in the read registry and then grew the
ability to edit a live site in place, which meant the shared read-only token could
change a site that was serving traffic. Nothing failed, because the only existing
guard checked tool *names* for words like "send" — and "build" is not one of them.

So these checks look at what the code does, not what it is called:

  - no read tool may spawn a thread, shell out, or issue a mutating HTTP verb
  - anything that deploys, messages or deletes must be in the write registry
  - every write tool must take `caller` and be rate-limited and audited

Runs on the host — no fastapi needed, assistant.py imports cleanly:

    python3 tests/test_read_only.py
"""

import inspect
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAILED: list[str] = []
PASSED = 0


def check(name, fn):
    global PASSED
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        FAILED.append("%s: %s" % (name, e))
        print("  ✗ %s\n      %s" % (name, e))
    else:
        PASSED += 1
        print("  ✓ %s" % name)


import assistant  # noqa: E402

# web_search shells out to `lab-search` on the controller. It runs a remote command
# but returns search results and mutates nothing, and the query is shell-quoted.
# Every other read tool must be free of side-effect machinery.
SUBPROCESS_ALLOWED = {"web_search"}

SIDE_EFFECTS = [
    (r"\bsubprocess\b|\bPopen\b|os\.system", "shells out"),
    (r"\bthreading\b|\bThread\(", "spawns a thread"),
    (r"\.post\(|\.put\(|\.patch\(|\.delete\(", "issues a mutating HTTP request"),
    (r"\bINSERT\b|\bUPDATE\s|\bDELETE\s+FROM\b|\bDROP\s+TABLE\b", "writes to a database"),
    (r"open\([^)]*[\"'][wa]", "opens a file for writing"),
    (r"shutil\.|os\.remove|os\.unlink|os\.rmdir", "deletes from the filesystem"),
]

# Names that describe a side effect. A tool called any of these belongs in the write
# registry no matter what its body looks like today.
WRITE_SHAPED = re.compile(
    r"send|post|deploy|build|ship|launch|create|update|delete|remove|teardown|"
    r"write|set_|revoke|reset|kill|restart|edit",
    re.IGNORECASE)


def _body(name, registry):
    return inspect.getsource(registry[name]["fn"])


def read_tools_have_no_side_effects():
    problems = []
    for name in assistant.tool_names():
        body = _body(name, assistant._TOOLS)
        for pattern, what in SIDE_EFFECTS:
            if not re.search(pattern, body):
                continue
            if what == "shells out" and name in SUBPROCESS_ALLOWED:
                continue
            problems.append("%s %s" % (name, what))
    assert not problems, (
        "read-registry tools with side effects: %s. Move them to @write_tool() — a "
        "holder of the shared MCP_TOKEN can call anything in the read registry."
        % "; ".join(sorted(problems)))


def read_tool_names_are_not_write_shaped():
    bad = [n for n in assistant.tool_names() if WRITE_SHAPED.search(n)]
    assert not bad, ("read tools named after a side effect: %s. If the name describes "
                     "a change, the tool belongs in the write registry." % bad)


def clawbot_build_is_write_only():
    assert "clawbot_build" not in assistant.tool_names(), (
        "clawbot_build is back in the READ registry. It deploys infrastructure and "
        "edits live sites; the shared read-only token must never reach it.")
    assert "clawbot_build" in assistant.write_tool_names(), \
        "clawbot_build vanished from the write registry"


def every_write_tool_takes_a_caller():
    bad = []
    for name in assistant.write_tool_names():
        params = inspect.signature(assistant._WRITE_TOOLS[name]["fn"]).parameters
        if "caller" not in params:
            bad.append(name)
    assert not bad, ("write tools with no `caller` argument (so no identity, no rate "
                     "limit, no audit): %s" % bad)


def every_write_tool_is_rate_limited_and_audited():
    missing_limit, missing_audit = [], []
    for name in assistant.write_tool_names():
        body = _body(name, assistant._WRITE_TOOLS)
        if "within_rate_limit" not in body:
            missing_limit.append(name)
        if "audit_write" not in body:
            missing_audit.append(name)
    assert not missing_limit, "write tools with no rate limit: %s" % missing_limit
    assert not missing_audit, "write tools that do not audit: %s" % missing_audit


def write_tools_are_absent_from_the_read_specs():
    read_names = {t["function"]["name"] for t in assistant.tool_specs()}
    leaked = read_names & set(assistant.write_tool_names())
    assert not leaked, ("write tools listed in the read-only tool_specs(): %s — a "
                        "shared-token client would see and call them" % leaked)


def the_registries_do_not_overlap():
    overlap = set(assistant.tool_names()) & set(assistant.write_tool_names())
    assert not overlap, "tools registered in both registries: %s" % overlap


print("read-only contract")
check("no read tool has a side effect", read_tools_have_no_side_effects)
check("no read tool is named after a change", read_tool_names_are_not_write_shaped)
check("clawbot_build is write-only", clawbot_build_is_write_only)
check("every write tool takes a caller", every_write_tool_takes_a_caller)
check("every write tool is rate-limited and audited",
      every_write_tool_is_rate_limited_and_audited)
check("write tools never appear in the read specs",
      write_tools_are_absent_from_the_read_specs)
check("the two registries do not overlap", the_registries_do_not_overlap)

print("\n%d passed, %d failed" % (PASSED, len(FAILED)))
for f in FAILED:
    print("  - %s" % f)
sys.exit(1 if FAILED else 0)
