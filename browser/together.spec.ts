import { type Knag, expect, test } from "./fixtures.js";

/**
 * Pages × templates × history — the seams, not the features.
 *
 * 🔴 Each of the three has its own suite and each passes. **Every defect this project
 * shipped in the last week lived between them**: templates were built as a seed for new
 * pages rather than a page's reset state (#165), the undo duplicated every checked line
 * after a reset because two correct releases disagreed (#173), and the log could not say
 * what a page wipe took because the wipe's own diff is empty by construction (#91).
 *
 * None of those was findable from inside one feature's tests. This file exists to ask the
 * questions that only appear when all three are switched on at once, and it is deliberately
 * about *interference* — does one page's template reach another, does one page's history
 * show another's lines, does the undo still know which page it is about.
 */

const TODAY = "ring the school about Friday\n- [x] posted the form\n- [ ] book the MOT";
const SHOP_TEMPLATE = "- [ ] milk\n- [ ] eggs";
const SHOPPED = "- [ ] milk\n- [ ] eggs\n- [ ] birthday candles";

async function newPage(knag: Knag, name: string): Promise<void> {
  await knag.page.locator("[data-page-name]").click();
  await knag.page.locator("[data-manage-open]").click();
  await expect(knag.page.locator("[data-manage-pane]")).toBeVisible();
  await knag.page.locator('[data-new-page] input[name="name"]').fill(name);
  await knag.page.locator("[data-new-page-submit]").click();
  await expect(knag.page.locator("[data-page-label]")).toHaveText(name);
  await expect(knag.surface()).toBeFocused();
}

async function switchTo(knag: Knag, name: string): Promise<void> {
  await knag.page.locator("[data-page-name]").click();
  await knag.page.locator("[data-switcher-list] button", { hasText: name }).first().click();
  await expect(knag.page.locator("[data-page-label]")).toHaveText(name);
}

async function wipeThePage(knag: Knag): Promise<void> {
  await knag.openLedge();
  await knag.page.locator("[data-wipe-all]").click();
  await knag.page.locator("[data-wipe-all]").click();
  await expect(knag.recovery()).toBeVisible();
}

async function openHistory(knag: Knag): Promise<void> {
  await knag.openLedge();
  await knag.page.locator("[data-history-open]").click();
  await expect(knag.page.locator("[data-history-pane]")).toBeVisible();
}

/**
 * 🔴 Close it before touching the bar. The pane is a dialog and **the bar sits behind its
 * backdrop** — the same fact that made a refusal in the save-status slot invisible and sent
 * manage-pages' errors into the pane instead (#154). A test that reaches for the switcher
 * with a pane open hangs for thirty seconds on an element that is right there.
 */
async function closeHistory(knag: Knag): Promise<void> {
  await knag.page.locator("[data-history-back]").click();
  await expect(knag.page.locator("[data-history-pane]")).toBeHidden();
}

test.describe("pages, templates and history together", () => {
  test.afterEach(async ({ knag }) => {
    await knag.resetPages();
  });

  test("🔴 a template belongs to one page and does not reach another", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(TODAY);
    await newPage(knag, "shopping");

    await knag.setPage("shopping", SHOP_TEMPLATE);
    await knag.saveTemplate("shopping");
    await knag.setPage("shopping", SHOPPED);

    // Reset shopping: its own template comes back.
    await wipeThePage(knag);
    await expect.poll(() => knag.documentOn("shopping")).toBe(SHOP_TEMPLATE);

    // Reset today: it has no template, so it empties. If templates leaked, today would
    // come back holding somebody else's groceries.
    await switchTo(knag, "today");
    await wipeThePage(knag);
    await expect.poll(() => knag.document()).toBe("");
  });

  test("🔴 history is this page's, and never the other one's lines", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(TODAY);
    await newPage(knag, "shopping");
    await knag.setPage("shopping", SHOPPED);
    await wipeThePage(knag);

    await switchTo(knag, "today");
    await wipeThePage(knag);
    await openHistory(knag);

    // The record is this page's, always — a record across pages is an index, and there
    // is deliberately no index.
    await expect(knag.page.locator("[data-history-page]")).toHaveText("today");
    await knag.page.locator("[data-history-list] .head").first().click();
    await expect(knag.page.locator("[data-history-list]")).toContainText("ring the school");
    await expect(knag.page.locator("[data-history-list]")).not.toContainText("birthday candles");
  });

  test("🔴 the undo offer belongs to the page it was made on", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(TODAY);
    await newPage(knag, "shopping");
    await knag.setPage("shopping", SHOPPED);

    await wipeThePage(knag);

    // Switch away: shopping's offer must not follow, or `bring back` on today would put
    // the shopping list into today.
    await switchTo(knag, "today");
    await expect(knag.recovery()).toBeHidden();

    await switchTo(knag, "shopping");
    await expect(knag.recovery()).toBeVisible();
  });

  test("🔴 a reset on a second page counts only what did not come back", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(TODAY);
    await newPage(knag, "shopping");
    await knag.setPage("shopping", SHOP_TEMPLATE);
    await knag.saveTemplate("shopping");
    await knag.setPage("shopping", SHOPPED);

    await wipeThePage(knag);
    await openHistory(knag);

    // Two of three lines came straight back, so one went.
    await expect(knag.page.locator("[data-history-list] .wipe").first()).toContainText(
      /wiped page\s*·\s*1 gone/,
    );
  });

  test("🔴 putting lines back from history lands on the page you are on", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(TODAY);
    await newPage(knag, "shopping");
    await knag.setPage("shopping", SHOPPED);
    await wipeThePage(knag);

    await openHistory(knag);
    await knag.page.locator("[data-history-list] .head").first().click();
    await knag.page.locator("[data-history-list] .put-back").click();

    await expect.poll(() => knag.documentOn("shopping")).toBe(SHOPPED);

    // And today is untouched. A whole-page write to the wrong page destroys a document
    // while preserving every byte of it (#153). Asserted through the API rather than by
    // switching, so the assertion is about the data and not about the bar.
    expect(await knag.document()).toBe(TODAY);

    // Back out the way a person does, and land on the page rather than in Settings.
    await closeHistory(knag);
    await expect(knag.page.locator("[data-page-label]")).toHaveText("shopping");
  });

  test("a retired page's history is not another page's problem", async ({ knag }) => {
    await knag.resetPages();
    await knag.seed(TODAY);
    await newPage(knag, "shopping");
    await knag.setPage("shopping", SHOPPED);
    await wipeThePage(knag);

    // Delete it. Deletion is not loss — the revisions stay exactly where they are
    // (principle 4) — but they must not surface anywhere else.
    await knag.page.locator("[data-page-name]").click();
    await knag.page.locator("[data-manage-open]").click();
    await knag.page.locator("[data-manage-list] [data-delete-page]").click();
    await expect(knag.page.locator("[data-page-label]")).toHaveText("today");
    // Out of the dialog before reaching for the ledge — see `closeHistory`.
    await knag.page.locator("[data-manage-back]").click();
    await knag.page.keyboard.press("Escape");

    await openHistory(knag);

    await expect(knag.page.locator("[data-history-page]")).toHaveText("today");
    await expect(knag.page.locator("[data-history-list]")).not.toContainText("birthday candles");
  });
});
