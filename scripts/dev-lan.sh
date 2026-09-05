#!/usr/bin/env bash
# Serve knag over the LAN, on HTTPS, against the LOCAL database — so the phone can use it
# without deploying anything and without touching the real dev page.
#
#   bash scripts/dev-lan.sh [port]
#
# 🔴 HTTPS is not optional here, and plain `--ip 0.0.0.0` will not do. The session cookie
# carries `Secure` for every hostname except `localhost` and `127.0.0.1`
# (worker/src/auth.ts, `isSecureContext`) — so over http:// on a LAN address Safari
# refuses to store it, login appears to succeed, and the page bounces straight back to the
# login form with nothing in the console to say why.
#
# The certificate is self-signed, so iOS shows a warning the first time. Tap through it.
#
# 🔴 Local D1, deliberately. `.wrangler/state` holds test content, not the real page. A
# new editing surface should meet a document nobody minds losing before it meets the only
# copy of one that matters.
#
# 🔴 **The macOS firewall will very likely block this, silently.** wrangler binds
# `*:PORT` and reports the LAN address, loopback answers 200, and the phone times out
# with nothing anywhere saying why — because incoming connections to `workerd` are
# refused and the usual "allow incoming connections?" dialog does not appear for a binary
# launched from a terminal. The check below says so up front rather than letting you
# discover it on the phone.
#
# If the firewall is in the way and you would rather not touch it, `make deploy ENV=dev`
# is the other route: real HTTPS, real host, and the installed PWA — which is what this
# script cannot give you, since a self-signed certificate cannot be added to the home
# screen. That is the better test; this one is the one that touches nothing.

set -euo pipefail

PORT="${1:-8788}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# The operator's address for this session only (#231). Not a secret and not written
# anywhere — the real one lives in a Worker secret and never comes near a local run. No
# mail is sent locally: the login code is printed in this terminal by wrangler dev.
OPERATOR_EMAIL="${KNAG_LAN_EMAIL:-you@example.com}"

IP=""
for iface in en0 en1 en2; do
  IP="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
  [ -n "${IP}" ] && break
done
[ -n "${IP}" ] || { echo "No LAN address found. Are you on Wi-Fi?" >&2; exit 1; }

# ── Will the phone actually be able to reach this? ───────────────────────────
WORKERD="$(ls node_modules/.pnpm/@cloudflare+workerd-darwin-*/node_modules/@cloudflare/workerd-darwin-*/bin/workerd 2>/dev/null | head -1 || true)"
FW="/usr/libexec/ApplicationFirewall/socketfilterfw"

if [ -x "${FW}" ] && "${FW}" --getglobalstate 2>/dev/null | grep -q "enabled"; then
  if [ -z "${WORKERD}" ] || ! "${FW}" --listapps 2>/dev/null | grep -qF "${WORKERD}"; then
    echo
    echo "⚠  The macOS firewall is on and workerd is not allowed through."
    echo "   Loopback will answer and the phone will time out, with no error anywhere."
    echo
    if [ -n "${WORKERD}" ]; then
      echo "   Allow it:"
      echo
      echo "     sudo ${FW} --add \"${ROOT}/${WORKERD}\""
      echo "     sudo ${FW} --unblockapp \"${ROOT}/${WORKERD}\""
    else
      echo "   Could not find the workerd binary to name in the rule."
    fi
    echo
    echo "   Or skip all of this: make deploy ENV=dev  (real host, and the PWA installs)"
    echo
    read -r -p "   Start anyway? [y/N] " answer
    [ "${answer}" = "y" ] || exit 1
  fi
fi

echo "── building ───────────────────────────────────────────────"
pnpm build >/dev/null
pnpm exec wrangler d1 migrations apply knag-dev --local --config worker/wrangler.jsonc >/dev/null 2>&1 || true
echo "  ok"
echo
echo "  On the iPhone, in Safari:"
echo
echo "      https://${IP}:${PORT}"
echo
echo "  Email:  ${OPERATOR_EMAIL}   (the code appears HERE, in this terminal — no mail is sent)"
echo
echo "  Self-signed certificate — iOS will warn once. Show Details -> visit anyway."
echo "  This is the LOCAL database. The real dev page is untouched."
echo "  Ctrl-C when you are done."
echo

exec pnpm exec wrangler dev \
  --config worker/wrangler.jsonc \
  --ip 0.0.0.0 \
  --port "${PORT}" \
  --local-protocol https \
  --var "KNAG_ENV:local" \
  --var "KNAG_OPERATOR_EMAIL:${OPERATOR_EMAIL}" \
  --var "KNAG_BEARER_TOKEN:knag-on-the-phone-bearer"
