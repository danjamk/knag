import { Knag, expect, test } from "./fixtures.js";

/**
 * Rendering and geometry — what the vitest suite structurally cannot reach.
 *
 * Every test here corresponds to a bug that shipped and was found by a human on a
 * phone. None of them were catchable by 263 passing unit tests.
 */

const DOC = [
  "Weekend Chores",
  "- [ ] shells credit protection",
  "- [x] Laundry folding",
  "",
  "```js",
  "const x = 1;",
  "```",
  "  - [ ] nested item",
].join("\n");

test.describe("rows are actually visible", () => {
  test("🔴 every row has non-zero height on first load", async ({ knag }) => {
    // The bug: `autoGrow` sizes from `scrollHeight`, a hidden element reports 0, and
    // the first paint happened before the container was shown — so every row was
    // written `height: 0px`. Checkboxes survived; all text vanished.
    //
    // It looked exactly like the text failing to render, self-corrected on the first
    // keystroke, and was invisible to the whole unit suite.
    await knag.seed(DOC);

    const editors = knag.page.locator("[data-rows] .text, [data-rows] .fence");
    const count = await editors.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const box = await editors.nth(i).boundingBox();
      expect(box, `row ${i} has no box`).not.toBeNull();
      expect(box?.height ?? 0, `row ${i} is zero-height`).toBeGreaterThan(10);
    }
  });

  test("shows the document's text, not just its structure", async ({ knag }) => {
    await knag.seed(DOC);

    await expect(knag.editor(0)).toHaveValue("Weekend Chores");
    await expect(knag.editor(1)).toHaveValue("shells credit protection");
    // A checkbox row's editor holds the task text, never the `- [ ] ` prefix.
    await expect(knag.editor(2)).toHaveValue("Laundry folding");
  });

  test("renders one row per block, with a fence as a single row", async ({ knag }) => {
    await knag.seed(DOC);

    // 8 lines, but the fence collapses 3 into 1 → 6 rows.
    await expect(knag.rows()).toHaveCount(6);
    await expect(knag.editor(4)).toHaveValue("```js\nconst x = 1;\n```");
  });

  test("keeps a checked row struck through and in place", async ({ knag }) => {
    await knag.seed(DOC);

    // No auto-sink: the checked item stays where it was written (spec §7).
    await expect(knag.rows().nth(2)).toHaveClass(/checked/);
    await expect(knag.editor(2)).toHaveCSS("text-decoration-line", "line-through");
  });
});

test.describe("wrapping", () => {
  test("🔴 a long row grows instead of truncating", async ({ knag }) => {
    await knag.seed("short");
    const oneLine = (await knag.editor(0).boundingBox())?.height ?? 0;

    await knag.seed(`short\n${"a long line of prose that will certainly wrap ".repeat(6)}`);
    const wrapped = (await knag.editor(1).boundingBox())?.height ?? 0;

    expect(wrapped).toBeGreaterThan(oneLine * 1.5);
  });

  test("shrinks back when the text is deleted", async ({ knag }) => {
    // The reset-to-auto-then-measure two-step. Measuring against the current height
    // only ever grows, so a row would stay tall forever.
    await knag.seed("x".repeat(400));
    const tall = (await knag.editor(0).boundingBox())?.height ?? 0;

    await knag.editor(0).fill("short again");
    const short = (await knag.editor(0).boundingBox())?.height ?? 0;

    expect(tall).toBeGreaterThan(short * 1.5);
  });
});

test.describe("the toolbar", () => {
  test("🔴 the reorder control stays an icon across a round trip", async ({ knag }) => {
    // It used to write the word "reorder" on the way out, so the button changed
    // shape the first time it was used and never changed back.
    const button = knag.page.locator("[data-reorder]");
    await expect(button).toHaveText("⇅");

    await button.click();
    await expect(button).toHaveText("✓");

    await button.click();
    await expect(button).toHaveText("⇅");
  });

  test("keeps the footer to three controls", async ({ knag }) => {
    await knag.seed("- [x] done\nplain");
    // Clear-done appears only when there is something to sweep, so this is the
    // maximum: clear, reorder, settings.
    await expect(knag.page.locator("footer button")).toHaveCount(3);
  });

  test("shows no controls on a row until reorder mode", async ({ knag }) => {
    await knag.seed("- [ ] a task");

    await expect(knag.page.locator("[data-rows] .copy")).toHaveCount(0);
    await expect(knag.page.locator("[data-rows] .grip")).toHaveCount(0);

    await knag.page.locator("[data-reorder]").click();
    await expect(knag.page.locator("[data-rows] .grip")).toHaveCount(1);
    await expect(knag.page.locator("[data-rows] .copy")).toHaveCount(1);
    await expect(knag.page.locator("[data-rows] .remove")).toHaveCount(1);
  });
});

test.describe("settings", () => {
  test("opens, and switches theme live", async ({ knag }) => {
    await knag.page.locator("[data-settings-open]").click();
    const dialog = knag.page.locator("[data-settings]");
    await expect(dialog).toBeVisible();

    await dialog.locator('[data-theme-set="light"]').click();
    await expect(knag.page.locator("html")).toHaveAttribute("data-theme", "light");

    await dialog.locator('[data-theme-set="dark"]').click();
    await expect(knag.page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("carries the build info that used to sit in the footer", async ({ knag }) => {
    await knag.page.locator("[data-settings-open]").click();

    await expect(knag.page.locator("[data-build-version]")).toHaveText("0.0.0-browser");
    await expect(knag.page.locator("[data-build-env]")).toHaveText("local");
  });
});

test.describe("the dev badge", () => {
  test("is visible whenever this is not production", async ({ knag }) => {
    // Dev holds test content only and sits behind no rate-limit rule. You should
    // never have to go looking to find out which one you are typing into.
    await expect(knag.page.locator("footer .env")).toBeVisible();
  });
});

test("logs in over plain http, where the cookie must drop Secure", async ({ page }) => {
  // 🔴 Safari refuses to store a `Secure` cookie on http://localhost, so `issueSession`
  // omits it there (spec §5). That branch is unreachable from any deployment and has
  // never been exercised until now — if it regressed, local development would simply
  // stop being able to log in.
  const knag = new Knag(page);
  await knag.login();

  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === "knag_session");
  expect(session).toBeDefined();
  expect(session?.secure).toBe(false);
  expect(session?.httpOnly).toBe(true);
});
