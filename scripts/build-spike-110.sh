#!/usr/bin/env bash
# Build the CodeMirror 6 probe into ONE standalone HTML file, and measure what it costs.
#
# Standalone on purpose: the whole point is opening it on a phone without a dev server,
# a tunnel, or a deploy. Everything is inlined.
#
#   bash scripts/build-spike-110.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPIKE="${ROOT}/docs/spikes"
OUT="${SPIKE}/110-codemirror-probe.html"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

cd "${ROOT}"

echo "── typecheck ──────────────────────────────────────────────"
pnpm exec tsc --noEmit -p "${SPIKE}/tsconfig.json"
echo "  ok"

echo
echo "── bundle ─────────────────────────────────────────────────"
# 🔴 IIFE, not ESM. A `<script type="module">` does not execute from a `file://`
# origin, which is exactly how this gets opened on a phone — the page rendered its
# static markup and nothing else, and looked like a CSS bug. A classic script runs.
pnpm exec esbuild "${SPIKE}/110-codemirror-probe.ts" \
  --bundle --minify --format=iife --target=es2022 \
  --outfile="${TMP}/probe.js" \
  --log-level=warning

# 🔴 The measurement that decides, and it is NOT the size of this file. The probe
# carries CodeMirror plus the probe's own reporting UI. What a real integration would
# add to `public/app.js` is CodeMirror alone, which is what the second number is.
pnpm exec esbuild "${SPIKE}/cm-only.ts" \
  --bundle --minify --format=esm --target=es2022 \
  --outfile="${TMP}/cm-only.js" \
  --log-level=warning

size() { wc -c <"$1" | tr -d ' '; }
gz() { gzip -9 -c "$1" | wc -c | tr -d ' '; }

APP="${ROOT}/public/app.js"
[ -f "${APP}" ] || pnpm build >/dev/null

printf '  %-34s %8s %8s\n' "" "min" "gzip"
printf '  %-34s %8s %8s\n' "public/app.js (today)" "$(size "${APP}")" "$(gz "${APP}")"
printf '  %-34s %8s %8s\n' "CodeMirror only (the real cost)" "$(size "${TMP}/cm-only.js")" "$(gz "${TMP}/cm-only.js")"
printf '  %-34s %8s %8s\n' "probe bundle (incl. probe UI)" "$(size "${TMP}/probe.js")" "$(gz "${TMP}/probe.js")"

echo
echo "── inline ─────────────────────────────────────────────────"
# Substitute via a file read rather than a sed replacement: the bundle contains every
# character sed treats as special, and a `&` alone would corrupt it silently.
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const shell = readFileSync('${SPIKE}/110-codemirror-probe.template.html', 'utf8');
const bundle = readFileSync('${TMP}/probe.js', 'utf8');
const marker = '/*BUNDLE*/';
if (!shell.includes(marker)) { console.error('marker missing'); process.exit(1); }
if (bundle.includes('</script')) { console.error('bundle would close the script tag'); process.exit(1); }
writeFileSync('${OUT}', shell.replace(marker, bundle));
"
printf '  %s  %s bytes\n' "docs/spikes/110-codemirror-probe.html" "$(size "${OUT}")"
echo
echo "Desktop:  open docs/spikes/110-codemirror-probe.html"
echo "Phone:    bash scripts/serve-spike.sh   (AirDrop does NOT work - see that script)"
