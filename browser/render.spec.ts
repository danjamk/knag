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

test.describe("the page is actually visible", () => {
  // 🔴 Rewritten for one surface (#113). These tested the row list: `autoGrow` sizing a
  // `<textarea>` from `scrollHeight`, one row per *block* with a fence collapsing three
  // lines into one, and a row shrinking back after a delete. None of that exists — the
  // surface has one line per line and CodeMirror owns wrapping.
  //
  // What survives is the *question* each of them asked, which had nothing to do with
  // rows: does the text render, does it wrap, and does a checked line stay where it was
  // written. The original bug is worth keeping in mind — every row was written
  // `height: 0px`, checkboxes survived, all text vanished, and it looked exactly like a
  // render failure while being invisible to the entire unit suite.

  test("🔴 every line has non-zero height on first load", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    const lines = knag.page.locator("[data-surface] .cm-line");
    const count = await lines.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const box = await lines.nth(i).boundingBox();
      expect(box, `line ${i} has no box`).not.toBeNull();
      expect(box?.height ?? 0, `line ${i} is zero-height`).toBeGreaterThan(10);
    }
  });

  test("shows the document's text, not just its structure", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    await expect(knag.editor(0)).toHaveText("Weekend Chores");
    await expect(knag.editor(1)).toHaveText("shells credit protection");
    // 🔴 The checkbox line shows its task text with the marker drawn as a widget over
    // the bytes — the `- [ ] ` is still in the document, and ADR-004 is why the widget
    // is a control rather than a rendering that replaces it.
    await expect(knag.editor(2)).toContainText("Laundry folding");
  });

  test("🔴 one line per line, so a fence is three of them", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    // The row model made a fence *one* row, because a block was the unit. Here a line is
    // the unit, which is the whole reason `leavingLines` exists for the wipe.
    await expect(knag.page.locator("[data-surface] .cm-line")).toHaveCount(8);
  });

  test("keeps a checked line struck through and in place", async ({ knag }) => {
    await knag.seed(DOC);
    await knag.useEditor();

    // No auto-sink: the checked item stays where it was written (spec §7).
    await expect(knag.editor(2)).toHaveClass(/cm-done/);
  });

  test("🔴 a long line wraps instead of truncating", async ({ knag }) => {
    await knag.seed("short");
    await knag.useEditor();
    const oneLine = (await knag.editor(0).boundingBox())?.height ?? 0;

    await knag.seed(`short\n${"a long line of prose that will certainly wrap ".repeat(6)}`);
    await knag.useEditor();
    const wrapped = (await knag.editor(1).boundingBox())?.height ?? 0;

    expect(wrapped).toBeGreaterThan(oneLine * 1.5);
  });
});

test.describe("the toolbar", () => {
  test("🔴 the arrange control keeps one drawing across a round trip", async ({ knag }) => {
    // It used to write the word "reorder" on the way out, and later swapped the glyph
    // for a tick — so the button changed shape the first time it was used. Now only
    // its *state* changes, which is also what carries the pressed tint: the mode has
    // to be legible from the bar, because in it the page looks like a page you cannot
    // type in, which is exactly what it is.
    const button = knag.page.locator("[data-reorder]");
    await knag.openLedge();
    const drawing = await button.locator("svg").innerHTML();
    await expect(button).toHaveAttribute("aria-pressed", "false");

    await knag.arrange();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    expect(await button.locator("svg").innerHTML()).toBe(drawing);

    await knag.arrange();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    expect(await button.locator("svg").innerHTML()).toBe(drawing);
  });


  test("🔴 keeps tier 1 to two visible controls, ledge or no ledge", async ({ knag }) => {
    await knag.seed("- [x] done\nplain");

    // 🔴 **Visible**, not present. The bar's markup carries conditional controls that
    // ship `hidden` — clear-done, and the post-wipe undo (#59) — and counting elements
    // would either block them or force this number up every time one is added. What the
    // rule actually protects is how much chrome sits above the keyboard, and that is
    // what is asserted.
    //
    // The markup-level half of the rule lives in `worker/test/shell.test.ts`, which pins
    // that only one control is permanent and that every other one ships hidden. Both
    // halves are needed: this one cannot see the markup, that one cannot see the screen.
    //
    // Three is the maximum, reached here because there is something to sweep: the page's
    // name, the wipe and the chevron. It was three before #139 too — arrange and settings
    // left for the ledge, which cost one control and gave back two — and the third came
    // back in #154 when the page's name became the switcher's control.
    //
    // 🔴 That third one **took no space**: the slot was already occupied by a `<span>`
    // reading `today`, which is what the wordmark left the bar to pay for (#123). The
    // budget this protects is chrome above the keyboard, so what matters is that the bar
    // did not get taller or busier — not the count on its own.
    await expect(knag.page.locator(".bar button:visible")).toHaveCount(3);

    // 🔴 Asserted on the ledge's own box, not on `footer button:visible`. A closed ledge
    // is `height: 0` with `overflow: hidden`, and a clipped child still reports a 48px
    // bounding box — so `:visible` counts all four of them and this test read 6. The
    // container is the thing with no height, and it is what catches a ledge shipped
    // open, which is the only way a second tier could quietly become permanent chrome
    // above the keyboard. What keeps the clipped buttons out of reach is `inert`, pinned
    // in `ledge.spec.ts`, because clipping alone leaves them in the tab order.
    await expect(knag.ledge()).not.toBeVisible();

    await knag.openLedge();
    await expect(knag.page.locator("[data-ledge] button:visible")).toHaveCount(4);
  });

  test("shows no controls on a row until reorder mode", async ({ knag }) => {
    await knag.seed("- [ ] a task");

    await expect(knag.page.locator("[data-rows] .copy")).toHaveCount(0);
    await expect(knag.page.locator("[data-rows] .grip")).toHaveCount(0);

    await knag.arrange();
    await expect(knag.page.locator("[data-rows] .grip")).toHaveCount(1);
    await expect(knag.page.locator("[data-rows] .copy")).toHaveCount(1);
    await expect(knag.page.locator("[data-rows] .remove")).toHaveCount(1);
  });
});

test.describe("settings", () => {
  test("opens, and switches board live", async ({ knag }) => {
    await knag.openSettings();
    const dialog = knag.page.locator("[data-settings]");
    await expect(dialog).toBeVisible();

    await dialog.locator('[data-theme-set="whiteboard"]').click();
    await expect(knag.page.locator("html")).toHaveAttribute("data-theme", "whiteboard");

    await dialog.locator('[data-theme-set="slate"]').click();
    await expect(knag.page.locator("html")).toHaveAttribute("data-theme", "slate");
  });


  test("carries the build info that used to sit in the footer", async ({ knag }) => {
    await knag.openSettings();

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
