#!/usr/bin/env bash
#
# Subset the two typefaces to woff2 and write them into public/fonts/.
#
# 🔴 This is NOT part of the build. The output is committed, and this script exists so
# the committed output is reproducible and its provenance is checkable — not so it runs
# on every deploy. Fonts change roughly never; a build step that reaches for the network
# and a Python toolchain to produce a file that did not change is a build step that will
# one day fail for no reason.
#
# Run it when the design bundle ships new source TTFs:
#
#     bash scripts/subset-fonts.sh ~/path/to/design-bundle/assets/fonts
#
# Sources arrive as TTF from the design bundle — two variable files at ~90 kB each plus
# three DM Mono statics, about 300 kB together. The shell is ~8 KiB gzipped and this is
# the largest thing knag would ever have shipped, so they are subset before they go
# anywhere near public/ (spec §14.4, the request and size budget).
#
# Needs Python. Dependencies are fetched per-run by `uv` rather than installed —
# `pyftsubset` writes woff2 only when `brotli` is importable, and it fails with a
# confusing "Unknown flavor" rather than a missing-module error when it is not.

set -euo pipefail

SRC="${1:-}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/public/fonts"

if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "usage: bash scripts/subset-fonts.sh <dir containing the source TTFs>" >&2
  exit 2
fi

command -v uv >/dev/null || { echo "uv not found — https://docs.astral.sh/uv/" >&2; exit 2; }

# The Google Fonts `latin` subset, verbatim. Anything outside it renders from the next
# family in the stack, which for a document of arbitrary user text is the honest
# trade: `latin-ext` costs roughly another 10 kB per face to cover languages this page
# has never held. Kept identical across all three faces so a fallback is never
# *partial* — one face having a glyph its sibling lacks is how a line ends up set in
# two typefaces.
UNICODES="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,\
U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF,U+FFFD"

subset() {
  local src="$1" out="$2"
  [[ -f "$src" ]] || { echo "missing source: $src" >&2; exit 1; }

  # 🔴 `--name-IDs+=13,14` is a licensing requirement, not a nicety. pyftsubset's
  # default keeps name IDs 0–6, which includes the copyright (0) but **drops the
  # license notice (13) and its URL (14)** — and OFL 1.1 §2 requires the copyright
  # notice *and* the license notice to be included in every copy. Subsetting without
  # it silently produces a redistributable that does not carry its own licence.
  # Caught by reading the subset's name table rather than the source's.
  uv run --quiet --with fonttools --with brotli -- \
    pyftsubset "$src" \
    --flavor=woff2 \
    --layout-features='*' \
    --name-IDs+=13,14 \
    --unicodes="$UNICODES" \
    --output-file="$OUT/$out"

  printf '%-40s %7s → %7s\n' "$out" \
    "$(wc -c <"$src" | tr -d ' ')" "$(wc -c <"$OUT/$out" | tr -d ' ')"
}

mkdir -p "$OUT"

echo "face                                      source   subset"
# 🔴 DM Mono Medium (500) is deliberately absent. Nothing in the app asks for it — the
# wordmark is 300 and the machine voice is 400 — and every face here is a blocking
# fetch in the service worker's precache list.
subset "$SRC/DMMono-Light.ttf" "dm-mono-latin-300.woff2"
subset "$SRC/DMMono-Regular.ttf" "dm-mono-latin-400.woff2"
# One variable file covering 400–700. The app only ever asks for 400 and 500, but the
# axis is cheaper to keep than to instance, and instancing would need a second file the
# day anything wants 600.
subset "$SRC/FamiljenGrotesk-Variable.ttf" "familjen-grotesk-latin-var.woff2"

echo
echo "wrote to public/fonts/ — add any new file to SHELL in public/sw.js"
