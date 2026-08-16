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

# 🔴 No `-f`. It makes curl exit 22 on any 4xx/5xx, and the `|| echo "000"` that used
# to guard this appended to the code `-w` had already printed — so every check for a
# non-2xx returned "401000" and could never match. That silently disabled the two
# checks here that assert authentication is on at all.
#
# Without `-f`, curl exits 0 for any HTTP response and prints just the code; a real
# connection failure exits nonzero with `%{http_code}` as "000", which is the value
# this wants anyway.
status() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null)
  echo "${code:-000}"
}

echo "Verifying ${BASE}"

check "/health responds"            200 "$(status "${BASE}/health")"
check "PWA shell served"            200 "$(status "${BASE}/")"
check "manifest served"             200 "$(status "${BASE}/manifest.json")"
check "/api/doc rejects anonymous"  401 "$(status "${BASE}/api/doc")"
check "/mcp rejects anonymous"      401 "$(status "${BASE}/mcp")"

# 🔴 The only place this is observable. `not_found_handling: "single-page-application"`
# answers an unrouted path with the PWA shell and a 200, so a missing `run_worker_first`
# entry turns "knag serves no OAuth metadata" into "knag's OAuth metadata is corrupt".
# The unit suite cannot see it: Miniflare does not serve the assets binding, so every
# path reaches the Worker there regardless. See ADR-005 §4.
check "/.well-known/ not shell"     404 "$(status "${BASE}/.well-known/oauth-protected-resource")"
check "/.well-known/ deep not shell" 404 "$(status "${BASE}/.well-known/oauth-authorization-server/mcp")"

if [ "$FAILURES" -gt 0 ]; then
  echo "✗ ${FAILURES} check(s) failed" >&2
  exit 1
fi

echo "✓ all checks passed"
