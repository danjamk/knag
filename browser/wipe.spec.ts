import { type Knag, expect, test } from "./fixtures.js";

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

/** Arm and fire the whole-page wipe. Two taps, no dialog — see the tests below. */
async function wipeThePage(knag: Knag): Promise<void> {
  await knag.openLedge();
  await knag.page.locator("[data-wipe-all]").click();
  await knag.page.locator("[data-wipe-all]").click();
}

test.describe("wipe completed", () => {
  test("sweeps the checked rows and leaves the rest", async ({ knag }) => {
    await knag.seed(MIXED);

    await knag.page.locator("[data-clear]").click();

    await expect(knag.rows()).toHaveCount(2);
    expect(await knag.document()).toBe("keep me\n- [ ] not done");
  });

  test("🔴 carries its count inside the control, and takes one tap", async ({ knag }) => {
    // The count in the control is what replaced the confirm dialog: you read the size
    // of the thing before you tap it, and the recovery line below makes taking it back
    // one tap. A `confirm()` was also the loudest, least knag-shaped thing in the app.
    //
    // A dialog appearing at all fails this test rather than hanging it: Playwright
    // auto-dismisses an unhandled dialog, so without the listener the wipe would simply
    // not happen and the failure would point at the wrong thing.
    let dialogs = 0;
    knag.page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });

    await knag.seed(MIXED);
    await expect(knag.page.locator("[data-clear]")).toHaveText(/wipe\s*2/);

    await knag.page.locator("[data-clear]").click();

    await expect.poll(() => knag.document()).toBe("keep me\n- [ ] not done");
    expect(dialogs, "the sweep asked for confirmation").toBe(0);
  });

  test("🔴 does not ask, however many are checked", async ({ knag }) => {
    // There used to be a threshold at ten. The argument for keeping it was that a big
    // sweep deserves a pause; the argument against is that the count is now *in* the
    // control and `bring back` is one tap, so the pause bought a dialog and nothing
    // else. Spec §7 amended.
    let dialogs = 0;
    knag.page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });

    const many = Array.from({ length: 14 }, (_, i) => `- [x] done ${i}`).join("\n");
    await knag.seed(`keep me\n${many}`);
    await expect(knag.page.locator("[data-clear]")).toHaveText(/wipe\s*14/);

    await knag.page.locator("[data-clear]").click();

    await expect.poll(() => knag.document(), { timeout: 15_000 }).toBe("keep me");
    expect(dialogs, "a large sweep asked for confirmation").toBe(0);
  });

  test("the control is absent at zero, not disabled", async ({ knag }) => {
    // No greyed ghost. An empty right edge of the footer is the page saying there is
    // nothing to release.
    await knag.seed("keep me\n- [ ] not done");
    await expect(knag.page.locator("[data-clear]")).toBeHidden();
  });
});

test.describe("wipe the page", () => {
  test("🔴 lives on the ledge, a tier away from the everyday wipe", async ({ knag }) => {
    await knag.seed(MIXED);

    // The frequencies are not comparable — sweeping the done items is every morning,
    // wiping the page is when a project ends — and the thing that must never happen is
    // the two becoming similar buttons side by side. It left Settings for the ledge
    // (#139); what protects it now is the tier, not the depth.
    await expect(knag.page.locator(".bar [data-wipe-all]")).toHaveCount(0);
    await expect(knag.page.locator("[data-settings] [data-wipe-all]")).toHaveCount(0);

    await knag.openLedge();
    const wipeAll = knag.page.locator("[data-ledge] [data-wipe-all]");
    await expect(wipeAll).toBeVisible();

    // Past the hairline, alone at the far end. `copy` is the control a reader reaches
    // for often, and it must never be one mis-tap from this one.
    const separator = await knag.page.locator(".ledge-sep").boundingBox();
    const box = await wipeAll.boundingBox();
    expect(box?.x ?? 0).toBeGreaterThan(separator?.x ?? 0);
  });

  test("🔴 confirms by repetition rather than by dialog", async ({ knag }) => {
    // A second tap on the same control, in the same place you were already looking —
    // not a grey OS box with a title bar in a product whose whole voice is quiet.
    let dialogs = 0;
    knag.page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });

    await knag.seed(MIXED);
    await knag.openLedge();

    const control = knag.page.locator("[data-wipe-all]");
    await expect(control).toHaveText(/wipe page\s*4/);

    await control.click();
    await expect(control).toHaveAttribute("data-armed", "");
    await expect(control).toHaveText(/again to confirm/);
    expect(await knag.document(), "one tap wiped the page").toBe(MIXED);

    await control.click();
    await expect.poll(() => knag.document()).toBe("");
    expect(dialogs, "the whole-page wipe opened a dialog").toBe(0);
  });

  test("🔴 disarms on its own, so it is not left loaded", async ({ knag }) => {
    // An armed control that stayed armed would be a trap for the next person who
    // reached for the ledge for an unrelated reason — one tap, and the page is gone.
    await knag.seed(MIXED);
    await knag.openLedge();

    const control = knag.page.locator("[data-wipe-all]");
    await control.click();
    await expect(control).toHaveAttribute("data-armed", "");
    await expect(control).toHaveText(/again to confirm/);

    await expect(control).toHaveText(/wipe page/, { timeout: 10_000 });
    expect(await knag.document()).toBe(MIXED);
  });

  test("🔴 disarms when the ledge closes", async ({ knag }) => {
    // The same trap by another route, and the route changed with the control: it used
    // to be closing the sheet, and it is now closing the ledge. Arm it, close, come
    // back, and one tap would wipe the page having forgotten the tap that armed it.
    await knag.seed(MIXED);
    await knag.openLedge();

    const control = knag.page.locator("[data-wipe-all]");
    await control.click();
    await expect(control).toHaveAttribute("data-armed", "");

    await knag.page.locator("[data-ledge-toggle]").click();
    await knag.openLedge();

    await expect(control).toHaveText(/wipe page/);
    await control.click();
    expect(await knag.document(), "a re-opened ledge was still armed").toBe(MIXED);
  });

  test("🔴 disarms when the document takes focus, which also closes the ledge", async ({
    knag,
  }) => {
    // The route that did not exist while this lived in a modal. Arm it, tap back into
    // the page to read what you were about to throw away, and the ledge collapses —
    // taking the armed state with it rather than leaving it loaded behind a chevron.
    await knag.seed(MIXED);
    await knag.openLedge();

    const control = knag.page.locator("[data-wipe-all]");
    await control.click();
    await expect(control).toHaveAttribute("data-armed", "");

    await knag.editor(0).click();
    await expect(knag.ledge()).not.toBeVisible();

    await knag.openLedge();
    await expect(control).not.toHaveAttribute("data-armed", "");
    expect(await knag.document()).toBe(MIXED);
  });

  test("brings the whole page back, including the unfinished lines", async ({ knag }) => {
    await knag.seed(MIXED);
    await wipeThePage(knag);
    await expect.poll(() => knag.document()).toBe("");

    // 🔴 No dialog to dismiss first. While this lived in the sheet the recovery line was
    // inert behind a modal backdrop, and the test had to close it to reach the undo.
    // On the ledge the regret and the remedy are on screen together, which is where the
    // line was always meant to be.
    await knag.page.locator("[data-restore]").click();

    await expect.poll(() => knag.document()).toBe(MIXED);
  });

  test("names the number it is about to throw away", async ({ knag }) => {
    // "Wipe page" and "throw away four things" land differently, and the second is the
    // one that stops a mistake. It is on the control rather than in a dialog.
    await knag.seed(MIXED);
    await knag.openLedge();

    await expect(knag.page.locator("[data-wipe-all-count]")).toHaveText("4");
  });
});

test.describe("bringing it back (#59)", () => {
  test("offers the undo only after a wipe, naming the count", async ({ knag }) => {
    await knag.seed(MIXED);

    await expect(knag.recovery()).toBeHidden();

    await knag.page.locator("[data-clear]").click();

    await expect(knag.recovery()).toHaveText(/wiped 2\s*·\s*bring back/);
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

    // 🔴 Not `knag.saved()`. That helper accepts `wiped` as well as `saved`, and the
    // status still reads `wiped 2` from the sweep above — so it matched instantly and
    // waited for nothing, and the restore raced the save of the line it is supposed to
    // keep. It passed locally and failed once in CI, which is what a wait that is not a
    // wait looks like. The precondition is that the typed row reached the server, and
    // the server is the only thing that can answer that.
    await expect.poll(() => knag.document()).toContain("added after");

    await knag.page.locator("[data-restore]").click();

    await expect
      .poll(() => knag.document())
      .toBe("keep me\n- [x] done one\n- [ ] not done\n- [x] done two\n- [ ] added after");
  });

  test("withdraws the offer once taken, so it cannot run twice", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();
    await knag.page.locator("[data-restore]").click();

    await expect(knag.recovery()).toBeHidden();
    await expect.poll(() => knag.document()).toBe(MIXED);
  });

  test("survives a reload, which is most of what a phone does", async ({ knag }) => {
    await knag.seed(MIXED);
    await knag.page.locator("[data-clear]").click();
    await expect(knag.recovery()).toBeVisible();

    await knag.page.reload();

    await expect(knag.recovery()).toHaveText(/wiped 2\s*·\s*bring back/);
  });
});
