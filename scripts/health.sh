#!/usr/bin/env bash
# Assert that the live deployment is the code in this checkout, in the environment you
# think you are looking at.
#
# This is the target people skip, and it is the only one that catches "deployed from
# the wrong branch" — every other check passes happily against stale code.
#
#   scripts/health.sh <host> <expected-build-id> [expected-environment]
#
# 🔴 The environment argument is not decoration. `KNAG_ENV` is declared in BOTH
# wrangler env blocks and baked by both the Makefile and deploy-prod.yml, and one
# declared in only one place reports the wrong environment in the other. Checking only
# the version cannot see that: the build id is identical either way, so the single
# failure this field exists to catch was the one thing /health was not asserting.

set -euo pipefail

HOST="${1:?usage: health.sh <host> <build-id> [environment]}"
EXPECTED="${2:?usage: health.sh <host> <build-id> [environment]}"
EXPECTED_ENV="${3:-}"

RESPONSE="$(curl -fsS --max-time 10 "https://${HOST}/health")" || {
  echo "✗ /health unreachable at https://${HOST}" >&2
  exit 1
}

field() {
  printf '%s' "$RESPONSE" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).$1"
}

LIVE="$(field version)"
LIVE_ENV="$(field environment)"

if [ "$LIVE" != "$EXPECTED" ]; then
  echo "✗ drift: live is ${LIVE}, this checkout is ${EXPECTED}" >&2
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

echo "✓ live matches checkout — ${LIVE} (${LIVE_ENV})"
