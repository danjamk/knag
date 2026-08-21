import { expect, test } from "./fixtures.js";

/**
 * History — the record, and the surface that argues with the Out list (#91).
 *
 * 🔴 Its own file rather than an addition to `wipe.spec.ts`, for the reason #69 documents:
 * a spec file past roughly fifteen tests starts tripping the wrangler dev-server defect,
 * and `wipe.spec.ts` is already at twenty-one.
 *
 * What these pin is the distinction the design won on: **rows are wipes, not lines.** A
 * list of lines is a document; a list of wipes is chrome about an action. One wipe's lines
 * at a time is what keeps search out of the product, so the assertions below are about
 * what is *not* on screen as much as about what is.
 */

const PAGE = "Kingspan 70mm quoted 2wks\n- [x] done thing\n- [ ] undone thing";
const TEMPLATE = "- [ ] milk\n- [ ] eggs";

async function wipeThePage(knag: import("./fixtures.js").Knag): Promise<void> {
  await knag.openLedge();
  await knag.page.locator("[data-wipe-all]").click();
  await knag.page.locator("[data-wipe-all]").click();
  // 🔴 The second click starts the wipe; it does not finish it. Opening history before
  // the write lands reads the record from *before* the wipe, and the row comes back empty
  // — which reads as a restore bug and is a test bug. The recovery line arriving is the
  // signal that the server has answered.
  await expect(knag.recovery()).toBeVisible();
}

async function openHistory(knag: import("./fixtures.js").Knag): Promise<void> {
  await knag.openLedge();
  await knag.page.locator("[data-history-open]").click();
  await expect(knag.page.locator("[data-history-pane]")).toBeVisible();
}

test.describe("history", () => {
  test.afterEach(async ({ knag }) => {
    await knag.resetPages();
  });

  test("🔴 lists wipes, and shows no line until a row is opened", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);

    await openHistory(knag);

    // One row for the wipe. The lines exist in the record and are not on screen — that
    // is the cap, and it is structural rather than a policy: the markup for a week of
    // lines never exists at once, so there is nothing for a search field to point at.
    // 🔴 Not a row *count*. The browser suite runs against one live database and
    // `resetPages` clears pages and templates, not the revision log — so history is
    // cumulative across the whole run and any test asserting "one row" is asserting the
    // order the files happened to run in.
    await expect(knag.page.locator("[data-history-list] .wipe").first()).toBeVisible();
    await expect(knag.page.locator("[data-history-list] .lines")).toHaveCount(0);
    await expect(knag.page.locator("[data-history-list]")).not.toContainText("Kingspan");
  });

  test("🔴 a page wipe's row carries the note, which cleared_items never could", async ({
    knag,
  }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await openHistory(knag);

    await knag.page.locator("[data-history-list] .head").first().click();

    // The whole point of the feature. A note has no done state, so it is not in the
    // done-record — before #91 it was not anywhere.
    const lines = knag.page.locator("[data-history-list] .lines li");
    await expect(lines).toHaveCount(3);
    await expect(knag.page.locator("[data-history-list]")).toContainText("Kingspan 70mm quoted 2wks");
  });

  test("names the wipe by scope, and counts what went", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await openHistory(knag);

    await expect(knag.page.locator("[data-history-list] .wipe").first()).toContainText(
      /wiped page\s*·\s*3 gone/,
    );
  });

  test("🔴 a reset reads as a reset, and counts only what did not come back", async ({
    knag,
  }) => {
    await knag.resetPages();
    await knag.seed(TEMPLATE);
    await knag.saveTemplate();
    await knag.seed(`${TEMPLATE}\n- [ ] one off`);

    await wipeThePage(knag);
    await expect.poll(() => knag.document()).toBe(TEMPLATE);
    await openHistory(knag);

    // Two lines came straight back, so one went. `wiped 3` would be true about the
    // operation and false about the outcome.
    await expect(knag.page.locator("[data-history-list] .wipe").first()).toContainText(
      /reset\s*·\s*1 gone/,
    );
  });

  test("🔴 a sweep's lines come from the done-record, exactly", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);

    await knag.page.locator("[data-clear]").click();
    await expect.poll(() => knag.document()).not.toContain("- [x] done thing");

    await openHistory(knag);
    await knag.page.locator("[data-history-list] .head").first().click();

    // Only the ticked line. A sweep takes only what you told it to take, and `cleared`
    // is exact for it — where the page-wipe row reads a diff that is blind to a
    // duplicate being removed.
    const lines = knag.page.locator("[data-history-list] .lines li");
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText("done thing");
  });

  test("🔴 puts a wipe's lines back on the page, at the end", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await openHistory(knag);

    await knag.page.locator("[data-history-list] .head").first().click();
    await knag.page.locator("[data-history-list] .put-back").click();

    // Content over position: an older row carries lines and no anchors, so they land at
    // the end. A line you went looking for is not less useful at the bottom.
    await expect.poll(() => knag.document()).toBe(PAGE);
  });

  test("the offer withdraws once taken, so a second tap cannot double the page", async ({
    knag,
  }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await openHistory(knag);

    await knag.page.locator("[data-history-list] .head").first().click();
    const back = knag.page.locator("[data-history-list] .put-back");
    await back.click();

    await expect(back).toBeDisabled();
    await expect.poll(() => knag.document()).toBe(PAGE);
  });

  test("names the page it is the record of", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await openHistory(knag);

    // The record is this page's, always. There is no combined view, because a record
    // across nine pages is an index and there is deliberately no index.
    await expect(knag.page.locator("[data-history-page]")).toHaveText("today");
  });

  test("🔴 the recovery line's count is a second door to the same pane", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await expect(knag.recovery()).toBeVisible();

    await knag.page.locator("[data-recovery-count]").click();

    // Costs no new chrome, because the words are already there — the count is the same
    // fact the pane is a list of.
    await expect(knag.page.locator("[data-history-pane]")).toBeVisible();
  });

  test("🔴 `bring back` beside it is still the one-tap undo, not the door", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(PAGE);
    await wipeThePage(knag);
    await expect(knag.recovery()).toBeVisible();

    await knag.page.locator("[data-restore]").click();

    // The offer and the door sit on one line and must not be the same control.
    await expect(knag.page.locator("[data-history-pane]")).toBeHidden();
    await expect.poll(() => knag.document()).toBe(PAGE);
  });

  test("a page never wiped shows the seam and nothing else", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed("nothing has happened here");

    await openHistory(knag);

    await expect(knag.page.locator("[data-history-list] .wipe")).toHaveCount(0);
    await expect(knag.page.locator("[data-history-note]")).toContainText("ask your agent for older");
  });
});
