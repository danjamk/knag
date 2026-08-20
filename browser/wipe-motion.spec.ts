import { expect, test } from "./fixtures.js";

/**
 * How the wipe moves (#121).
 *
 * 🔴 **The feel is not testable and this file does not pretend otherwise.** Whether
 * `sweep` reads as chalk coming off a board and `fall` reads as released rather than
 * discarded is a judgment made on a phone against a real page, and no assertion here
 * touches it. What is pinned is the machinery underneath: that the page wipe runs the
 * page timing rather than the daily one, that it runs bottom-up, and that the empty
 * board is held before the record speaks.
 *
 * The other half lives in `worker/test/shell.test.ts`, which pins that there is one
 * wipe keyframe and that the page timing is four token redefinitions rather than a
 * second animation. Both halves are needed: that one cannot see the screen, this one
 * cannot see the stylesheet's shape.
 *
 * Its own file rather than an addition to `wipe.spec.ts`, which is at fifteen tests —
 * the number where wrangler #69 starts biting, and where #107's dead servers landed.
 */

// No trailing newline: four blocks, so the page wipe takes exactly four rows and the
// bottom-up order below is readable as [3, 2, 1, 0] rather than as an off-by-one.
const MIXED = ["keep me", "- [x] done one", "- [ ] not done", "- [x] done two"].join("\n");

/** Computed style, via `ownerDocument.defaultView` — browser/tsconfig has no DOM lib. */
type Styled = { ownerDocument: { defaultView: unknown } };
type View = { getComputedStyle: (e: unknown) => { getPropertyValue: (p: string) => string } };

async function css(
  locator: import("@playwright/test").Locator,
  property: string,
): Promise<string> {
  return locator.evaluate(
    (el: Styled, prop: string) =>
      (el.ownerDocument.defaultView as View).getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

const ms = (value: string) =>
  value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000;

test.describe("the daily sweep", () => {
  test("🔴 fades in place first, and only then closes the gap", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();

    // The property the whole sequence was built around, and the one a retune could
    // quietly lose: the rows go transparent **holding their height**, and one collapse
    // closes the gap afterwards. Fading and collapsing together makes the page jump
    // under the thumb that just tapped, and the release starts feeling like a mis-tap.
    const row = knag.page.locator("[data-rows] li.wiping").first();
    await expect(row).toBeVisible();
    expect(await css(row, "max-height")).not.toBe("0px");

    await expect(knag.page.locator("[data-rows] li.closing").first()).toBeAttached();
  });

  test("runs the daily timing, not the page's", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();

    const row = knag.page.locator("[data-rows] li.wiping").first();
    await expect(row).toBeVisible();

    // Asserted against the token rather than against 260, so a retune moves one number
    // in one place and this still says what it means.
    const daily = ms(await css(knag.page.locator("body"), "--wipe-duration"));
    expect(ms(await css(row, "animation-duration"))).toBe(daily);
    await expect(row).not.toHaveClass(/\bpage\b/);
  });

  test("🔴 leaves top-down — the first row to go is the first one", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();

    const rows = knag.page.locator("[data-rows] li.wiping");
    await expect(rows).toHaveCount(2);
    expect(await css(rows.nth(0), "--i")).toBe("0");
    expect(await css(rows.nth(1), "--i")).toBe("1");
  });
});

test.describe("wiping the page", () => {
  test("🔴 runs the page timing, which is a different length", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.openLedge();
    await knag.page.locator("[data-wipe-all]").click();
    await knag.page.locator("[data-wipe-all]").click();

    const row = knag.page.locator("[data-rows] li.wiping").first();
    await expect(row).toBeVisible();

    // 🔴 The end-to-end proof that four token redefinitions on the element actually
    // reach the animation. The shell test can see that the rule exists; only a browser
    // can say the cascade delivered it.
    const page = ms(await css(knag.page.locator("body"), "--page-duration"));
    const daily = ms(await css(knag.page.locator("body"), "--wipe-duration"));
    expect(page).not.toBe(daily);
    expect(ms(await css(row, "animation-duration"))).toBe(page);
  });

  test("🔴 leaves bottom-up — the page goes as one object, not as a list", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.openLedge();
    await knag.page.locator("[data-wipe-all]").click();
    await knag.page.locator("[data-wipe-all]").click();

    // Wiping completed lines is many small removals and reads top-down, like a list
    // being processed. Wiping the page is one removal of one thing. The direction is
    // the difference, and it is the whole reason the two do not feel the same.
    const rows = knag.page.locator("[data-rows] li.wiping");
    await expect(rows).toHaveCount(4);

    const order = await Promise.all(
      [0, 1, 2, 3].map((n) => css(rows.nth(n), "--i").then((v) => Number.parseInt(v, 10))),
    );
    expect(order).toEqual([3, 2, 1, 0]);
  });

  /**
   * 🔴 **The beat is deliberately not tested, and this is the record of why.**
   *
   * `--page-beat` holds 200ms of empty board after the collapse and before the record
   * speaks. Three versions of a test for it were written and all three were removed:
   *
   * - An absolute lower bound was theatre. With the beat deleted the page wipe still
   *   took 855ms on this machine, so any threshold loose enough not to flake was loose
   *   enough to pass without the thing it tested. Verified by deleting the beat and
   *   watching it stay green.
   * - Measuring the page wipe against the daily one in the same run cancels machine
   *   speed but not the network: the difference swung between 17ms and 300ms across
   *   four runs of the same test, because a wipe waits on a round trip and a re-read
   *   that vary by more than the beat is long.
   * - Waiting on the recovery line by visibility rather than by count reads the *old*
   *   offer, which survives a reload. That one measured −829ms.
   *
   * What is pinned instead: `--page-beat` exists and is collapsed under reduced motion
   * (`worker/test/shell.test.ts`), and the two timings and both directions are asserted
   * above. Whether 200ms is the right pause is a phone judgment, like the rest of the
   * feel, and a test that pretends otherwise is worse than an honest gap — a flaky one
   * gets re-run rather than read, which is how #107 cost two false reds.
   */
});
