import { expect, test } from "./fixtures.js";

/**
 * The ledge — tier 2 of the bar (#139).
 *
 * 🔴 The whole design rests on one behaviour: **it cannot be open while the keyboard is
 * up.** The bar is thin because it sits above the keyboard on a phone, and a second tier
 * that persisted there would spend exactly the height that thinness was protecting. Every
 * other property of the ledge is a detail; that one is the reason it was allowed to exist,
 * and it is the one a refactor would silently drop — nothing fails when a ledge stays
 * open, it just quietly costs 56px on the surface the product is actually used on.
 *
 * Its own file rather than an addition to `render.spec.ts` for the reason that file's
 * header gives: a spec file past roughly fifteen tests starts tripping wrangler #69, and
 * a control with an open state, an inert state and a focus rule deserves them read
 * together.
 */

const DAY = ["Thursday", "- [ ] call the accountant", "- [x] pay the invoice", ""].join("\n");

test.describe("opening and closing", () => {
  test("ships closed, and closed means inert rather than merely short", async ({ knag }) => {
    await knag.seed(DAY);

    // 🔴 Two assertions because the closed state is a zero height with `overflow:
    // hidden`, and that alone hides the ledge from a reader while leaving all four of
    // its buttons in the tab order and reachable by a synthetic click. A control you
    // cannot see and can still press is worse than one that snaps open.
    await expect(knag.ledge()).not.toBeVisible();
    await expect(knag.ledge()).toHaveAttribute("inert", "");
    await expect(knag.page.locator("[data-ledge-toggle]")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("opens on the chevron and says so", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openLedge();

    await expect(knag.ledge()).toBeVisible();
    await expect(knag.ledge()).not.toHaveAttribute("inert", "");
    await expect(knag.page.locator("[data-ledge-toggle]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("closes on the chevron too — it is a toggle, not a trapdoor", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openLedge();

    await knag.page.locator("[data-ledge-toggle]").click();
    await expect(knag.ledge()).not.toBeVisible();
  });

  test("🔴 costs tier 1 nothing while it is closed", async ({ knag }) => {
    await knag.seed(DAY);

    // The bar a phone sees with the keyboard up is the bar it saw before the ledge
    // existed. If this ever fails, a second tier became permanent chrome above the
    // keyboard — which is the one thing the design refused to do.
    const closed = await knag.page.locator("footer").boundingBox();
    await knag.openLedge();
    const open = await knag.page.locator("footer").boundingBox();

    expect((await knag.page.locator(".bar").boundingBox())?.height).toBe(46);
    // 56px, the ledge's own token, and nothing else — no padding creeping in around it.
    expect((open?.height ?? 0) - (closed?.height ?? 0)).toBeGreaterThanOrEqual(56);
    expect((open?.height ?? 0) - (closed?.height ?? 0)).toBeLessThan(60);
  });

  test("🔴 opens above the bar, so the chevron that opened it is under the pointer to close it", async ({
    knag,
  }) => {
    await knag.seed(DAY);

    // It shipped below the bar. The footer is pinned to the bottom, so opening pushed
    // the bar up 56px and put the ledge — `wipe page` at its far end — under the
    // pointer that had just tapped the chevron (#192). The switcher already rose above
    // the bar; the ledge does the same now, and this pins it by geometry rather than by
    // DOM order, because order is the implementation and "the bar did not move" is the
    // promise.
    const toggle = knag.page.locator("[data-ledge-toggle]");
    const before = await toggle.boundingBox();
    await knag.openLedge();
    const after = await toggle.boundingBox();
    expect(after?.y).toBe(before?.y);
    expect(after?.x).toBe(before?.x);

    const ledge = await knag.ledge().boundingBox();
    const bar = await knag.page.locator(".bar").boundingBox();
    expect((ledge?.y ?? 0) + (ledge?.height ?? 0)).toBeLessThanOrEqual((bar?.y ?? 0) + 1);

    // A second click at the exact coordinates of the first closes it. Not `.click()` on
    // the locator, which would re-resolve the element wherever it went; the point is
    // that the pointer did not have to go anywhere.
    await knag.page.mouse.click(
      (before?.x ?? 0) + (before?.width ?? 0) / 2,
      (before?.y ?? 0) + (before?.height ?? 0) / 2,
    );
    await expect(knag.ledge()).not.toBeVisible();
  });

  test("🔴 no two controls on it overlap at phone width", async ({ knag }) => {
    // Four labels ran together on an iPhone — `arrange` into `settings` into `history`
    // — because a 44px flex basis plus a 44px dead margin on `wipe page` left each item
    // ~47px on a 390px screen, and `settings` at 11px mono is ~56px. Nothing clipped, so
    // nothing failed. This does.
    await knag.page.setViewportSize({ width: 390, height: 844 });
    await knag.seed(DAY);
    await knag.openLedge();

    // Structural types rather than `Element`: browser/tsconfig has no DOM lib, the same
    // reason settings.spec.ts reads computed style through `ownerDocument.defaultView`.
    type Measured = { getBoundingClientRect: () => { x: number; right: number } };
    const boxes: Array<{ x: number; right: number }> = [];
    for (const control of [".ledge-item", "[data-wipe-all]"]) {
      const measured = await knag.page
        .locator(control)
        .evaluateAll((els: Measured[]) =>
          els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, right: r.right })),
        );
      boxes.push(...measured);
    }
    boxes.sort((a, b) => a.x - b.x);
    expect(boxes.length).toBe(5);
    boxes.forEach((box, i) => {
      const previous = boxes[i - 1];
      if (!previous) return;
      expect(box.x, `control ${i} overlaps the one before it`).toBeGreaterThanOrEqual(
        previous.right - 0.5,
      );
    });
  });
});

test.describe("the rule that makes it free", () => {
  test("🔴 closes when the document takes focus", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openLedge();

    // There is no keyboard API, and every proxy for one is a guess that is wrong on a
    // tablet with a hardware keyboard. Focus is the thing actually being asked about:
    // being in the document is what raises the keyboard.
    await knag.editor(0).click();

    await expect(knag.ledge()).not.toBeVisible();
    await expect(knag.ledge()).toHaveAttribute("inert", "");
  });

  test("🔴 stays closed after typing — there is no pin, on purpose", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openLedge();

    await knag.editor(0).click();
    await knag.page.keyboard.type("!");
    await knag.saved();

    // Pin would mean "come back when I stop typing", and on a phone that is most of the
    // time you are not looking at the bar. It is one boolean and it ships when someone
    // on an iPad asks for it, not before.
    await expect(knag.ledge()).not.toBeVisible();
  });

  test("🔴 stays open for the recovery line, which is the bar and not the page", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.useEditor();
    await knag.openLedge();

    // Wipe the page, which is the only route to the offer — and it is on the ledge, so
    // the ledge is always open at the moment the offer appears below it.
    await knag.page.locator("[data-wipe-all]").click();
    await knag.page.locator("[data-wipe-all]").click();
    await expect(knag.page.locator("[data-recovery]")).toBeVisible();

    await knag.page.locator("[data-restore]").focus();

    // 🔴 The cause of the bug rather than the symptom (#149). Closing here took 56px
    // out of the layout **between the mousedown and the mouseup** on `bring back`, which
    // moved the button out from under the pointer — so no `click` was ever dispatched and
    // the first tap only closed the ledge. Desktop only, because iOS Safari does not
    // focus a `<button>` on tap, which is exactly the shape of report that arrived.
    //
    // It is also just true: the offer is chrome the app wrote about a wipe you just
    // took. The rule is that going back to the *page* closes the ledge, and reaching for
    // `bring back` is not going back to the page.
    await expect(knag.ledge()).toBeVisible();
    await expect(knag.ledge()).not.toHaveAttribute("inert", "");
  });

  // 🔴 **The symptom itself is not testable here, and this is the record of why.**
  //
  // What was reported is that `bring back` needed two clicks. A test that opens the
  // ledge, wipes the page and clicks the button once passes *with the bug present* —
  // Playwright re-checks the hit target around a click and retries when the element has
  // moved out from under the pointer, which is precisely the failure. It would be a test
  // that documents nothing, so it was written, negative-verified, and deleted.
  //
  // That is also the answer to why 527 tests and a browser suite never saw this: the
  // harness is more patient than a hand. The assertion above pins the cause instead, and
  // the cause is the thing that can regress.

  test("closes when Settings takes focus, because a modal is somewhere else", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.openSettings();

    await expect(knag.ledge()).not.toBeVisible();

    await knag.page.keyboard.press("Escape");
    await expect(knag.ledge()).not.toBeVisible();
  });

  test("🔴 stays open through Arrange, which is how you get back out", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.arrange();

    // Arrange is the one thing on the ledge that is a mode rather than an act, and the
    // control that leaves it is the same one that entered it. A ledge that closed here
    // would make leaving Arrange a two-tap operation with a chevron in the middle.
    await expect(knag.page.locator("[data-reorder]")).toHaveAttribute("aria-pressed", "true");
    await expect(knag.ledge()).toBeVisible();

    await knag.page.locator("[data-reorder]").click();
    await expect(knag.page.locator("[data-reorder]")).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("what is on which tier", () => {
  test("🔴 tier 1 holds the page, the machine slot, the wipe and the chevron", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    const bar = knag.page.locator(".bar");

    await expect(bar.locator("[data-page-name]")).toHaveText("today");
    await expect(bar.locator("[data-save-status]")).toBeVisible();
    await expect(bar.locator("[data-clear]")).toBeVisible();
    await expect(bar.locator("[data-ledge-toggle]")).toBeVisible();

    // The wordmark paid for the page's slot (#139). It survives on the login screen,
    // the icon, the landing page and the README — every place someone might not yet
    // know what they are looking at. Inside an app you have already opened, it is the
    // least load-bearing element on the bar.
    await expect(bar.locator(".wordmark")).toHaveCount(0);
  });

  test("🔴 the page's name is the switcher's control now, and the ledge ignores it", async ({
    knag,
  }) => {
    await knag.seed(DAY);

    // 🔴 **This test inverted in #154, and the inversion is the record of why.** It used
    // to assert the name was a `<span>` — "one page is not a special case of many; many
    // is the special case, and it earns the caret by existing" (#123). That was scoping
    // the state *before* pages existed. The switcher is how the second page gets made, so
    // it cannot wait for one to appear.
    const name = knag.page.locator("[data-page-name]");
    await expect(name).toHaveCount(1);
    expect(await name.evaluate((el: { tagName: string }) => el.tagName)).toBe("BUTTON");

    await name.click();

    // What survives unchanged: pressing it does not open the ledge. Two things over the
    // bar at once is a menu, and the bar's whole rationale is that it is not one.
    await expect(knag.page.locator("[data-switcher]")).toBeVisible();
    await expect(knag.ledge()).not.toBeVisible();
  });

  test("holds the operations that left Settings, in reachability order", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.openLedge();

    for (const control of ["[data-copy-page]", "[data-reorder]", "[data-settings-open]"]) {
      await expect(knag.ledge().locator(control), control).toBeVisible();
    }

    // And the sheet no longer holds an operation at all — that is §7e's rule arriving
    // early: a preference has a current value, and both of these are verbs.
    await expect(knag.page.locator("[data-settings] [data-copy-page]")).toHaveCount(0);
    await expect(knag.page.locator("[data-settings] [data-wipe-all]")).toHaveCount(0);
  });
});
