#!/usr/bin/env bash
# Serve the spike probe over the LAN so a phone can open it in a real browser.
#
# 🔴 This exists because AirDropping the file did not work. It lands in the Files app,
# which previews HTML rather than running it, so the page renders its static markup and
# no script executes at all — which looks like a broken layout rather than a dead probe.
# A real http:// origin in Safari removes every one of those problems at once.
#
#   bash scripts/serve-spike.sh [port]
#
# Ctrl-C to stop. Mac and phone must be on the same Wi-Fi.

set -euo pipefail

PORT="${1:-8110}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${ROOT}/docs/spikes"
FILE="110-codemirror-probe.html"

[ -f "${DIR}/${FILE}" ] || { echo "Not built. Run: bash scripts/build-spike-110.sh" >&2; exit 1; }

# The address the phone needs, not 127.0.0.1. Falls back across the interfaces a Mac
# actually uses — en0 is Wi-Fi, en1 is Wi-Fi on some models and Ethernet on others.
IP=""
for iface in en0 en1 en2; do
  IP="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
  [ -n "${IP}" ] && break
done

if [ -z "${IP}" ]; then
  echo "Could not find a LAN address. Are you on Wi-Fi?" >&2
  IP="<this-mac's-ip>"
fi

echo
echo "  On the iPhone, in Safari:"
echo
echo "      http://${IP}:${PORT}/${FILE}"
echo
echo "  Same Wi-Fi as this Mac. Ctrl-C here when you are done."
echo

exec python3 -m http.server "${PORT}" --bind 0.0.0.0 --directory "${DIR}"
