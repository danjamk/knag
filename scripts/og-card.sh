#!/usr/bin/env bash
#
# Render site/og.html to site/og.png (#90).
#
# 🔴 `site/og.png` is **committed output**, in the same category as `public/fonts/` — not
# a build step. GitHub Pages gets a folder, and the folder has to contain a finished PNG:
# `og:image` is fetched by a link unfurler that will not run a build, and an SVG is
# rejected outright by most of them.
#
# Regenerated only when the card's design changes. Playwright is already a dev dependency
# and already ships the browser, so this adds no tooling — it borrows the one renderer the
# repo already trusts to tell the truth about a page.
#
# 🔴 The screenshot is of the .card element, not the viewport. A viewport shot picks up a
# scrollbar on some platforms and the device pixel ratio on others, and either one changes
# the crop of the single image that represents the product everywhere it is pasted.

set -euo pipefail

cd "$(dirname "$0")/.."

SOURCE="site/og.html"
OUT="site/og.png"

if [ ! -f "$SOURCE" ]; then
  echo "✗ $SOURCE is missing" >&2
  exit 1
fi

echo "Rendering $SOURCE → $OUT"

# `waitUntil: networkidle` rather than `load`: the card sets its type in two webfonts, and
# a shot taken before they arrive is a card in the fallback stack. That failure is silent
# and it is the whole point of the image.
# 🔴 WebKit, not the CLI's chromium default. The project installs one browser — iOS
# mandates WebKit, so Safari's engine is the one that has to be right — and asking for
# chromium here fails with "executable doesn't exist" on a machine that is fully set up.
# It is also the engine whose text rendering the rest of the design was judged against.
pnpm exec playwright screenshot \
  --browser=webkit \
  --viewport-size=1200,630 \
  --wait-for-timeout=1500 \
  --full-page \
  "file://$(pwd)/${SOURCE}" \
  "$OUT" >/dev/null

echo "✓ $OUT ($(du -h "$OUT" | cut -f1))"
echo ""
echo "🔴 Commit it. The PNG is the artifact; the HTML beside it is how to change it."
