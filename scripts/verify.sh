#!/usr/bin/env bash
# Smoke-test the live deployment. Deploy succeeding is not the same as deploy working.
#
# Counts failures and exits nonzero on any hard failure, so it is usable as a gate.
# Reads nothing and writes nothing to the document.
#
#   scripts/verify.sh <host> [wait-seconds]

set -uo pipefail

HOST="${1:?usage: verify.sh <host> [wait-seconds]}"
BASE="https://${HOST}"
FAILURES=0

# 🔴 How long to keep re-running the whole set before believing it. **Zero by default**,
# so `make verify` locally still answers in one pass — it is a question about the state
# right now, and a command that waits before answering it is a worse command.
#
# CI passes a budget because a deploy finishes before everything around the Worker has
# caught up. The first production deploy failed on exactly this: seventeen seconds after
# "Uploaded 17 of 17 assets", `/` returned 500, one font came back as text/plain and one
# icon did too, while the other font and the other icon were already fine. Half an asset
# manifest resolving is what a rollout mid-flight looks like — and no configuration error
# produces per-file inconsistency.
#
# 🔴 The **whole set** is retried, not individual checks. A partial pass during a rollout
# says nothing, and re-running only the failures would let an early check that passed by
# luck stand while a later one is still settling.
#
# `scripts/health.sh` got this treatment first. It was not enough on its own: health asks
# the Worker one question and the Worker is the first thing to come up, while this asks
# about assets, routes and the OAuth layer, which are the last.
WAIT="${2:-0}"

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

run_all() {
  FAILURES=0
  echo "Verifying ${BASE}"

    check "/health responds"            200 "$(status "${BASE}/health")"
  check "PWA shell served"            200 "$(status "${BASE}/")"
  check "manifest served"             200 "$(status "${BASE}/manifest.json")"

  # 🔴 The manifest names its environment (#196). Prod serves the static file, `knag`;
  # anything else is rewritten by the Worker to `knag <env>`, so two installs on one
  # home screen are not twins. The environment is read from /health rather than passed
  # in, so this check cannot be told the wrong answer — and if `/manifest.json` ever
  # drops out of `run_worker_first`, dev answers `knag` and this goes red.
  #
  # `sed -n … p`, not a bare substitution: the static manifest is pretty-printed, and a
  # sed that prints every line hands back `{` as the name.
  env_name="$(curl -sS --max-time 10 "${BASE}/health" 2>/dev/null | sed -n -E 's/.*"environment":"([^"]*)".*/\1/p' | head -1)"
  if [ "$env_name" = "prod" ]; then expected_name="knag"; else expected_name="knag ${env_name}"; fi
  check "manifest names the environment" "$expected_name" \
    "$(curl -sS --max-time 10 "${BASE}/manifest.json" 2>/dev/null | sed -n -E 's/.*"name": ?"([^"]*)".*/\1/p' | head -1)"
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

  # 🔴 By *prefix*: the exact type of an .ico varies by server (`image/x-icon`,
  # `image/vnd.microsoft.icon`) and the only thing asserted is that it is not
  # `text/html` — the SPA fallback answering for a file that is not there, which is what
  # sent Claude's connector list up to the apex domain for knag's icon (#191).
  check "favicon.ico is an image" "image" "$(served_as "${BASE}/favicon.ico" | cut -d/ -f1)"

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

  return "$FAILURES"
}

# 🔴 Only the final attempt is printed. Showing every attempt would fill a CI log with
# failures that were never real, which trains exactly the habit this whole change exists
# to prevent — reading a red deploy as noise.
DEADLINE=$(( $(date +%s) + WAIT ))
ATTEMPTS=0

while :; do
  ATTEMPTS=$((ATTEMPTS + 1))
  # 2>&1 so the per-check lines stay in the order they were produced; the summary below
  # still goes to stderr.
  OUTPUT="$(run_all 2>&1)"
  RESULT=$?

  [ "$RESULT" -eq 0 ] && break
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  sleep 3
done

printf '%s\n' "$OUTPUT"

if [ "$RESULT" -gt 0 ]; then
  echo "✗ ${RESULT} check(s) failed" >&2
  [ "$WAIT" -gt 0 ] && echo "  still failing after ${WAIT}s (${ATTEMPTS} attempts)" >&2
  exit 1
fi

if [ "$ATTEMPTS" -gt 1 ]; then
  echo "✓ all checks passed, after ${ATTEMPTS} attempts"
else
  echo "✓ all checks passed"
fi