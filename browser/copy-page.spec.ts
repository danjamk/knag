import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";

/**
 * Copying the whole page (#118).
 *
 * 🔴 The capability already existed — in the editing surface `⌘A` then copy has returned
 * the page byte-exact since v0.8.0. What is under test is not "can knag copy" but **what
 * it decided to hand over**: `body` verbatim, with nothing added and nothing stripped.
 * Anything knag prepends is a byte the user did not type, and the round trip back through
 * raw view (spec §8) only holds because there is nothing to remove on the way in.
 *
 * Clipboard *reads* are unavailable in headless WebKit, so these record what the page
 * hands to `navigator.clipboard.writeText` — the same technique as `arrange.spec.ts`, and
 * the contract worth pinning either way. Reading the OS clipboard would be testing WebKit.
 */

/**
 * A page with every byte-preservation hazard the parser has ever had to survive: two
 * marker styles, an indented child, a fence, trailing whitespace, a blank line, and a
 * trailing newline.
 */
const DOC = [
  "Thursday",
  "- [ ] call the accountant",
  "  - [x] and file the receipt",
  "* check on the shed  ",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
].join("\n");

async function watchClipboard(page: Page): Promise<void> {
  // Typed structurally rather than as a Navigator: browser/tsconfig.json carries no DOM
  // lib on purpose, because client/src is the only place in the tree where DOM exists.
  await page.evaluate(() => {
    const g = globalThis as unknown as { __copied: string[]; navigator: { clipboard: object } };
    g.__copied = [];
    Object.defineProperty(g.navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        g.__copied.push(text);
      },
    });
  });
}

const copied = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied);

async function copyPage(knag: { page: Page }): Promise<void> {
  await knag.page.locator("[data-settings-open]").click();
  await knag.page.locator("[data-copy-page]").click();
}

test.describe("copy the page", () => {
  test("🔴 hands over the document byte-for-byte, as the server has it", async ({ knag }) => {
    await knag.seed(DOC);
    await watchClipboard(knag.page);

    await copyPage(knag);

    // 🔴 Compared against `/api/doc` rather than against the constant above. The constant
    // is what was *sent*; this asserts the clipboard matches what knag actually holds, so
    // a normalisation anywhere between the two shows up here rather than agreeing with
    // itself. Markers, indentation, trailing spaces, the fence and the final newline all
    // have to survive.
    const server = await knag.page.request.get("/api/doc");
    const { body } = (await server.json()) as { body: string };

    expect(await copied(knag.page)).toEqual([body]);
  });

  test("🔴 adds nothing — no header, no metadata, no front matter", async ({ knag }) => {
    await knag.seed(DOC);
    await watchClipboard(knag.page);

    await copyPage(knag);
    const [text] = await copied(knag.page);

    // Stated as its own assertion because "byte-for-byte" above would also pass if both
    // sides gained a header. The first byte is the user's first byte.
    expect(text?.startsWith("Thursday")).toBe(true);
    expect(text?.endsWith("```\n")).toBe(true);
    expect(text).not.toContain("knag");
  });

  test("copies what the reader is looking at, including an unsaved edit", async ({ knag }) => {
    await knag.seed("Thursday\n");
    await knag.useEditor();
    await watchClipboard(knag.page);

    await knag.surface().click();
    await knag.page.keyboard.press("ControlOrMeta+End");
    await knag.page.keyboard.type("- [ ] milk");
    await knag.saved();

    await copyPage(knag);

    expect(await copied(knag.page)).toEqual(["Thursday\n- [ ] milk"]);
  });

  test("says so in the machine voice, and says so on the control", async ({ knag }) => {
    await knag.seed(DOC);
    await watchClipboard(knag.page);

    const button = knag.page.locator("[data-copy-page]");
    await copyPage(knag);

    // 🔴 On the button, not the save-status line: the sheet is modal and covers the
    // footer, so a confirmation the reader cannot see is not a confirmation. Lowercase
    // and flat, like everything else the app says about itself.
    await expect(button).toHaveText("copied");
    await expect(button).toHaveText("copy the page", { timeout: 4000 });
  });

  test("🔴 says when it did not work, rather than failing silently", async ({ knag }) => {
    await knag.seed(DOC);

    // `navigator.clipboard` rejects outside a secure context and on an untrusted gesture.
    // A copy that quietly does nothing is worse than one that admits it — you find out
    // when you paste, somewhere else, later.
    await knag.page.evaluate(() => {
      const g = globalThis as unknown as { navigator: { clipboard: object } };
      Object.defineProperty(g.navigator.clipboard, "writeText", {
        configurable: true,
        value: async () => {
          throw new Error("denied");
        },
      });
    });

    await copyPage(knag);

    await expect(knag.page.locator("[data-copy-page]")).toHaveText("not copied");
  });

  test("lives in Settings, not on the footer", async ({ knag }) => {
    await knag.seed(DOC);

    // The footer's budget is what sits permanently above the keyboard on a phone
    // (spec §7). Copying the whole page is a rare act, and rare acts live in Settings.
    await expect(knag.page.locator("footer [data-copy-page]")).toHaveCount(0);
    await expect(knag.page.locator("[data-settings] [data-copy-page]")).toHaveCount(1);
  });
});
