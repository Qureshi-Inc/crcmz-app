#!/usr/bin/env bash
# Boot a throwaway instance of the app and drive it with a real browser.
#
#   tests/browser/run.sh                     # legacy dashboard checks
#   tests/browser/run.sh app.spec.mjs        # one spec
#
# The instance gets a tmpfs /data (no real squad data, no private chat contents) and
# a port picked from the ephemeral range, so it can never be confused with the
# deployed container on 3021 or collide with the other services on this box.
#
# The dashboard is served with the auth gate bypassed, because the request arrives
# from the Docker bridge (a private address) with a Host of 127.0.0.1 — the same path
# the Stream Deck plugin uses. That is deliberate: it is how these checks reach the
# signed-out dashboard without a Zitadel round trip.
set -uo pipefail
cd "$(dirname "$0")/../.."

# Let the kernel hand us an unused port rather than guessing one. 3099 looked free
# and belongs to psn-montage.
PORT=${CRCMZ_TEST_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')}
IMAGE=crcmz-app:test
NAME=crcmz-browsertest-$$

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" . >/dev/null

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" \
  -p "127.0.0.1:$PORT:3000" --tmpfs /data:rw \
  -e SESSION_SECRET=browser-test-secret \
  -e NPSSO_TOKEN=test-npsso -e GROUP_ID=test-group \
  -e PORTAL_PUBLIC_HOST=app.crcmz.me \
  -e PSN_AI_ENABLED=0 -e WA_AI_ENABLED=0 -e ARC_ALERT_ENABLED=0 \
  "$IMAGE" >/dev/null || exit 1

printf 'waiting for the app'
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo " — up"; break
  fi
  printf '.'; sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null || {
  echo " — never became healthy"; docker logs "$NAME" 2>&1 | tail -30; exit 1; }

specs=("${@:-dashboard.spec.mjs}")
fail=0
for s in "${specs[@]}"; do
  CRCMZ_BASE="http://127.0.0.1:$PORT" node "tests/browser/$s" || fail=$((fail + 1))
done
exit $((fail > 0))
