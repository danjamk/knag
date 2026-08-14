#!/usr/bin/env bash
# Dump a D1 database to a timestamped file in backups/ (gitignored).
#
# This matters more here than in most projects: D1 holds the only copy of the live
# document, there is no second source of truth, and Time Travel only reaches back 30
# days — and restores a database rather than telling you the document was wrong three
# deploys ago.
#
#   scripts/backup.sh <env> <d1-name>

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_NAME="${1:?usage: backup.sh <env> <d1-name>}"
D1_NAME="${2:?usage: backup.sh <env> <d1-name>}"

# The top level of wrangler.jsonc is dev, so dev passes no --env.
ENV_FLAG=()
[ "$ENV_NAME" != "dev" ] && ENV_FLAG=(--env "$ENV_NAME")

OUT_DIR="backups"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="${OUT_DIR}/knag-${ENV_NAME}-${STAMP}.sql"

mkdir -p "$OUT_DIR"

pnpm exec wrangler --config worker/wrangler.jsonc "${ENV_FLAG[@]}" \
  d1 export "$D1_NAME" --remote --output "$OUT"

echo "✓ ${OUT} ($(wc -c < "$OUT" | tr -d ' ') bytes)"
