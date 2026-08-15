import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  IDLE_WINDOW_MS,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  POLL_STALE_MS,
  mayApplyRemote,
  pollInterval,
} from "../src/sync.js";

/**
 * Pure sync policy. No DOM needed, which is exactly why this logic was pulled out of
 * the event handlers — inside them it would be untestable, and both of these
 * decisions fail silently when they are wrong.
 */

const MINUTE = 60_000;

describe("poll interval (spec §14.4)", () => {
  it("stops entirely when hidden", () => {
    // Not "slows down". A backgrounded tab has nobody looking at it, and the
    // immediate refetch on visibilitychange covers the moment it matters.
    expect(pollInterval({ visible: false, msSinceActivity: 0 })).toBeNull();
    expect(pollInterval({ visible: false, msSinceActivity: 60 * MINUTE })).toBeNull();
  });

  const tiers: Array<[string, number, number]> = [
    ["just active", 0, POLL_ACTIVE_MS],
    ["active one minute ago", MINUTE, POLL_ACTIVE_MS],
    ["idle three minutes", 3 * MINUTE, POLL_IDLE_MS],
    ["idle fourteen minutes", 14 * MINUTE, POLL_IDLE_MS],
    ["idle twenty minutes", 20 * MINUTE, POLL_STALE_MS],
  ];

  for (const [name, msSinceActivity, expected] of tiers) {
    it(`${name} → ${expected / 1000}s`, () => {
      expect(pollInterval({ visible: true, msSinceActivity })).toBe(expected);
    });
  }

  it("puts a freshly opened tab in the fast tier", () => {
    // 🔴 The regression this test exists for. When the tier was measured from the
    // last *edit*, a tab that had been opened but not typed in had no edit to measure
    // from, landed on 60s, and looked broken: a change made on the device you were
    // typing on took a minute to appear on the other one, so sync seemed one-way.
    //
    // `app.ts` seeds activity at load and on window focus, so this is the state a
    // just-opened or just-focused tab is actually in.
    expect(pollInterval({ visible: true, msSinceActivity: 0 })).toBe(POLL_ACTIVE_MS);
  });

  it("treats each boundary as belonging to the slower tier", () => {
    // Exactly on the boundary backs off rather than staying fast. Either choice is
    // defensible; the test exists so it is not accidental.
    expect(pollInterval({ visible: true, msSinceActivity: ACTIVE_WINDOW_MS - 1 })).toBe(POLL_ACTIVE_MS);
    expect(pollInterval({ visible: true, msSinceActivity: ACTIVE_WINDOW_MS })).toBe(POLL_IDLE_MS);
    expect(pollInterval({ visible: true, msSinceActivity: IDLE_WINDOW_MS - 1 })).toBe(POLL_IDLE_MS);
    expect(pollInterval({ visible: true, msSinceActivity: IDLE_WINDOW_MS })).toBe(POLL_STALE_MS);
  });

  it("never returns an interval faster than the active tier", () => {
    for (let m = 0; m <= 120; m++) {
      const interval = pollInterval({ visible: true, msSinceActivity: m * MINUTE });
      expect(interval).not.toBeNull();
      expect(interval as number).toBeGreaterThanOrEqual(POLL_ACTIVE_MS);
    }
  });

  it("stays inside the free-tier budget for a realistic day", () => {
    // 🔴 The check the tiers exist for. Spec §14.4: Workers free tier is 100k
    // requests/day, and three devices on a flat 4s poll exceed it on polling alone.
    //
    // The model has to include focus bursts, not just one editing session. Since
    // focus counts as activity, every return to a window restarts the fast tier —
    // an earlier version of this test ignored that and reported a number roughly
    // half the truth. A budget test that models the wrong usage pattern is worse
    // than none, because it reads as headroom that is not there.
    const burst = (2 * MINUTE) / POLL_ACTIVE_MS + (13 * MINUTE) / POLL_IDLE_MS;
    const BURSTS_PER_DAY = 30; // opening or refocusing knag twice an hour, awake

    const burstMinutes = BURSTS_PER_DAY * 15;
    const idleMinutes = Math.max(0, 24 * 60 - burstMinutes);
    const perDevice = BURSTS_PER_DAY * burst + (idleMinutes * MINUTE) / POLL_STALE_MS;

    // Three devices, the case the spec calls out explicitly, against the real
    // ceiling. Lands around 10,350/day — roughly a tenth of the budget, where a flat
    // 4s poll would be ~65,000 and leave nothing for actual use.
    expect(perDevice * 3).toBeLessThan(100_000);
    // The tripwire that matters: this is the number a future change would have to
    // quadruple before the ceiling is in danger, so catch it long before then.
    expect(perDevice * 3).toBeLessThan(15_000);
  });
});

describe("the dirty guard (spec §6)", () => {
  it("applies a remote update only when the editor is neither dirty nor focused", () => {
    expect(mayApplyRemote({ dirty: false, focused: false })).toBe(true);
  });

  const refused: Array<[string, { dirty: boolean; focused: boolean }]> = [
    ["dirty", { dirty: true, focused: false }],
    ["focused", { dirty: false, focused: true }],
    ["both", { dirty: true, focused: true }],
  ];

  for (const [name, state] of refused) {
    it(`refuses while ${name}`, () => {
      expect(mayApplyRemote(state)).toBe(false);
    });
  }

  it("refuses while merely focused, not only while dirty", () => {
    // 🔴 The case that is easy to get wrong and impossible to notice in review.
    // Assigning textarea.value resets the selection, so a poll landing between two
    // keystrokes throws the caret to the end of the document even when nothing has
    // been typed yet in this focus. Guarding on `dirty` alone lets that through.
    expect(mayApplyRemote({ dirty: false, focused: true })).toBe(false);
  });
});
