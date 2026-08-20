import { describe, expect, it } from "vitest";
import { knockAt } from "../src/sound.js";

/**
 * The wipe's sound (#121) — the part of it that is arithmetic.
 *
 * 🔴 The synthesis itself is not tested here and could not usefully be: asserting that a
 * lowpass sweeps from 1100Hz to 170Hz proves the numbers were typed correctly and says
 * nothing about whether it sounds like anything. What *is* worth pinning is the claim the
 * design rests on — **the sound is not a fixed length, it is derived from the motion** —
 * because that is a property a future retune could silently break by changing one token.
 */

const SWEEP = { duration: 260, stagger: 14, collapse: 130 };
const PAGE = { duration: 380, stagger: 16, collapse: 200, page: true };

describe("when the knock lands", () => {
  it("🔴 ends when the board does, however many lines are going", () => {
    // The whole point. A fixed-length sound against a wipe whose length depends on the
    // line count lands the knock mid-motion on a long list and after silence on a short
    // one — and the mismatch shows up on the very first real wipe rather than in review.
    expect(knockAt(SWEEP, 1)).toBe(390); // 260 + 0 + 130
    expect(knockAt(SWEEP, 4)).toBe(432); // 260 + 42 + 130
    expect(knockAt(SWEEP, 20)).toBe(656); // 260 + 266 + 130
  });

  it("gives the page wipe a different length from the same formula", () => {
    // Not a second sound — the same event at a second scale, which is the audio
    // counterpart of the page wipe being a second timing rather than a second animation.
    expect(knockAt(PAGE, 9)).toBe(708); // 380 + 128 + 200
    expect(knockAt(PAGE, 9)).toBeGreaterThan(knockAt(SWEEP, 9));
  });

  it("🔴 follows the tokens, so retuning the motion retunes the sound", () => {
    // The maintenance claim, asserted rather than trusted. Halve the motion and the
    // sound halves with it; nothing in `sound.ts` names a duration of its own.
    const half = { duration: 130, stagger: 7, collapse: 65 };
    expect(knockAt(half, 5)).toBe(knockAt(SWEEP, 5) / 2);
  });

  it("counts the gaps between lines, not the lines", () => {
    // One line has no stagger to spread. An off-by-one here would put the knock a frame
    // late on every wipe in the product, which is exactly the kind of wrong that is
    // impossible to hear and trivial to assert.
    expect(knockAt(SWEEP, 1)).toBe(SWEEP.duration + SWEEP.collapse);
    expect(knockAt(SWEEP, 0)).toBe(SWEEP.duration + SWEEP.collapse);
  });

  it("🔴 goes too short to play when reduced motion collapses the tokens", () => {
    // How `prefers-reduced-motion` silences the sound: not with a media query and not
    // with a special case, but because the formula yields a few milliseconds and `play`
    // refuses anything under its audible floor. Someone who asked for less motion must
    // not be handed the one thing louder.
    const reduced = { duration: 1, stagger: 0, collapse: 1 };
    expect(knockAt(reduced, 30)).toBeLessThan(120);
  });
});
