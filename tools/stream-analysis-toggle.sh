#!/bin/bash
# Stream analysis ON/OFF for a Redragon Stream Deck key (or any launcher).
#
#   stream-analysis-toggle.sh           flip it, print ON/OFF, show a notification
#   stream-analysis-toggle.sh on|off    set it
#   stream-analysis-toggle.sh status    print ON/OFF without changing anything
#
# Token: ~/.crcmz/stream-token (chmod 600), one line. Either a personal token from
# app.crcmz.me Settings -> MCP (crcmz_...), or a scoped service token.
# CRCMZ_STREAM_PERSON: your PSN id. Needed for `status`, and for every mode with a
# service token (a service token isn't a person, so it must say whose stream it is).
set -euo pipefail

URL="${CRCMZ_MCP_URL:-https://app.crcmz.me/mcp}"
TOKEN_FILE="${CRCMZ_STREAM_TOKEN_FILE:-$HOME/.crcmz/stream-token}"
PERSON="${CRCMZ_STREAM_PERSON:-}"
MODE="${1:-toggle}"

[ -r "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE" >&2; exit 2; }
[ "$MODE" != status ] || [ -n "$PERSON" ] || { echo "status needs CRCMZ_STREAM_PERSON" >&2; exit 2; }

case "$MODE" in
  toggle) TOOL=stream_analysis_toggle; ARGS='{}' ;;
  on)     TOOL=stream_analysis_toggle; ARGS='{"enabled":true}' ;;
  off)    TOOL=stream_analysis_toggle; ARGS='{"enabled":false}' ;;
  status) TOOL=stream_analysis_status; ARGS='{}' ;;
  *) echo "usage: $0 [toggle|on|off|status]" >&2; exit 2 ;;
esac

BODY=$(/usr/bin/python3 -c '
import json, sys
tool, args, person = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
if person:
    args["person"] = person
print(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": tool, "arguments": args}}))' "$TOOL" "$ARGS" "$PERSON")

# The token goes to curl as a header file on stdin, so it never lands in argv or the shell log.
REPLY=$(printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$TOKEN_FILE")" |
  curl -sS --max-time 10 -H @- -H 'Content-Type: application/json' -d "$BODY" "$URL")

STATE=$(printf '%s' "$REPLY" | /usr/bin/python3 -c '
import json, sys
try:
    res = json.load(sys.stdin)["result"]
    data = json.loads(res["content"][0]["text"])
except Exception:
    print("ERROR"); sys.exit()
if res.get("isError") or data.get("error"):
    print("ERROR " + str(data.get("error", "") if isinstance(data, dict) else data)); sys.exit()
print("ON" if data.get("enabled") else "OFF")')

echo "$STATE"
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"Stream analysis: $STATE\" with title \"CRCMZ\"" >/dev/null 2>&1 || true
fi
case "$STATE" in ERROR*) exit 1 ;; esac
