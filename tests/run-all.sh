#!/usr/bin/env bash
# Run the whole Python test suite in an isolated container.
#
# Why a container: every module hardcodes its store under /data (see the data
# store table in README.md) and /data on the host is root-owned Coolify state.
# The suite's http_tests() boot the real app, which opens those databases, so on
# the host they all die with "unable to open database file". Running inside the
# app image with a tmpfs at /data gives the tests a writable, throwaway /data
# and the exact dependency versions the production image has.
#
#   tests/run-all.sh              # everything
#   tests/run-all.sh test_watch   # one file (with or without .py)
#
# --network none keeps a test run from ever reaching real PSN/WhatsApp/Zitadel.
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=crcmz-app:test
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building $IMAGE ..."
  docker build -q -t "$IMAGE" . >/dev/null || exit 1
fi

if [ $# -gt 0 ]; then
  files=()
  for a in "$@"; do files+=("tests/${a%.py}.py"); done
else
  mapfile -t files < <(ls tests/test_*.py)
fi

fail=0
for f in "${files[@]}"; do
  echo "──────── $(basename "$f")"
  timeout 300 docker run --rm -v "$PWD:/src" -w /src --tmpfs /data:rw \
    --network none "$IMAGE" python3 "$f" 2>&1 | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2} .* INFO ' | tail -40
  rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || { fail=$((fail + 1)); echo "  ✗✗ $(basename "$f") exited $rc"; }
done

echo
if [ "$fail" -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "$fail suite(s) FAILED"; fi
exit $((fail > 0))
