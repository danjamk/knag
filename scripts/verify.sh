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

# 🔴 Checked by **content type, never by status code.** `not_found_handling:
# "single-page-application"` answers a missing asset with the PWA shell and a **200**,
# verified against a real wrangler server:
#
#     GET /fonts/does-not-exist.woff2  →  200 text/html
#
# So a status check passes for a file that is not there, which is worse than no check.
# Same trap as the `.well-known` routes below, arriving through static assets instead
# of the router.
#
# It matters here because a face that did not upload is otherwise **completely
# silent**: `font-display: swap` renders the fallback stack, the service worker's
# `cache.addAll` rejects and takes the whole install with it, and nothing reports
# anything. The app simply comes up in system-ui and stops working offline — which
# nobody diagnoses as a deploy problem.
served_as() {
  curl -sS -o /dev/null -w '%{content_type}' --max-time 10 "$1" 2>/dev/null
}
for face in familjen-grotesk-latin-var dm-mono-latin-400 dm-mono-latin-300; do
  check "font ${face}" "font/woff2" "$(served_as "${BASE}/fonts/${face}.woff2")"
done
check "app icon served"   "image/png" "$(served_as "${BASE}/icons/knag-icon-192.png")"
check "MCP icon served"   "image/png" "$(served_as "${BASE}/icons/mcp-icon-slate-256.png")"

# 🔴 The only place any of this is observable. `not_found_handling:
# "single-page-application"` answers an unrouted path with the PWA shell and a 200, so a
# missing `run_worker_first` entry does not 404 — it serves HTML where a connector
# expects JSON, turning "no metadata here" into "metadata is corrupt". The unit suite
# cannot see it: Miniflare does not serve the assets binding, so every path reaches the
# Worker there regardless. See ADR-005 §4.
check "OAuth resource metadata"     200 "$(status "${BASE}/.well-known/oauth-protected-resource")"
check "OAuth server metadata"       200 "$(status "${BASE}/.well-known/oauth-authorization-server")"
check "unknown .well-known 404s"    404 "$(status "${BASE}/.well-known/openid-configuration")"

# A bare GET carries no authorization request, so the consent endpoint rejects it. The
# point of the check is the 400 rather than a 200: a 200 here means the SPA shell
# answered and `/oauth/*` never reached the Worker at all.
check "/oauth/authorize is live"    400 "$(status "${BASE}/oauth/authorize")"

if [ "$FAILURES" -gt 0 ]; then
  echo "✗ ${FAILURES} check(s) failed" >&2
  exit 1
fi

echo "✓ all checks passed"
