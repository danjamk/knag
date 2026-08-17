import { expect, test } from "./fixtures.js";

/**
 * The typing model, where only a real browser can reach it (#83, #85).
 *
 * Every test here is a caret or a race — two things the pure suite in `client/test/`
 * is structurally blind to. `edit.ts` is pure precisely so its *decisions* can be
 * tested without a DOM; what it cannot tell you is whether the caret survived the
 * repaint that applied them, or whether two of them raced each other to the server.
 *
 * Moving the caret between rows lives in `arrows.spec.ts` (#84, #88), split out when
 * this file reached eighteen tests — see the note at the top of that file.
 */

const DOC = "first line\nsecond line\nthird line";

test.describe("typing fast", () => {
  test("🔴 keeps the caret through a burst of Enters", async ({ knag }) => {
    // The bug, reported from real use: hitting return quickly a few times makes the
    // cursor disappear. It is not a rendering problem — it is the app conflicting with
    // its own previous save, taking a 409, and repainting the whole document out from
    // under the caret.
    await knag.seed(DOC);

    const row = knag.editor(0);
    await row.click();
    await row.press("End");

    for (let i = 0; i < 6; i++) await knag.page.keyboard.press("Enter");

    // The caret is still somewhere in the document.
    await expect
      .poll(() => knag.focusedRowIndex(), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(0);
  });

  test("🔴 never says the page changed elsewhere when nothing else touched it", async ({
    knag,
  }) => {
    // `reloaded · it changed elsewhere` comes from a 409 and nowhere else. With one
    // device and one operator there is nothing to conflict with — so seeing it at all
    // means the app raced itself, and the "elsewhere" was its own keystroke.
    await knag.seed(DOC);

    const row = knag.editor(0);
    await row.click();
    await row.press("End");

    for (let i = 0; i < 6; i++) await knag.page.keyboard.press("Enter");
    await knag.saved();

    await expect(knag.page.locator("[data-save-status]")).not.toHaveText(/reloaded/);
  });

  test("🔴 lands every keystroke of a burst, in order", async ({ knag }) => {
    // The half that matters more than the caret. A 409 resolves by loading the server's
    // copy over the local one, so a save that lost the race takes its keystrokes with
    // it — silently, because the status line calls it a reload rather than a loss.
    await knag.seed("start");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await row.pressSequentially("\nalpha\nbeta\ngamma", { delay: 15 });

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("start\nalpha\nbeta\ngamma");
  });

  test("a chain of line merges keeps the caret and lands intact", async ({ knag }) => {
    // The deletion half of the report. 🔴 **This does not reproduce the race** and is not
    // labelled as if it does: `placeCaret` clicks, and a Playwright click round-trip is
    // an order of magnitude slower than a save against localhost, so the writes never
    // overlap. Confirmed — it stays green with the serialisation removed.
    //
    // What it does guard is the merge chain itself and the caret that has to survive
    // three repaints of it. The race is reproduced by the Enter bursts above, both of
    // which go red without the fix.
    //
    // 🔴 The caret is placed explicitly before each one, and not for convenience. A
    // merge leaves the caret **at the join**, not at offset 0, so a bare run of
    // backspaces merges once and then deletes characters — exercising the debounce
    // rather than the immediate-save path this test is about. And `Home` cannot be used
    // to correct that: it does not move the caret in WebKit at all. See `placeCaret`.
    await knag.seed("aa\nbb\ncc\ndd");

    for (const row of [3, 2, 1]) {
      await knag.placeCaret(row, 0);
      await knag.page.keyboard.press("Backspace");
    }

    await expect.poll(() => knag.focusedRowIndex(), { timeout: 5_000 }).toBe(0);
    await knag.saved();
    await expect(knag.page.locator("[data-save-status]")).not.toHaveText(/reloaded/);
    expect(await knag.document()).toBe("aabbccdd");
  });
});

test.describe("continuing a list", () => {
  test("🔴 Enter on a hyphen bullet starts another one", async ({ knag }) => {
    // The bytes really do gain `- `; nothing is rendered that the file does not say.
    // That is what separates this from styling a bullet, which ADR-004 rules out.
    await knag.seed("- milk");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("eggs");

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("- milk\n- eggs");
  });

  test("keeps the marker and the indent it found", async ({ knag }) => {
    await knag.seed("  * one");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.type("two");

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("  * one\n  * two");
  });

  test("🔴 Enter on an empty bullet leaves the list", async ({ knag }) => {
    // Without this there is no way to stop making bullets except reaching for raw view
    // — the exact mode-switch ADR-003 removed. Same contract the empty checkbox has.
    await knag.seed("- milk");

    const row = knag.editor(0);
    await row.click();
    await row.press("End");
    await knag.page.keyboard.press("Enter");
    await knag.page.keyboard.press("Enter");

    await knag.saved();
    await expect.poll(() => knag.document()).toBe("- milk\n");
  });
});
