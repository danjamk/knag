#!/usr/bin/env bash
# Smoke-test the live deployment. Deploy succeeding is not the same as deploy working.
#
# Counts failures and exits nonzero on any hard failure, so it is usable as a gate.
# Reads nothing and writes nothing to the document.
#
#   scripts/verify.sh <host>

set -uo pipefail

HOST="${1:?usage: verify.sh <host>}"
BASE="https://${HOST}"
FAILURES=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ ${label}"
  else
    echo "  ✗ ${label} — expected ${expected}, got ${actual}" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

status() { curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || echo "000"; }

echo "Verifying ${BASE}"

check "/health responds"            200 "$(status "${BASE}/health")"
check "PWA shell served"            200 "$(status "${BASE}/")"
check "manifest served"             200 "$(status "${BASE}/manifest.json")"
check "/api/doc rejects anonymous"  401 "$(status "${BASE}/api/doc")"
check "/mcp rejects anonymous"      401 "$(status "${BASE}/mcp")"

if [ "$FAILURES" -gt 0 ]; then
  echo "✗ ${FAILURES} check(s) failed" >&2
  exit 1
fi

echo "✓ all checks passed"
