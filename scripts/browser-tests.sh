#!/usr/bin/env bash
# Run the Playwright suite one spec file at a time, each against its own dev server.
#
# 🔴 This is a workaround for a `wrangler dev` defect, and it is deliberate rather than
# stylistic. Do not collapse it back into a single `playwright test`.
#
# The failure it avoids: wrangler proxies every request through a worker of its own, and
# after enough traffic that proxy raises `Network connection lost`, which wrangler treats
# as **fatal** and exits on. Playwright starts one `webServer` for the whole run and never
# restarts it, so the process dies mid-suite and every remaining test fails at
# `page.goto` with "Could not connect" — which reads as a dozen broken tests rather than
# one dead server, and sent a PR that touched only shell scripts to a red CI.
#
# Measured over five runs each, on a clean tree (#69):
#
#   one server, 20 tests   4/5 runs failed
#   one server per file    0/10 runs failed
#
# It always died inside the longest-running spec and never in the first one, and the
# specs pass individually — so the trigger is cumulative traffic against one server, not
# any single test. Two other hypotheses were tested and rejected: a fixture teardown that
# waits for the network to go quiet (no effect), and pinning wrangler back to the last
# release with a stable rather than alpha miniflare (no effect).
#
# 🔴 What this does NOT do is hide a failure. Every test still runs exactly once, and a
# real failure still fails the build. That is the difference between this and setting
# `retries`, which was the obvious fix and the wrong one — the browser suite is the only
# place several of knag's guarantees are checked at all, and a retried suite would have
# swallowed #62.
#
# The unit of splitting is the spec file, which is a proxy for "not too many tests
# against one server". If a single spec file ever grows past roughly fifteen tests,
# expect this to start flaking again and split that file rather than raising a timeout.

set -uo pipefail

cd "$(dirname "$0")/.."

FAILED=()
PASSED=0

shopt -s nullglob
SPECS=(browser/*.spec.ts)
shopt -u nullglob

if [ ${#SPECS[@]} -eq 0 ]; then
  echo "✗ No spec files found in browser/" >&2
  exit 1
fi

echo "Running ${#SPECS[@]} spec file(s), each against its own dev server."
echo ""

for spec in "${SPECS[@]}"; do
  echo "── ${spec}"
  if pnpm exec playwright test "$spec" "$@"; then
    PASSED=$((PASSED + 1))
  else
    FAILED+=("$spec")
  fi
  echo ""
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ ${#FAILED[@]} spec file(s) failed:" >&2
  printf '    %s\n' "${FAILED[@]}" >&2
  exit 1
fi

echo "✓ ${PASSED} spec file(s) passed"
