import { expect, test } from "./fixtures.js";

/**
 * Wipe — the product's central gesture, and the only destructive control in the app.
 *
 * Its own spec file rather than an addition to `render.spec.ts`, for two reasons. The
 * runner gives each file its own dev server and a file that grows past roughly fifteen
 * tests starts tripping the wrangler defect #69 documents — `render.spec.ts` is already
 * at thirteen. And a destructive control deserves a file where the confirm path, the
 * cancel path and the scope boundary are read together.
 */

const MIXED = "keep me\n- [x] done one\n- [ ] not done\n- [x] done two";

test.describe("wipe completed", () => {
  test("sweeps the checked rows and leaves the rest", async ({ knag }) => {
    await knag.seed(MIXED);

    await knag.page.locator("[data-clear]").click();

    await expect(knag.rows()).toHaveCount(2);
    expect(await knag.document()).toBe("keep me\n- [ ] not done");
  });
});

test.describe("wipe the page", () => {
  test("lives in settings, not on the footer", async ({ knag }) => {
    await knag.seed(MIXED);

    // 🔴 The footer is capped at three controls and the rule is that rare things live
    // in settings. Wiping everything is rare; sweeping the done items is not. If this
    // ever moves to the bar it should be a decision, not a drift.
    await expect(knag.page.locator("footer [data-wipe-all]")).toHaveCount(0);

    await knag.page.locator("[data-settings-open]").click();
    await expect(knag.page.locator("[data-settings] [data-wipe-all]")).toBeVisible();
  });

  test("empties the page once confirmed", async ({ knag }) => {
    await knag.seed(MIXED);

    knag.page.once("dialog", (dialog) => void dialog.accept());
    await knag.page.locator("[data-settings-open]").click();
    await knag.page.locator("[data-wipe-all]").click();

    await expect.poll(() => knag.document()).toBe("");
  });

  test("🔴 changes nothing when the confirm is dismissed", async ({ knag }) => {
    // The confirm is the only thing between a settings tap and losing unfinished work,
    // so a dismissed dialog has to mean *nothing happened* — not "happened anyway".
    await knag.seed(MIXED);

    knag.page.once("dialog", (dialog) => void dialog.dismiss());
    await knag.page.locator("[data-settings-open]").click();
    await knag.page.locator("[data-wipe-all]").click();

    // Give the request a chance to have been made, so this fails loudly rather than
    // passing because the assertion ran first.
    await knag.page.waitForTimeout(500);
    expect(await knag.document()).toBe(MIXED);
  });

  test("brings the whole page back, including the unfinished lines", async ({ knag }) => {
    await knag.seed(MIXED);

    knag.page.once("dialog", (dialog) => void dialog.accept());
    await knag.page.locator("[data-settings-open]").click();
    await knag.page.locator("[data-wipe-all]").click();
    await expect.poll(() => knag.document()).toBe("");

    // The settings dialog is modal, so the footer is inert until it closes — which is
    // the platform doing its job, and worth going through rather than around.
    await knag.page.locator("[data-settings] .done").click();
    await knag.page.locator("[data-restore]").click();

    await expect.poll(() => knag.document()).toBe(MIXED);
  });

  test("names the number it is about to throw away", async ({ knag }) => {
    // "Wipe the page" and "throw away four things" land differently, and the second is
    // the one that stops a mistake.
    await knag.seed(MIXED);

    let message = "";
    knag.page.once("dialog", (dialog) => {
      message = dialog.message();
      void dialog.dismiss();
    });
    await knag.page.locator("[data-settings-open]").click();
    await knag.page.locator("[data-wipe-all]").click();

    await expect.poll(() => message).toContain("4");
  });
});

test.describe("bringing it back (#59)", () => {
  test("offers the undo only after a wipe, naming the count", async ({ knag }) => {
    await knag.seed(MIXED);

    await expect(knag.page.locator("[data-restore]")).toBeHidden();

    await knag.page.locator("[data-clear]").click();

    await expect(knag.page.locator("[data-restore]")).toHaveText("wiped 2 · bring back");
  });

  test("🔴 keeps what was typed after the wipe", async ({ knag }) => {
    // The property the whole feature rests on, end to end. Writing the snapshot back
    // would return MIXED and lose "added after" — a worse data-loss path than the one
    // the undo exists to prevent.
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).toBe("keep me\n- [ ] not done");

    const row = knag.editor(1);
    await row.click();
    await row.press("End");
    // Enter on a checkbox row continues the list, so the new row arrives as
    // `- [ ] added after`. That is the editor behaving correctly and the expectation
    // below says so rather than asserting what would be convenient.
    await row.pressSequentially("\nadded after");
    await knag.saved();

    await knag.page.locator("[data-restore]").click();

    await expect
      .poll(() => knag.document())
      .toBe("keep me\n- [x] done one\n- [ ] not done\n- [x] done two\n- [ ] added after");
  });

  test("withdraws the offer once taken, so it cannot run twice", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();
    await knag.page.locator("[data-restore]").click();

    await expect(knag.page.locator("[data-restore]")).toBeHidden();
    await expect.poll(() => knag.document()).toBe(MIXED);
  });

  test("survives a reload, which is most of what a phone does", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();
    await expect(knag.page.locator("[data-restore]")).toBeVisible();

    await knag.page.reload();

    await expect(knag.page.locator("[data-restore]")).toHaveText("wiped 2 · bring back");
  });
});
