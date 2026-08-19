import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * Text size and About (#92).
 *
 * 🔴 `view.test.ts` already proves the preference *validates* — the floor holds against a
 * hostile stored value, storage throwing does not take the app down. None of that is
 * repeated here. What only a rendered page can answer is whether the token override
 * actually reaches the text, whether it survives a reload, and whether it leaves the
 * chrome alone — which is the decision this feature turns on.
 */

const DAY = ["Thursday", "- [ ] call the accountant", ""].join("\n");

/** Computed style, via `ownerDocument.defaultView` — browser/tsconfig has no DOM lib. */
type Styled = { ownerDocument: { defaultView: unknown } };
type View = { getComputedStyle: (e: unknown) => { getPropertyValue: (p: string) => string } };

async function css(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el: Styled, prop: string) =>
      (el.ownerDocument.defaultView as View).getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

const px = (value: string) => Number.parseFloat(value);

async function setSize(knag: { page: import("@playwright/test").Page }, size: number) {
  await knag.page.locator("[data-settings-open]").click();
  await knag.page.locator(`[data-font-size="${size}"]`).click();
  await knag.page.keyboard.press("Escape");
}

test.describe("text size", () => {
  test("🔴 moves the page text, and only the page text", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.useEditor();

    const line = knag.page.locator("[data-surface] .cm-line").first();
    const status = knag.page.locator("[data-save-status]");

    const pageBefore = px(await css(line, "font-size"));
    const chromeBefore = px(await css(status, "font-size"));

    await setSize(knag, 20);

    // 🔴 The whole decision this feature turns on. Someone raising the reading size wants
    // more room for the document, not a louder footer — so the machine voice must not
    // move with it. Asserted on computed pixels rather than on a class or a token name,
    // because a rule that stopped applying would leave both intact and neither working.
    expect(px(await css(line, "font-size"))).toBeGreaterThan(pageBefore);
    expect(px(await css(status, "font-size"))).toBe(chromeBefore);
  });

  test("🔴 moves the row list too, so switching views does not resize the page", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await setSize(knag, 20);

    const row = knag.page.locator("[data-rows] textarea").first();
    const inEditor = px(await css(row, "font-size"));

    await knag.useEditor();
    const inSurface = px(await css(knag.page.locator("[data-surface] .cm-line").first(), "font-size"));

    // Both surfaces read `--size-row`. If one had kept a literal, changing view would
    // resize the document under the reader.
    expect(inSurface).toBe(inEditor);
    expect(inEditor).toBe(20);
  });

  test("🔴 never goes below 16px, because iOS zooms on focus and never returns", async ({
    knag,
  }) => {
    await knag.seed(DAY);
    await knag.page.locator("[data-settings-open]").click();

    // The control offers no step below the floor. It scales up from 16 or not at all —
    // anyone wanting smaller text wants a smaller device.
    const offered = await knag.page.locator("[data-font-size]").allTextContents();
    expect(offered).toEqual(["16", "18", "20"]);

    // And a stored value below it does not reach the page even if one gets written.
    await knag.page.evaluate(() => localStorage.setItem("knag.fontSize", "11"));
    await knag.page.reload();
    await expect(knag.page.locator("[data-editor]")).toBeVisible();

    const row = knag.page.locator("[data-rows] textarea").first();
    expect(px(await css(row, "font-size"))).toBe(16);
  });

  test("survives a reload, like the board does", async ({ knag }) => {
    await knag.seed(DAY);
    await setSize(knag, 18);

    await knag.page.reload();
    await expect(knag.page.locator("[data-editor]")).toBeVisible();

    const row = knag.page.locator("[data-rows] textarea").first();
    expect(px(await css(row, "font-size"))).toBe(18);
    // And the control shows which one is active when the sheet is reopened.
    await knag.page.locator("[data-settings-open]").click();
    await expect(knag.page.locator('[data-font-size="18"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("the footer, after the bump", () => {
  test("🔴 hits the 44px touch target, which is what 'too small' meant", async ({ knag }) => {
    await knag.seed(DAY);

    // It was 28px. Apple's HIG minimum for a touch target is 44pt, and the complaint that
    // the icons were too small on every device was a hit-target problem wearing a visual
    // complaint's clothes — so this is asserted against the standard, not against taste.
    for (const control of ["[data-reorder]", "[data-settings-open]"]) {
      const box = await knag.page.locator(control).boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test("does not follow the reading preference", async ({ knag }) => {
    await knag.seed(DAY);
    const glyph = knag.page.locator("[data-settings-open]");
    const before = await glyph.boundingBox();

    await setSize(knag, 20);

    expect((await glyph.boundingBox())?.height).toBe(before?.height);
  });
});

test.describe("About", () => {
  test("says what knag is, and links out without duplicating Build", async ({ knag }) => {
    await knag.seed(DAY);
    await knag.page.locator("[data-settings-open]").click();

    const about = knag.page.locator("[data-settings] section", { hasText: "About" });
    await expect(about).toContainText("MIT");
    await expect(about.locator("a")).toHaveAttribute("href", "https://github.com/danjamk/knag");

    // 🔴 `rel` alongside `target="_blank"`, or the opened page gets a handle on this one
    // through `window.opener` — on a page that holds a live session.
    await expect(about.locator("a")).toHaveAttribute("rel", /noopener/);

    // Build says version, environment, commit, deployed. About is the human-voice half of
    // the same idea and must not repeat it.
    await expect(about).not.toContainText("version");
  });
});
