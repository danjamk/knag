#!/usr/bin/env bash
#
# Post one message to Slack (#260).
#
# Usage: slack-notify.sh <heartbeat|critical> <text>
#
# The webhook comes from the environment, never an argument: an argument is visible
# in `ps` and in a workflow's own command echo, and a Slack webhook is a credential —
# anyone holding it can post to that channel.
#
#   heartbeat  SLACK_WEBHOOK_HEARTBEAT  "the backup ran, and here is what it wrote"
#   critical   SLACK_WEBHOOK_CRITICAL   "a prod job failed"
#
# 🔴 **This script fails the job when it cannot deliver.** A notifier that shrugs when
# its webhook is missing recreates the bug this exists to fix: eight silent backup
# failures that looked exactly like eight silent successes. If alerting is broken, the
# run that discovered it is the one that should say so.
#
# 🔴 It also fails on a 200 that is not `ok`. Slack answers a retired or malformed
# webhook with 200 and a body saying why, so exit status alone reports success for a
# message nobody received.
set -euo pipefail

KIND="${1:?usage: slack-notify.sh <heartbeat|critical> <text>}"
TEXT="${2:?usage: slack-notify.sh <heartbeat|critical> <text>}"

case "$KIND" in
  heartbeat) WEBHOOK="${SLACK_WEBHOOK_HEARTBEAT:-}" ;;
  critical)  WEBHOOK="${SLACK_WEBHOOK_CRITICAL:-}" ;;
  *) echo "::error::unknown notification kind '${KIND}' — expected heartbeat or critical" >&2; exit 2 ;;
esac

if [ -z "$WEBHOOK" ]; then
  echo "::error::No webhook for '${KIND}'. Set the matching secret on the production environment." >&2
  exit 1
fi

# jq builds the body, so a message holding a quote, a newline or a backslash cannot
# break the JSON — a failure message quoting a shell error is exactly the text most
# likely to contain all three.
BODY=$(jq -nc --arg text "$TEXT" '{text: $text}')

# `--fail-with-body` would hide the body on a 4xx; the body is the whole diagnosis here,
# so the status is captured separately and both are reported.
STATUS=$(curl -sS -o /tmp/slack-response -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  --data "$BODY" "$WEBHOOK")
RESPONSE=$(cat /tmp/slack-response)

if [ "$STATUS" != "200" ] || [ "$RESPONSE" != "ok" ]; then
  # 🔴 The webhook is never printed, on any path. It is a credential, and a failure
  # message is the one most likely to be pasted somewhere else.
  echo "::error::Slack rejected the ${KIND} message: HTTP ${STATUS}, body '${RESPONSE}'" >&2
  exit 1
fi

echo "posted ${KIND} notification"
