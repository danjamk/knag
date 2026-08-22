import { expect, test } from "./fixtures.js";

/**
 * Pages, on screen (#154).
 *
 * 🔴 The rule this file defends is **knag has no index**. There is no screen that lists
 * your pages, only a control that switches between them, and it is never what you land
 * on — launch opens the last page you were on. Everything a switcher could grow that
 * makes it a file manager is asserted absent here, because absence is what nothing else
 * catches.
 */

const DAY = ["Thursday", "- [ ] call the accountant", "- [x] pay the invoice", ""].join("\n");
const PHONE = { width: 393, height: 852 };

// 🔴 One live database, no reset between tests. A page created here outlives the test
// that made it, and the next request for the same name fails on a duplicate — with an
// error about uniqueness rather than about the thing that actually went wrong.
test.beforeEach(async ({ knag }) => {
  await knag.resetPages();
});

/** Make a page through the real controls, the way a person does. */
test.describe("the switcher", () => {
  test("🔴 opens from the page's name, which is the slot the wordmark paid for", async ({
    knag,
  }) => {
    await knag.seed(DAY);

    await expect(knag.page.locator("[data-switcher]")).not.toBeVisible();
    await knag.page.locator("[data-page-name]").click();

    await expect(knag.page.locator("[data-switcher]")).toBeVisible();
    await expect(knag.page.locator("[data-page-name]")).toHaveAttribute("aria-expanded", "true");
  });

  test("🔴 marks the current page in amber and nothing else", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");

    await knag.page.locator("[data-page-name]").click();
    const rows = knag.page.locator("[data-switcher-list] button");
    await expect(rows).toHaveCount(2);

    // The amber *is* the marker — no tick, no dot, no second colour. Same rule the
    // checked checkbox and the machine voice follow.
    await expect(rows.filter({ hasText: "shopping" })).toHaveAttribute("aria-current", "true");
    await expect(rows.filter({ hasText: "today" })).toHaveAttribute("aria-current", "false");
  });

  test("🔴 carries no counts, no timestamps, no icons — a column is a file manager", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");
    await knag.page.locator("[data-page-name]").click();

    const row = knag.page.locator("[data-switcher-list] button").first();
    // The row is its name. Anything else you add is a column, and a column is the first
    // step to the file manager §12 exists to keep out.
    await expect(row).toHaveText("today");
    await expect(row.locator("svg, img")).toHaveCount(0);
  });

  test("closes when the document takes focus, like the ledge", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();
    await knag.page.locator("[data-page-name]").click();
    await expect(knag.page.locator("[data-switcher]")).toBeVisible();

    await knag.editor(0).click();

    // Going back to the page closes what is over it. One sentence, both tiers.
    await expect(knag.page.locator("[data-switcher]")).not.toBeVisible();
  });

  test("closes on Escape, which a drop-up gets from nowhere else", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.page.locator("[data-page-name]").click();
    await expect(knag.page.locator("[data-switcher]")).toBeVisible();

    await knag.page.keyboard.press("Escape");

    await expect(knag.page.locator("[data-switcher]")).not.toBeVisible();
  });
});

test.describe("switching", () => {
  test("🔴 shows the other page's document, and the bar says which", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");

    // The new page is empty and is now the open one.
    await expect(knag.page.locator("[data-page-label]")).toHaveText("shopping");
    await expect(knag.lines()).toHaveCount(1);

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-switcher-list] button", { hasText: "today" }).click();

    await expect(knag.page.locator("[data-page-label]")).toHaveText("today");
    await expect(knag.surface()).toContainText("call the accountant");
  });

  test("🔴 writes land on the page you are looking at", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");

    await knag.surface().click();
    await knag.page.keyboard.type("milk");
    await knag.saved();

    // 🔴 The whole point of the page dimension. The seeded document must be untouched —
    // a whole-page write that landed on the wrong page would preserve every byte it was
    // given and destroy the other document.
    expect(await knag.document()).toBe(DAY);
  });

  test("🔴 launch opens the last page you were on, never a list", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");

    await knag.page.reload();

    // Spec §12. There is no index and nothing to pick from on the way in — the page you
    // left is the page you get.
    await expect(knag.page.locator("[data-page-label]")).toHaveText("shopping");
    await expect(knag.page.locator("[data-switcher]")).not.toBeVisible();
  });
});

test.describe("managing", () => {
  test("renames a page, and the bar follows", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shoping");

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();

    // 🔴 Wait for the list to have arrived before typing into it. Without this the
    // test races `loadPages`, which is the very thing the repaint guard now prevents —
    // and a test that depends on the bug not happening cannot also be the test for it.
    await expect(knag.page.locator("[data-manage-list] li")).toHaveCount(2);

    const field = knag.page.locator('[data-manage-list] input[data-rename-id]').last();
    await field.fill("shopping");
    // Commits on blur, like any field — never a write per keystroke against the name an
    // agent resolves by (#153).
    await field.blur();

    await expect(knag.page.locator("[data-manage-list] input").last()).toHaveValue("shopping");
  });

  test("🔴 a list refresh does not throw away what you are typing", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shoping");

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await expect(knag.page.locator("[data-manage-list] li")).toHaveCount(2);

    const field = knag.page.locator('[data-manage-list] input[data-rename-id]').last();
    await field.click();
    await field.fill("shopping");

    // 🔴 Toggling a template on **another row** runs the whole mutate → reload →
    // repaint path while this field still holds focus and an uncommitted value. Before the
    // guard, `replaceChildren` put `shoping` back with no error and no explanation — which
    // is exactly how it failed in CI, where `loadPages` resolved after the first keystroke
    // rather than before it.
    //
    // Dispatched rather than clicked: a click would blur the field first and commit the
    // rename, which is the one thing that would hide the bug.
    await knag.page.locator("[data-manage-list] [data-template-id]").first().dispatchEvent("click");
    await knag.page.waitForTimeout(600);

    await expect(field).toBeFocused();
    await expect(field).toHaveValue("shopping");
  });

  test("🔴 offers no delete on the default page", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();

    const rows = knag.page.locator("[data-manage-list] li");
    await expect(rows).toHaveCount(2);
    // Absent, not disabled. It cannot be deleted — that is structural rather than a
    // permission — and a control that is present and refuses has to explain itself.
    await expect(rows.nth(0).locator("[data-delete-page]")).toHaveCount(0);
    await expect(rows.nth(1).locator("[data-delete-page]")).toHaveCount(1);
  });

  test("🔴 deletes without asking, and lands you back on the default page", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();

    await knag.page.locator("[data-manage-list] [data-delete-page]").click();

    // No dialog, and the reason that is honest is in the schema: the page is retired,
    // every revision it ever had stays where it is, and recovering it is clearing one
    // column (principle 4).
    await expect(knag.page.locator("[data-manage-list] li")).toHaveCount(1);
    await expect(knag.page.locator("[data-page-label]")).toHaveText("today");
    expect(await knag.document()).toBe(DAY);
  });

  test("🔴 says why, in the pane — the bar is behind the backdrop", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await knag.page.locator('[data-new-page] input[name="name"]').fill("SHOPPING");
    await knag.page.locator("[data-new-page-submit]").click();

    // 🔴 The refusal was always correct and completely invisible: it went to the
    // save-status slot in the bar, which sits behind the dialog backdrop, so the control
    // read as broken rather than as having said no. Found by looking at a screenshot.
    const error = knag.page.locator("[data-manage-error]");
    await expect(error).toBeVisible();
    await expect(error).toContainText("already a page called");

    // And nothing was created — the refusal is real, not just legible.
    await expect(knag.page.locator("[data-manage-list] li")).toHaveCount(2);
    // The text stays put, so fixing it is an edit rather than a retype.
    await expect(knag.page.locator('[data-new-page] input[name="name"]')).toHaveValue("SHOPPING");
  });

  test("clears the message on the way back out, so it never outlives its cause", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await knag.page.locator('[data-new-page] input[name="name"]').fill("shopping");
    await knag.page.locator("[data-new-page-submit]").click();
    await expect(knag.page.locator("[data-manage-error]")).toBeVisible();

    // Back lands on the settings pane, so the way in again is the whole route: out of the
    // dialog, into the switcher, into the pane. Asserted through the real path rather than
    // by toggling the pane directly — `manage pages` only exists in the switcher.
    await knag.page.locator("[data-manage-back]").click();
    await knag.page.keyboard.press("Escape");
    // Same assumption as `newPage`'s, by a different route (#177): the dialog has to be
    // *gone* before the switcher opens, or the focus the close returns lands afterwards
    // and shuts it again. Not observed failing — hardened because it is the same shape.
    await expect(knag.page.locator("[data-settings]")).not.toBeVisible();
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();

    await expect(knag.page.locator("[data-manage-error]")).not.toBeVisible();
  });

  test("🔴 a page name cannot differ from another by whitespace alone", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.newPage("my list");

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await knag.page.locator('[data-new-page] input[name="name"]').fill("my   list");
    await knag.page.locator("[data-new-page-submit]").click();

    // Two rows reading `my list` in the switcher would be indistinguishable on screen and
    // ambiguous to an agent resolving by name. Collapsed on the server, so both surfaces
    // get the same answer.
    await expect(knag.page.locator("[data-manage-error]")).toBeVisible();
    await expect(knag.page.locator("[data-manage-list] li")).toHaveCount(2);
  });

  test("🔴 back goes to the switcher, which is where you came from", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await expect(knag.page.locator("[data-manage-pane]")).toBeVisible();

    await knag.page.locator("[data-manage-back]").click();

    // 🔴 It used to swap to the settings pane — a surface you were never on. The devices
    // pane returns to Settings because that is where *it* came from; this inherited the
    // behaviour without inheriting the reason (#165).
    await expect(knag.page.locator("[data-settings]")).not.toBeVisible();
    await expect(knag.page.locator("[data-switcher]")).toBeVisible();
  });

  test("the sheet still does not scroll with the pane in it", async ({ knag }) => {
    await knag.page.setViewportSize(PHONE);
    await knag.seed(DAY);
    await knag.newPage("shopping");
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();

    const box = await knag.page
      .locator("[data-settings]")
      .evaluate((el: { scrollHeight: number; clientHeight: number }) => ({
        scroll: el.scrollHeight,
        client: el.clientHeight,
      }));
    expect(box.scroll).toBeLessThanOrEqual(box.client);
  });
});

test.describe("🔴 the template is a page's reset state", () => {
  const STANDING = ["- [ ] milk", "- [ ] eggs", ""].join("\n");

  test("wiping the page brings the standing items back, unchecked", async ({ knag }) => {
    await knag.seed(STANDING);
    await knag.useEditor();

    // Save the baseline through the real control.
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    const toggle = knag.page.locator("[data-manage-list] [data-template-id]").first();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await knag.page.keyboard.press("Escape");

    // Shop: check things off and add one thing you only wanted this week.
    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+a");
    await knag.page.keyboard.type("- [x] milk\n- [x] eggs\n- [x] birthday candles\n");
    await knag.saved();

    await knag.openLedge();
    await knag.page.locator("[data-wipe-all]").click();
    await knag.page.locator("[data-wipe-all]").click();

    // 🔴 The whole feature, in one assertion: back to the baseline, unchecked, with the
    // one-off gone. Read from the server rather than the screen — a reset that normalised
    // a byte would look identical rendered.
    await expect.poll(() => knag.document(), { timeout: 8000 }).toBe(STANDING);
  });

  test("the control keeps saying `wipe page`, template or not", async ({ knag }) => {
    await knag.seed(STANDING);
    await knag.openLedge();
    // `wipe page 3` that leaves three lines behind is a lie about what the control does,
    // and the count beside it makes the lie specific.
    await expect(knag.page.locator("[data-wipe-all-label]")).toHaveText("wipe page");

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await knag.page.locator("[data-manage-list] [data-template-id]").first().click();
    await knag.page.keyboard.press("Escape");

    await knag.openLedge();
    // 🔴 One verb, reverted 2026-08-22 after using it. #165 made this read `reset
    // page` because `wipe page 25` leaving twenty items behind is a lie about the
    // control. True, but the fix was in the wrong place — wiping is the product's one
    // gesture and a second verb for the same act costs more than the precision. The
    // honesty lives in the count now: the recovery line says `wiped page · 5 gone`.
    await expect(knag.page.locator("[data-wipe-all-label]")).toHaveText("wipe page");
  });
});

test.describe("the undo offer", () => {
  test("🔴 belongs to the page it was taken on", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.newPage("shopping");

    await knag.surface().click();
    await knag.page.keyboard.type("- [x] milk");
    await knag.saved();
    await knag.page.locator("[data-clear]").click();
    await expect(knag.page.locator("[data-recovery]")).toBeVisible();

    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-switcher-list] button", { hasText: "today" }).click();

    // 🔴 One localStorage key was a bug the moment there were two pages: wipe the
    // shopping list, switch to today, and today would offer to bring the shopping list
    // back — into today.
    await expect(knag.page.locator("[data-recovery]")).not.toBeVisible();
  });
});
