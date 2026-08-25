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
# The unit of splitting is the spec file, which is a proxy for how much one server is
# asked to do.
#
# 🔴 **The trigger is duration, not test count** (#107). The stated trigger used to be
# "a spec file past roughly fifteen tests", which was replaced with "unknown, being
# measured", and both were wrong in different directions. Five occurrences settled it:
#
#   sync.spec.ts    died twice, while it was the slowest file of 7 and then of 8
#   wipe.spec.ts    failed once on an assertion, server alive — a different mode
#                   (that mode is closed: it was a 260ms sampling window, #201, and the
#                   sample now happens inside the page; #205 was the other one, a bug)
#   editor.spec.ts  died twice, while it was the slowest of 13 at 71-124 seconds
#
# Every dead-server failure landed in whichever file was **slowest at the time**. It looked
# like position for a while because in a small suite the slowest file also sat near the
# end; at thirteen files those separated and the failure followed the duration.
#
# Test count is a bad instrument for this — `sync.spec.ts` is seven tests and forty
# seconds of poll waiting, `editor.spec.ts` was thirty-three tests and seventy. Duration
# measures what test count was reaching for.
#
# 🔴 **So: keep every spec file under about a minute.** If one grows past that, split
# it rather than waiting for it to start flaking, and split it by what the tests wait on
# rather than by how many there are. `editor.spec.ts` was split into three that way and
# each lands near thirty seconds.
#
# What is still unexplained is the death itself: wrangler prints an empty `✘ [ERROR]` and
# its own crash log, uploaded as a CI artifact on failure, contains no error at all. The
# probe lines below print on every run, green ones included, so the next one arrives with
# evidence attached.

set -uo pipefail

cd "$(dirname "$0")/.."

# Mirrors PORT in playwright.config.ts. Duplicated rather than imported because this is
# bash reading a TypeScript module's constant; if they ever disagree the probe reports
# `port=free` forever, which is wrong but harmless.
PORT=8788

FAILED=()
DEAD=()
RETRIED=()
PASSED=0

# Where a dead server leaves its evidence, so the next occurrence is data rather than
# scrollback somebody has already closed (#107).
EVIDENCE=test-results/dead-server

# Failure signatures that mean "the dev server went away", not "an assertion failed".
DEAD_SERVER='Could not connect to|socket hang up|ECONNREFUSED|Connection refused|Network connection lost|browserContext.newPage'

# What accumulates across the nine servers this script starts, if anything (#107).
# Bash builtins and pgrep only — the CI container is a Playwright image, not a box with
# lsof or ss installed, and this has to keep working on a Mac too.
probe() {
  local when="$1" workerd wrangler port mem trace d1 zombie

  # 🔴 `pgrep -c` is procps-only and does not exist on macOS, where it fails usage
  # and the probe would report 0 forever — a false negative that would have quietly
  # wasted this whole investigation. Counted with `wc -l` instead, which both agree on.
  # One `wrangler dev` spawns two `workerd`, so the clean between-files reading is 0/0
  # and a single leaked server reads as workerd=2.
  workerd=$(pgrep -x workerd 2>/dev/null | wc -l | tr -d ' ')
  wrangler=$(pgrep -f 'wrangler dev' 2>/dev/null | wc -l | tr -d ' ')

  # 🔴 Split live from defunct, because the difference decides whether the count
  # means anything. A zombie holds a PID table slot and nothing else — no CPU, no memory,
  # and `kill -9` cannot remove one; only its parent reaping it can. If the survivors are
  # zombies then this column is a real leak and an irrelevant one, and the flake is
  # elsewhere.
  zombie=$(ps -eo stat=,comm= 2>/dev/null | awk '$2 ~ /workerd/ && $1 ~ /^Z/ { n++ } END { print n+0 }')

  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    port=bound
  else
    port=free
  fi

  if [ -r /proc/meminfo ]; then
    mem=$(awk '/^MemAvailable:/ {printf "%dMB", $2/1024}' /proc/meminfo)
  else
    # macOS. The flake has only ever appeared on Linux runners, so this is not worth
    # a vm_stat parser.
    mem="n/a"
  fi

  # 🔴 The one thing that provably grows across a run. `observability.enabled` is
  # true in worker/wrangler.jsonc, so every `wrangler dev` writes a request trace into
  # this store, and nothing ever clears it — it had reached 66MB locally, accumulating
  # since 2026-08-15, and is why the flake finally reproduced on a dev machine that had
  # never seen it. Cleared before every run below; this figure is the growth within one.
  trace=$(du -sm worker/.wrangler/state/v3/observability 2>/dev/null | cut -f1)
  d1=$(du -sm worker/.wrangler/state/v3/d1 2>/dev/null | cut -f1)

  printf '   probe %-34s workerd=%-3s (zombie=%-3s) wrangler=%-3s port=%-5s trace=%-5s d1=%-5s mem=%s\n' \
    "$when" "${workerd:-0}" "${zombie:-0}" "${wrangler:-0}" "$port" \
    "${trace:-0}MB" "${d1:-0}MB" "$mem"

  # pid<-ppid for every workerd alive. Printed because the first reaper guessed at this
  # and was wrong; a guess about parentage is not worth making twice.
  local detail
  detail=$(ps -eo pid=,ppid=,stat=,comm= 2>/dev/null | awk '$4 ~ /workerd/ { printf "%s<-%s(%s) ", $1, $2, $3 }')
  [ -n "$detail" ] && printf '         workerd parents: %s\n' "$detail"
  return 0
}

# 🔴 The workerd count is a leak, and a red herring. Recorded so it is not
# investigated a third time.
#
# The probe showed it climbing by exactly two per spec file and never coming down —
# 0, 2, 4, 6, 8, 10, 12, 14, 16, 18 — which looked like the mechanism. It is not.
# Every one of them is **defunct**: `zombie=` tracks `workerd=` exactly at every step.
# A zombie holds a PID table slot and nothing else, no CPU and no memory, and `kill -9`
# cannot remove one — only its parent reaping it can, which is why two attempts at a
# reaper here killed nothing at all.
#
# Playwright stops the `wrangler dev` it started and wrangler's two workerd children
# outlive it as zombies, because the CI container has no init that reaps. Untidy,
# harmless, and not worth code. It does not happen on macOS, which is a large part of
# why #107 never reproduced there — but it is not the reason the server dies.
#
# What the probe ruled out along with it: a retained port (`port=free` after every
# file, red runs included), memory exhaustion (flat at ~14GB throughout), and the
# trace store (7MB in CI against the 66MB that broke a local run).
#
# 🔴 What is still not explained is the death itself. Wrangler prints an empty
# `✘ [ERROR]`, writes no error into its own log, and the log simply stops mid-heartbeat.
# The log is uploaded as a CI artifact on failure now, so the next one can be read
# rather than reconstructed.
#
# What #107 does now have is a reproducer, which it never had:
#
#     KNAG_WRANGLER_STDOUT=1 pnpm test:browser
#
# Piping wrangler's stdout took the flake from two occurrences in weeks to five CI runs
# out of five. That is why it is opt-in rather than on — it perturbs what it measures —
# and why it is worth keeping.

shopt -s nullglob
SPECS=(browser/*.spec.ts)
shopt -u nullglob

if [ ${#SPECS[@]} -eq 0 ]; then
  echo "✗ No spec files found in browser/" >&2
  exit 1
fi

# 🔴 Sharded across runners in CI (#202). `KNAG_SHARD=n/m` keeps every m-th file by
# sorted index, starting at n — round-robin, so a file changes shard only when another
# is added ahead of it, never because a slow one got rebalanced by hand. Unset locally:
# one machine, every file, exactly as before.
#
# Each shard is still one server per file. The parallelism is across VMs and never
# inside one: #107 is per-server and traffic-shaped, and the probe below reads one
# server at a time. Four lanes on a 4-core box sharing one `.wrangler/state` would be
# a new investigation, not a faster version of this one.
#
# The suite was ~10 minutes serial, of which ~2.5 was twenty server starts and the rest
# deliberate waiting (poll tiers, wipe timings). Four shards land near three.
if [ -n "${KNAG_SHARD:-}" ]; then
  case "$KNAG_SHARD" in
    [0-9]*/[0-9]*) ;;
    *) echo "✗ KNAG_SHARD must be n/m (e.g. 2/4), got '${KNAG_SHARD}'" >&2; exit 1 ;;
  esac
  SHARD_N="${KNAG_SHARD%/*}"
  SHARD_M="${KNAG_SHARD#*/}"
  if [ "$SHARD_N" -lt 1 ] || [ "$SHARD_N" -gt "$SHARD_M" ]; then
    echo "✗ KNAG_SHARD ${KNAG_SHARD} is out of range" >&2
    exit 1
  fi
  MINE=()
  for i in "${!SPECS[@]}"; do
    if [ $(( i % SHARD_M )) -eq $(( SHARD_N - 1 )) ]; then
      MINE+=("${SPECS[$i]}")
    fi
  done
  # The `+` expansion keeps `set -u` quiet on an empty array under bash 3.2 (macOS).
  SPECS=("${MINE[@]+"${MINE[@]}"}")
  if [ ${#SPECS[@]} -eq 0 ]; then
    echo "✓ shard ${KNAG_SHARD} holds no spec files — nothing to run"
    exit 0
  fi
fi

# 🔴 Cleared before the run, not between files. `observability.enabled` is true in
# worker/wrangler.jsonc, so every `wrangler dev` writes request traces here and nothing
# ever removes them: one suite adds about 8MB and it had reached 66MB on the machine
# this was found on. At that size the suite died in editor.spec.ts with the exact
# signature of #107; cleared, the same suite on the same commit passed 9/9.
#
# That also explains why #107 "does not reproduce locally" — it does, once a working
# tree has aged enough. CI starts from a fresh checkout every time and never had the
# accumulation, so local and CI were quietly running different experiments. Clearing
# makes them the same one, and the trace= figure in the probe still shows the growth
# *within* a run, which is the part CI can also see.
TRACE_STORE=worker/.wrangler/state/v3/observability
if [ -d "$TRACE_STORE" ]; then
  echo "Clearing $(du -sm "$TRACE_STORE" 2>/dev/null | cut -f1)MB of accumulated wrangler traces (#107)."
  rm -rf "$TRACE_STORE"
fi

echo "Running ${#SPECS[@]} spec file(s)${KNAG_SHARD:+ — shard ${KNAG_SHARD}}, each against its own dev server."
printf '    %s\n' "${SPECS[@]}"
echo ""

probe "baseline"

# One spec file, against its own dev server. Returns playwright's status; leaves the
# output in $log and the run's wall-clock seconds in $ELAPSED.
#
# 🔴 Redirected to a file and printed afterwards, NOT piped through tee.
# A pipe the reader does not drain fast enough blocks the writer, and the thing being
# investigated here is a dev server dying under exactly that kind of pressure — so the
# instrument must not add a pipe to the path it measures. The cost is that output
# appears per spec file rather than streaming live, which in CI is no cost at all.
run_spec() {
  local spec="$1" started ended
  shift
  started=$(date +%s)
  pnpm exec playwright test "$spec" "$@" > "$log" 2>&1
  local status=$?
  ended=$(date +%s)
  ELAPSED=$((ended - started))
  return $status
}

# 🔴 Keep what died, because the next occurrence is otherwise scrollback in a closed tab.
# The three things that have actually been wanted after the fact, every time: the run's
# own output including the interleaved `[WebServer]` lines, how far into the file it got,
# and what the probe read immediately after.
keep_evidence() {
  local spec="$1" slug dir
  slug=$(echo "$spec" | tr '/.' '--')
  dir="${EVIDENCE}/${slug}"
  mkdir -p "$dir"
  cp "$log" "${dir}/run.log" 2>/dev/null || true
  {
    echo "spec:        ${spec}"
    echo "died after:  ${ELAPSED}s"
    echo "known good:  see the durations in the run summary above"
    echo ""
    echo "🔴 The number that matters is 'died after'. A server that dies twelve seconds"
    echo "   into every file is a different defect from one that dies near the end of"
    echo "   whichever file runs longest, and those two have been confused twice."
  } > "${dir}/notes.txt"
  echo "   Evidence kept in ${dir}/"
}

for spec in "${SPECS[@]}"; do
  echo "── ${spec}"

  log="$(mktemp)"
  if run_spec "$spec" "$@"; then
    cat "$log"
    PASSED=$((PASSED + 1))
  elif grep -qE "$DEAD_SERVER" "$log"; then
    cat "$log"
    echo ""
    echo "🔴 ${spec} failed with a DEAD DEV SERVER after ${ELAPSED}s, not a failing"
    echo "   assertion (#107). A connection error is what a dead server looks like from"
    echo "   inside a test, and reading it as a broken test is what makes these expensive."
    keep_evidence "$spec"

    # 🔴 Retried **once**, and the change of stance is deliberate. This used to be a red
    # build on purpose, which was right while nobody knew what it was: a red build was
    # the only way to see it at all. It is not right any more. The classifier identifies
    # this with high confidence, every occurrence is now recorded with its own evidence
    # directory, and a build that goes red for a known infrastructure defect costs a
    # re-run every time — which trains everybody to re-run reds, and that is how a real
    # failure eventually gets re-run instead of read.
    #
    # A silent retry would be hiding it. This one prints, keeps the evidence, and is
    # counted separately in the summary so a rising number is visible without reading
    # any logs. If the retry dies too, the build is red — twice in a row is not the
    # flake this exists for.
    echo ""
    echo "   Retrying once. This is counted, not hidden — see the summary."
    if run_spec "$spec" "$@"; then
      cat "$log"
      PASSED=$((PASSED + 1))
      RETRIED+=("$spec")
    else
      cat "$log"
      FAILED+=("$spec")
      DEAD+=("$spec")
      echo ""
      echo "🔴 ${spec} died a second time. That is not the flake — read the evidence."
    fi
  else
    cat "$log"
    FAILED+=("$spec")
  fi
  rm -f "$log"

  probe "after ${spec}"
  echo ""
done

# 🔴 Printed whether or not the build is red, and printed loudly. A retry that only
# showed up in a red build would be a retry nobody sees, which is the same as hiding it.
if [ ${#RETRIED[@]} -gt 0 ]; then
  echo "🔴 ${#RETRIED[@]} spec file(s) died as a dev server and passed on one retry (#107):" >&2
  printf '    %s\n' "${RETRIED[@]}" >&2
  echo "   Evidence in ${EVIDENCE}/. This number rising is the signal — it is the" >&2
  echo "   occurrence count the issue is waiting on, and it is free to collect now that" >&2
  echo "   it does not cost a release." >&2
  echo "" >&2
fi

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ ${#FAILED[@]} spec file(s) failed:" >&2
  printf '    %s\n' "${FAILED[@]}" >&2
  if [ ${#DEAD[@]} -gt 0 ]; then
    echo "" >&2
    echo "🔴 ${#DEAD[@]} of those died as a dev server **twice in a row** (#107):" >&2
    printf '    %s\n' "${DEAD[@]}" >&2
    echo "   That is not the flake this retries for. Read ${EVIDENCE}/ before re-running." >&2
  fi
  exit 1
fi

echo "✓ ${PASSED} spec file(s) passed"
