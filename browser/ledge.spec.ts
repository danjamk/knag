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

  test("🔴 the page's name is not a control until there is a second page", async ({ knag }) => {
    await knag.seed(DAY);

    // One page is not a special case of many; many is the special case, and it earns
    // the caret by existing (#123). Until then this is a status display and pressing it
    // must do nothing at all — no selector, no menu, no half-built affordance.
    const name = knag.page.locator("[data-page-name]");
    await expect(name).toHaveCount(1);
    expect(await name.evaluate((el: { tagName: string }) => el.tagName)).toBe("SPAN");

    await name.click();
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
