#!/usr/bin/env bash
# Assert that the live deployment is the code in this checkout, in the environment you
# think you are looking at.
#
# This is the target people skip, and it is the only one that catches "deployed from
# the wrong branch" — every other check passes happily against stale code.
#
#   scripts/health.sh <host> <expected-build-id> [expected-environment] [wait-seconds]
#
# 🔴 The environment argument is not decoration. `KNAG_ENV` is declared in BOTH
# wrangler env blocks and baked by the Makefile and both deploy workflows, and one
# declared in only one place reports the wrong environment in the other. Checking only
# the version cannot see that: the build id is identical either way, so the single
# failure this field exists to catch was the one thing /health was not asserting.

set -euo pipefail

HOST="${1:?usage: health.sh <host> <build-id> [environment] [wait-seconds]}"
EXPECTED="${2:?usage: health.sh <host> <build-id> [environment] [wait-seconds]}"
EXPECTED_ENV="${3:-}"

# 🔴 How long to keep asking before calling it drift. **Zero by default**, because the
# local `make health` is a question about right now — "is what is live the code I am
# standing in" — and a command that waits before answering that is a worse command.
#
# CI passes a budget, because there it is a different question. A deploy returns before
# the new Worker has finished rolling out, so the check that follows it immediately can
# read the *previous* build and call a successful deploy a failure. That happened on the
# first run it could: deploy landed 0.7.0 at 12:05:25Z, health asked nine seconds later
# and was still served 0.6.2. Nothing was wrong except the question being asked too soon.
#
# A retry here rather than a `sleep` in the workflow, so both environments get it and
# neither one pays a fixed cost on the runs that do not need it.
WAIT="${4:-0}"

field() {
  printf '%s' "$1" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).$2"
}

DEADLINE=$(( $(date +%s) + WAIT ))
ATTEMPTS=0

while :; do
  ATTEMPTS=$((ATTEMPTS + 1))
  RESPONSE="$(curl -fsS --max-time 10 "https://${HOST}/health" 2>/dev/null)" || RESPONSE=""

  if [ -n "$RESPONSE" ]; then
    LIVE="$(field "$RESPONSE" version)"
    LIVE_ENV="$(field "$RESPONSE" environment)"
    # 🔴 Only a version that has not caught up is worth waiting for. A build id that
    # matches while the environment does not is a `KNAG_ENV` declared in one wrangler
    # block and not the other — a config error that no amount of waiting fixes, and the
    # single failure this argument exists to catch.
    [ "$LIVE" = "$EXPECTED" ] && break
  else
    LIVE="unreachable"
    LIVE_ENV=""
  fi

  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  sleep 3
done

if [ "$LIVE" = "unreachable" ]; then
  echo "✗ /health unreachable at https://${HOST}" >&2
  exit 1
fi

if [ "$LIVE" != "$EXPECTED" ]; then
  echo "✗ drift: live is ${LIVE}, this checkout is ${EXPECTED}" >&2
  [ "$WAIT" -gt 0 ] && echo "  still not caught up after ${WAIT}s (${ATTEMPTS} attempts)" >&2
  exit 1
fi

if [ -n "$EXPECTED_ENV" ] && [ "$LIVE_ENV" != "$EXPECTED_ENV" ]; then
  echo "✗ WRONG ENVIRONMENT at https://${HOST}" >&2
  echo "    expected  ${EXPECTED_ENV}" >&2
  echo "    reported  ${LIVE_ENV}" >&2
  echo "" >&2
  echo "  The build id matches, so this is not stale code — it is KNAG_ENV being" >&2
  echo "  wrong or unset for this environment. Check that it is declared in BOTH" >&2
  echo "  wrangler env blocks and baked by whatever deployed this." >&2
  exit 1
fi

if [ "$ATTEMPTS" -gt 1 ]; then
  echo "✓ live matches checkout — ${LIVE} (${LIVE_ENV}), after ${ATTEMPTS} attempts"
else
  echo "✓ live matches checkout — ${LIVE} (${LIVE_ENV})"
fi
