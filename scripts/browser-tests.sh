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
# The unit of splitting is the spec file, which is a proxy for "not too many tests
# against one server".
#
# 🔴 That proxy had a stated trigger — "a spec file past roughly fifteen tests" —
# and it was wrong (#107). Both CI failures since landed in `sync.spec.ts`, which has
# seven tests, and following the old advice would have prevented neither.
#
# What the archived logs actually show is that both died on a server that had only just
# started: `98e7249` before its first test could see the editor, `95a06d5` twelve seconds
# into a file that runs for forty, with two tests already passed. A file's own traffic
# exhausting its own server does not explain either one. What the two share is position —
# `sync.spec.ts` is the 8th of 9 servers this script starts — which makes it the place a
# per-run accumulation tips over, not the cause.
#
# So the trigger is unknown and being measured rather than guessed. The probe lines below
# print on every run, green ones included, so the next failure arrives with evidence
# attached instead of needing a reproduction that has never happened locally.

set -uo pipefail

cd "$(dirname "$0")/.."

# Mirrors PORT in playwright.config.ts. Duplicated rather than imported because this is
# bash reading a TypeScript module's constant; if they ever disagree the probe reports
# `port=free` forever, which is wrong but harmless.
PORT=8788

FAILED=()
DEAD=()
PASSED=0

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

echo "Running ${#SPECS[@]} spec file(s), each against its own dev server."
echo ""

probe "baseline"

for spec in "${SPECS[@]}"; do
  echo "── ${spec}"

  # Captured as well as streamed, so a dead server can be told apart from a failing
  # assertion. `pipefail` is set, so the `if` still sees playwright's exit code and not
  # tee's.
  log="$(mktemp)"
  if pnpm exec playwright test "$spec" "$@" 2>&1 | tee "$log"; then
    PASSED=$((PASSED + 1))
  else
    FAILED+=("$spec")
    if grep -qE "$DEAD_SERVER" "$log"; then
      DEAD+=("$spec")
      echo ""
      echo "🔴 ${spec} failed with a DEAD DEV SERVER, not a failing assertion (#107)."
      echo "   A connection error is what a dead server looks like from inside a test, and"
      echo "   reading it as a broken test is what makes these expensive to triage."
      echo "   The probe lines are the evidence. Read them before re-running."
    fi
  fi
  rm -f "$log"

  probe "after ${spec}"
  echo ""
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ ${#FAILED[@]} spec file(s) failed:" >&2
  printf '    %s\n' "${FAILED[@]}" >&2
  if [ ${#DEAD[@]} -gt 0 ]; then
    echo "" >&2
    echo "🔴 ${#DEAD[@]} of those died as a dev server, not as a real failure (#107):" >&2
    printf '    %s\n' "${DEAD[@]}" >&2
    echo "   Still a red build on purpose. Re-running hides it; the probe lines explain it." >&2
  fi
  exit 1
fi

echo "✓ ${PASSED} spec file(s) passed"
