#!/usr/bin/env bash
# Fetch a production backup out of R2, onto this machine.
#
# 🔴 **This is the reason the backups are in R2 rather than anywhere else.** Exporting a
# D1 database is a POST that creates a job, so `wrangler d1 export` needs **D1: Edit** on
# the production account — and ADR-002's whole guarantee is that a token which can write
# production never lands on a laptop. Pulling an object out of a bucket needs
# **Workers R2 Storage: Read**, which can do exactly one thing: read files someone else
# already put there. So the dangerous credential stays in Actions, the nightly job writes
# to R2, and a local copy costs a credential that is safe to hold.
#
# The keys are dated rather than listed, because `wrangler r2 object` has `get`, `put` and
# `delete` and no `list` — so the date *is* the index. Ask for a day; get that day.
set -euo pipefail

DAY="${1:-$(date -u +%Y-%m-%d)}"
BUCKET="knag-backups"
KEY="prod/knag-prod-${DAY}.sql"
OUT="backups/knag-prod-${DAY}.sql"

if [ -z "${R2_READ_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
✗ R2_READ_TOKEN is not set.

  Mint a Cloudflare API token on the PRODUCTION account with exactly one permission —
  Workers R2 Storage: Read — and put it in .env.local:

      R2_READ_TOKEN=...

  🔴 Read, never Edit, and never the deploy token. The point of this path is that the
  credential on this machine cannot change anything.
MSG
  exit 1
fi

if [ -z "${CF_ACCOUNT_ID_PROD:-}" ]; then
  echo "✗ CF_ACCOUNT_ID_PROD is not set in .env — see .env.example." >&2
  exit 1
fi

mkdir -p backups

echo "Fetching ${BUCKET}/${KEY}"
# The token is passed on this command only, never exported into the shell: everything
# else in this repo that talks to Cloudflare must keep resolving dev.
if ! CLOUDFLARE_API_TOKEN="${R2_READ_TOKEN}" CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT_ID_PROD}" \
  pnpm exec wrangler r2 object get "${BUCKET}/${KEY}" --file "${OUT}" --remote; then
  echo "" >&2
  echo "✗ Could not fetch ${KEY}." >&2
  echo "  Either that day has no backup yet — the job runs 09:00 UTC — or the token is wrong." >&2
  echo "  Try another day:  make backup-pull DAY=$(date -u -v-1d +%Y-%m-%d 2>/dev/null || date -u -d yesterday +%Y-%m-%d)" >&2
  rm -f "${OUT}"
  exit 1
fi

# 🔴 An empty or truncated object is the failure this whole path exists to catch, and it
# is indistinguishable from success unless something looks. Same check the job that wrote
# it runs, for the same reason.
bytes=$(wc -c < "${OUT}" | tr -d ' ')
if [ "${bytes}" -lt 1024 ] || ! grep -q "INSERT INTO" "${OUT}"; then
  echo "✗ ${OUT} is ${bytes} bytes and has no rows — that is not a database." >&2
  exit 1
fi

echo "✓ ${OUT} (${bytes} bytes)"
echo "  Restore into a local D1 with: pnpm exec wrangler d1 execute knag-dev --local --file ${OUT}"
