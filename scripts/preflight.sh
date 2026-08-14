#!/usr/bin/env bash
# Assert the active Cloudflare credential points at the account this checkout expects.
#
# 🔴 Why this exists. ADR-002 says which account you reach is decided by which
# credential is active. That is true of CLOUDFLARE_API_TOKEN — and it is NOT the
# whole story, because wrangler also accepts a machine-global OAuth login from
# `wrangler login`, stored outside the project entirely:
#
#   ~/Library/Preferences/.wrangler/config/default.toml
#
# Nothing in this repo controls that file. A developer who ran `wrangler login`
# against the wrong account months ago has a laptop that will happily deploy there,
# and the safe-looking ENV=dev default provides no protection at all — the default
# picks the *config block*, not the *account*.
#
# So the guarantee has to be asserted rather than assumed. Set the expected account
# id per environment in .env, and this fails closed when they disagree.
#
#   scripts/preflight.sh <env> [expected-account-id]

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_NAME="${1:?usage: preflight.sh <env> [expected-account-id]}"
EXPECTED="${2:-}"

if [ -z "$EXPECTED" ]; then
  echo "⚠ No expected account id for '${ENV_NAME}'."
  echo "  Set CF_ACCOUNT_ID_$(printf '%s' "$ENV_NAME" | tr '[:lower:]' '[:upper:]') in .env — see .env.example."
  echo "  Refusing to guess which account this would reach."
  exit 1
fi

WHOAMI="$(pnpm exec wrangler whoami 2>&1)" || {
  echo "✗ Not authenticated to Cloudflare." >&2
  echo "  Put CLOUDFLARE_API_TOKEN in .env.local, or run: pnpm exec wrangler login" >&2
  exit 1
}

# whoami prints the id inside a table; pull the first 32-char hex token out of it.
ACTIVE="$(printf '%s' "$WHOAMI" | grep -oE '[0-9a-f]{32}' | head -1)"

if [ -z "$ACTIVE" ]; then
  echo "✗ Could not read an account id from 'wrangler whoami'." >&2
  echo "  Run it yourself and check the output shape before deploying." >&2
  exit 1
fi

if [ "$ACTIVE" != "$EXPECTED" ]; then
  echo "✗ WRONG CLOUDFLARE ACCOUNT for ENV=${ENV_NAME}" >&2
  echo "    expected  ${EXPECTED}" >&2
  echo "    active    ${ACTIVE}" >&2
  echo "" >&2
  echo "  The active credential is not the one this environment expects. Check" >&2
  echo "  .env.local, or whether a stale 'wrangler login' is being picked up:" >&2
  echo "    pnpm exec wrangler whoami" >&2
  echo "    pnpm exec wrangler logout" >&2
  exit 1
fi

echo "✓ Cloudflare account ${ACTIVE} matches ENV=${ENV_NAME}"
