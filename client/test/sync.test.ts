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
    expect(pollInterval({ visible: false, msSinceEdit: 0 })).toBeNull();
    expect(pollInterval({ visible: false, msSinceEdit: 60 * MINUTE })).toBeNull();
  });

  const tiers: Array<[string, number, number]> = [
    ["just edited", 0, POLL_ACTIVE_MS],
    ["edited one minute ago", MINUTE, POLL_ACTIVE_MS],
    ["idle three minutes", 3 * MINUTE, POLL_IDLE_MS],
    ["idle fourteen minutes", 14 * MINUTE, POLL_IDLE_MS],
    ["idle twenty minutes", 20 * MINUTE, POLL_STALE_MS],
    ["never edited", Number.POSITIVE_INFINITY, POLL_STALE_MS],
  ];

  for (const [name, msSinceEdit, expected] of tiers) {
    it(`${name} → ${expected / 1000}s`, () => {
      expect(pollInterval({ visible: true, msSinceEdit })).toBe(expected);
    });
  }

  it("treats each boundary as belonging to the slower tier", () => {
    // Exactly on the boundary backs off rather than staying fast. Either choice is
    // defensible; the test exists so it is not accidental.
    expect(pollInterval({ visible: true, msSinceEdit: ACTIVE_WINDOW_MS - 1 })).toBe(POLL_ACTIVE_MS);
    expect(pollInterval({ visible: true, msSinceEdit: ACTIVE_WINDOW_MS })).toBe(POLL_IDLE_MS);
    expect(pollInterval({ visible: true, msSinceEdit: IDLE_WINDOW_MS - 1 })).toBe(POLL_IDLE_MS);
    expect(pollInterval({ visible: true, msSinceEdit: IDLE_WINDOW_MS })).toBe(POLL_STALE_MS);
  });

  it("never returns an interval faster than the active tier", () => {
    for (let m = 0; m <= 120; m++) {
      const interval = pollInterval({ visible: true, msSinceEdit: m * MINUTE });
      expect(interval).not.toBeNull();
      expect(interval as number).toBeGreaterThanOrEqual(POLL_ACTIVE_MS);
    }
  });

  it("stays inside the free-tier budget for a tab left open all day", () => {
    // 🔴 The check the tiers exist for. Spec §14.4: Workers free tier is 100k
    // requests/day and three devices on a flat 4s poll exceed it on polling alone.
    //
    // One device, visible all day, edited for the first ten minutes and then left:
    // ten minutes of fast-then-idle polling, and 23h50m at the stale tier.
    const activeRequests = (2 * MINUTE) / POLL_ACTIVE_MS + (8 * MINUTE) / POLL_IDLE_MS;
    const staleRequests = (24 * 60 * MINUTE - 10 * MINUTE) / POLL_STALE_MS;
    const perDevice = activeRequests + staleRequests;

    expect(perDevice).toBeLessThan(1_500);
    // Three devices, the case the spec calls out explicitly.
    expect(perDevice * 3).toBeLessThan(5_000);
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
