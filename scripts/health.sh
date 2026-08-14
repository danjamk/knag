#!/usr/bin/env bash
# Assert that the live deployment is the code in this checkout.
#
# This is the target people skip, and it is the only one that catches "deployed from
# the wrong branch" — every other check passes happily against stale code.
#
#   scripts/health.sh <host> <expected-build-id>

set -euo pipefail

HOST="${1:?usage: health.sh <host> <build-id>}"
EXPECTED="${2:?usage: health.sh <host> <build-id>}"

RESPONSE="$(curl -fsS --max-time 10 "https://${HOST}/health")" || {
  echo "✗ /health unreachable at https://${HOST}" >&2
  exit 1
}

LIVE="$(printf '%s' "$RESPONSE" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"

if [ "$LIVE" = "$EXPECTED" ]; then
  echo "✓ live matches checkout — ${LIVE}"
else
  echo "✗ drift: live is ${LIVE}, this checkout is ${EXPECTED}" >&2
  exit 1
fi
